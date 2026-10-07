from __future__ import annotations

import asyncio
import base64
import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import kimi_k3_mcp_server as server


INSTANCE = "ins_test_example"
MODEL_REF = "phanrouter-o/kimi-k3"
TOKEN = "sk-" + "dummycredential000"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 24)
PNG_BASE64 = base64.b64encode(PNG_BYTES).decode("ascii")


def completed(payload: object, *, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        ["node"], returncode, stdout=json.dumps(payload, ensure_ascii=False), stderr=stderr
    )


def model_list(*, multimodal: bool = False) -> dict[str, object]:
    model: dict[str, object] = {"id": "kimi-k3", "provider": "phanrouter-o"}
    if multimodal:
        model["input"] = ["text", "image"]
    return {"models": [model]}


def session_row(session_key: str, label: str) -> dict[str, object]:
    return {
        "key": session_key,
        "label": label,
        "modelProvider": "phanrouter-o",
        "model": "kimi-k3",
    }


def history(session_key: str, messages: list[dict[str, object]]) -> dict[str, object]:
    return {"sessionKey": session_key, "sessionId": "session-1", "messages": messages}


def marked_user(seq: int, marker: str) -> dict[str, object]:
    return {
        "role": "user",
        "content": [{"type": "text", "text": "private prompt"}],
        "timestamp": 1_720_000_000_000,
        "provenance": {"kind": "external_user", "sourceTool": marker},
        "__openclaw": {"id": f"message-{seq}", "seq": seq},
    }


def assistant(
    seq: int,
    *,
    text: str = "KIMI_K3_MCP_OK",
    stop_reason: str = "stop",
    provider: str = "phanrouter-o",
    model: str = "kimi-k3",
    include_usage: bool = True,
) -> dict[str, object]:
    message: dict[str, object] = {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "provider": provider,
        "model": model,
        "stopReason": stop_reason,
        "timestamp": 1_720_000_001_234,
        "__openclaw": {"id": f"message-{seq}", "seq": seq},
    }
    if include_usage:
        message["usage"] = {
            "input": 12,
            "output": 4,
            "cacheRead": 2,
            "cacheWrite": 0,
            "totalTokens": 16,
        }
    return message


def agent_final(
    *,
    text: str = "KIMI_K3_MCP_OK",
    payload_text: str = "payload fallback",
    provider: str = "phanrouter-o",
    model: str = "kimi-k3",
    include_usage: bool = True,
    stop_reason: str = "completed",
) -> dict[str, object]:
    agent_meta: dict[str, object] = {"provider": provider, "model": model}
    if include_usage:
        agent_meta["usage"] = {
            "input": 12,
            "output": 4,
            "cacheRead": 2,
            "cacheWrite": 0,
            "total": 16,
        }
    return {
        "runId": "run-1",
        "status": "ok",
        "result": {
            "payloads": [
                {"text": "private reasoning", "isReasoning": True},
                {"text": payload_text},
            ],
            "meta": {
                "finalAssistantVisibleText": text,
                "stopReason": stop_reason,
                "completedAt": 1_720_000_001_234,
                "durationMs": 1234,
                "agentMeta": agent_meta,
            },
        },
    }


class KimiK3McpTests(unittest.TestCase):
    def setUp(self) -> None:
        server.configure(INSTANCE, MODEL_REF)
        server._ACTIVE_SESSIONS.clear()
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.state_patch = mock.patch.object(
            server.farm, "adapter_state_dir", return_value=Path(self.temporary_directory.name)
        )
        self.state_patch.start()

    def tearDown(self) -> None:
        self.state_patch.stop()
        self.temporary_directory.cleanup()

    def identity(self, conversation_id: str = "default", request_id: str = "request-1") -> tuple[str, str, Path]:
        digest = server._journal_identity_digest(INSTANCE, MODEL_REF, conversation_id, request_id)
        return digest, server._journal_marker(digest), server._journal_path(digest)

    def write_journal(
        self,
        *,
        prompt: str = "test prompt",
        conversation_id: str = "default",
        request_id: str = "request-1",
        stage: str = "submit_started",
        run_id: str | None = None,
        baseline: int = 0,
        images: list[dict[str, str]] | None = None,
    ) -> tuple[dict[str, object], str, Path]:
        attachments = server._validate_images(images)
        _, marker, path = self.identity(conversation_id, request_id)
        payload: dict[str, object] = {
            "schema_version": server.JOURNAL_SCHEMA_VERSION,
            "instance": INSTANCE,
            "model_ref": MODEL_REF,
            "conversation_id": conversation_id,
            "request_id": request_id,
            "payload_fingerprint": server._idempotency_key(
                INSTANCE, MODEL_REF, conversation_id, request_id, prompt, attachments
            ),
            "baseline": baseline,
            "marker": marker,
            "stage": stage,
            "run_id": run_id,
            "session_created": False,
            "final": None,
            "created_at": 1_720_000_000,
        }
        server._write_journal(path, payload)
        return payload, marker, path

    def test_exact_single_tool_structured_schema_and_native_dict_result(self) -> None:
        tools = asyncio.run(server.mcp.list_tools())
        self.assertEqual({tool.name for tool in tools}, {"kimi_k3_chat"})
        self.assertEqual(
            set(tools[0].inputSchema.get("properties", {})),
            {"prompt", "images", "conversation_id", "request_id", "timeout_ms", "approved"},
        )
        content, structured = asyncio.run(server.mcp.call_tool("kimi_k3_chat", {"prompt": "hello"}))
        self.assertEqual(structured["error"]["code"], "approval_required")
        self.assertIn("approval_required", content[0].text)

    def test_numbered_api_name_is_server_name_and_tool_title(self) -> None:
        numbered = server.build_mcp("1号kimik3api")
        tools = asyncio.run(numbered.list_tools())
        self.assertEqual(numbered.name, "1号kimik3api")
        self.assertEqual([tool.name for tool in tools], ["kimi_k3_chat"])
        self.assertEqual(tools[0].title, "1号kimik3api")
        with self.assertRaises(server.KimiApiError):
            server.build_mcp("\n")

    def test_unapproved_and_invalid_inputs_stop_before_registry(self) -> None:
        with mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")):
            unapproved = asyncio.run(server.kimi_k3_chat("hello"))
            fake_approval = asyncio.run(server.kimi_k3_chat("hello", approved="true"))  # type: ignore[arg-type]
            empty = asyncio.run(server.kimi_k3_chat("", approved=True))
            bad_image = asyncio.run(
                server.kimi_k3_chat(
                    "inspect",
                    approved=True,
                    images=[{"data": "not-base64!", "mime_type": "image/png"}],
                )
            )
        self.assertEqual(unapproved["error"]["code"], "approval_required")
        self.assertEqual(fake_approval["error"]["code"], "approval_required")
        self.assertEqual(empty["error"]["code"], "invalid_request")
        self.assertEqual(bad_image["error"]["code"], "invalid_image")

    def test_normal_path_gets_direct_final_once_without_history(self) -> None:
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, "default")
        self.assertEqual(session_key, "agent:kimi-k3-api:mcp-kimi-k3-8e9d7c01af8c5779")
        _, marker, journal_path = self.identity()
        long_prompt = "long direct prompt " + ("x" * 12_000)
        responses = [
            completed(model_list(multimodal=True)),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(agent_final(text="KIMI_K3_MCP_OK", payload_text="must not win")),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat(
                    long_prompt,
                    conversation_id="default",
                    request_id="request-1",
                    timeout_ms=60_000,
                    approved=True,
                    images=[{"data": f"data:image/png;base64,{PNG_BASE64}", "filename": "fixture.png"}],
                )
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["text"], "KIMI_K3_MCP_OK")
        self.assertEqual(result["recovered_from"], "direct")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["created_at"], 1_720_000_001)
        self.assertEqual(result["image_count"], 1)
        self.assertEqual(result["usage"]["total"], 16)
        methods = [call.args[1] for call in gateway.call_args_list]
        self.assertEqual(
            methods,
            ["models.list", "sessions.list", "sessions.create", "sessions.list", "agent"],
        )
        self.assertEqual(methods.count("agent"), 1)
        create_params = gateway.call_args_list[2].args[2]
        self.assertEqual(create_params["agentId"], "kimi-k3-api")
        agent_call = gateway.call_args_list[4]
        agent_params = agent_call.args[2]
        self.assertEqual(
            agent_params["inputProvenance"],
            {"kind": "external_user", "sourceTool": marker},
        )
        self.assertEqual(agent_params["attachments"][0]["mimeType"], "image/png")
        self.assertTrue(agent_call.kwargs["expect_final"])
        self.assertGreater(agent_call.args[3], server.PREFLIGHT_TIMEOUT_MS)
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        self.assertEqual(journal["stage"], "final")
        self.assertEqual(journal["baseline"], 0)
        self.assertEqual(journal["run_id"], "run-1")
        self.assertTrue(server.storage.is_private(journal_path))

        with (
            mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")),
            mock.patch.object(server.farm, "gateway_call", side_effect=AssertionError("agent called")),
        ):
            cached = asyncio.run(
                server.kimi_k3_chat(
                    long_prompt,
                    "default",
                    "request-1",
                    60_000,
                    True,
                    [{"data": f"data:image/png;base64,{PNG_BASE64}", "filename": "fixture.png"}],
                )
            )
        self.assertEqual(cached["text"], result["text"])
        self.assertEqual(cached["recovered_from"], "journal")
        self.assertNotIn("history_seq", cached)

    def test_image_agent_call_pins_agent_and_model_before_gateway_attachment_gate(self) -> None:
        conversation_id = "fresh-image-session"
        request_id = "fresh-image-request"
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        responses = [
            completed(model_list(multimodal=True)),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(agent_final()),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat(
                    "inspect",
                    conversation_id=conversation_id,
                    request_id=request_id,
                    timeout_ms=60_000,
                    approved=True,
                    images=[{"data": f"data:image/png;base64,{PNG_BASE64}"}],
                )
            )

        self.assertTrue(result["ok"])
        agent_params = gateway.call_args_list[-1].args[2]
        self.assertEqual(agent_params["agentId"], "kimi-k3-api")
        self.assertEqual(agent_params["provider"], "phanrouter-o")
        self.assertEqual(agent_params["model"], "kimi-k3")

    def test_gateway_scope_distinguishes_text_and_native_image_agent_calls(self) -> None:
        self.assertEqual("operator.write", server._required_scope("agent", {"message": "text"}))
        self.assertEqual(
            "operator.admin",
            server._required_scope(
                "agent",
                {
                    "message": "image",
                    "attachments": [{}],
                    "agentId": "kimi-k3-api",
                    "provider": "phanrouter-o",
                    "model": "kimi-k3",
                },
            ),
        )

    def test_expect_final_accepted_falls_back_to_correlated_history(self) -> None:
        conversation_id = "accepted-direct"
        request_id = "accepted-request"
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        _, marker, _ = self.identity(conversation_id, request_id)
        responses = [
            completed(model_list()),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed({"runId": "run-accepted", "status": "accepted"}),
            completed(history(session_key, [marked_user(1, marker), assistant(2)])),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat(
                    "test prompt", conversation_id, request_id, 20_000, True
                )
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["run_id"], "run-accepted")
        self.assertEqual(result["recovered_from"], "history")
        methods = [call.args[1] for call in gateway.call_args_list]
        self.assertEqual(methods.count("agent"), 1)
        self.assertEqual(methods[-1], "chat.history")
        history_params = gateway.call_args_list[-1].args[2]
        self.assertEqual(history_params["maxChars"], 8_000)
        agent_call = next(call for call in gateway.call_args_list if call.args[1] == "agent")
        self.assertTrue(agent_call.kwargs["expect_final"])

    def test_restart_from_accepted_recovers_history_without_agent(self) -> None:
        _, marker, _ = self.write_journal(stage="accepted", run_id="run-accepted")
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, "default")
        responses = [
            completed(model_list()),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(history(session_key, [marked_user(1, marker), assistant(2)])),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat("test prompt", "default", "request-1", 20_000, True)
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["run_id"], "run-accepted")
        self.assertEqual(result["recovered_from"], "history")
        self.assertNotIn("agent", [call.args[1] for call in gateway.call_args_list])

    def test_submit_failure_then_retry_never_calls_agent_twice(self) -> None:
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, "default")
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        first_responses = [
            completed(model_list()),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed({}, returncode=1, stderr="transport close after uncertain submit"),
        ]
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=first_responses) as first_gateway,
            mock.patch.object(server, "_poll_history_final", return_value=None),
        ):
            pending = asyncio.run(
                server.kimi_k3_chat("test prompt", "default", "request-1", 20_000, True)
            )
        self.assertEqual(pending["error"]["code"], "recovery_pending")
        self.assertEqual([call.args[1] for call in first_gateway.call_args_list].count("agent"), 1)

        _, marker, path = self.identity()
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["stage"], "recovering")
        retry_responses = [
            completed(model_list()),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(history(session_key, [marked_user(1, marker), assistant(2)])),
        ]
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=retry_responses) as retry_gateway,
        ):
            recovered = asyncio.run(
                server.kimi_k3_chat("test prompt", "default", "request-1", 20_000, True)
            )
        self.assertTrue(recovered["ok"])
        self.assertEqual(recovered["recovered_from"], "history")
        self.assertNotIn("agent", [call.args[1] for call in retry_gateway.call_args_list])

    def test_same_request_id_different_payload_is_conflict_before_registry(self) -> None:
        self.write_journal(prompt="first", stage="submit_started")
        with mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")):
            result = asyncio.run(
                server.kimi_k3_chat("different", "default", "request-1", approved=True)
            )
        self.assertEqual(result["error"]["code"], "idempotency_conflict")

    def test_history_fail_closed_for_missing_marker_oversize_and_truncation(self) -> None:
        common = dict(
            baseline=0,
            marker="marker",
            provider="phanrouter-o",
            model_id="kimi-k3",
            conversation_id="default",
            request_id="request-1",
            run_id="run-1",
            session_created=False,
            image_count=0,
            recovered_from="history",
        )
        self.assertIsNone(server._find_history_final([assistant(1)], **common))
        oversized = {
            "role": "assistant",
            "content": [{"type": "text", "text": server.HISTORY_OVERSIZED_TEXT}],
            "__openclaw": {"truncated": True, "reason": "oversized"},
        }
        self.assertIsNone(server._find_history_final([oversized], **common))
        with self.assertRaises(server.KimiApiError) as raised:
            server._find_history_final([marked_user(1, "marker"), oversized], **common)
        self.assertEqual(raised.exception.code, "history_oversized")
        old_truncated = assistant(1, text="old" + server.HISTORY_TRUNCATED_SUFFIX)
        result = server._find_history_final(
            [old_truncated, marked_user(2, "marker"), assistant(3)], **common
        )
        self.assertTrue(result["ok"])
        with self.assertRaises(server.KimiApiError) as raised:
            server._find_history_final(
                [marked_user(1, "marker"), assistant(2, text="partial" + server.HISTORY_TRUNCATED_SUFFIX)],
                **common,
            )
        self.assertEqual(raised.exception.code, "history_truncated")

    def test_history_validates_model_usage_and_uses_last_assistant(self) -> None:
        common = dict(
            baseline=0,
            marker="marker",
            provider="phanrouter-o",
            model_id="kimi-k3",
            conversation_id="default",
            request_id="request-1",
            run_id=None,
            session_created=False,
            image_count=0,
            recovered_from="history",
        )
        result = server._find_history_final(
            [marked_user(1, "marker"), assistant(2, stop_reason="error"), assistant(3, text="final")],
            **common,
        )
        self.assertEqual(result["text"], "final")
        with self.assertRaises(server.KimiApiError) as raised:
            server._find_history_final(
                [marked_user(1, "marker"), assistant(2, provider="other")], **common
            )
        self.assertEqual(raised.exception.code, "model_mismatch")
        with self.assertRaises(server.KimiApiError) as raised:
            server._find_history_final(
                [marked_user(1, "marker"), assistant(2, include_usage=False)], **common
            )
        self.assertEqual(raised.exception.code, "protocol_error")

    def test_image_validation_catalog_gate_and_idempotency_digest(self) -> None:
        valid = server._validate_images([{"data": PNG_BASE64}])
        self.assertEqual(valid[0]["mimeType"], "image/png")
        mismatch = asyncio.run(
            server.kimi_k3_chat(
                "inspect", approved=True, images=[{"data": f"data:image/jpeg;base64,{PNG_BASE64}"}]
            )
        )
        too_many = asyncio.run(
            server.kimi_k3_chat(
                "inspect", approved=True, images=[{"data": PNG_BASE64}] * (server.MAX_IMAGES + 1)
            )
        )
        self.assertEqual(mismatch["error"]["code"], "image_type_mismatch")
        self.assertEqual(too_many["error"]["code"], "too_many_images")
        self.assertNotEqual(
            server._idempotency_key(INSTANCE, MODEL_REF, "c", "r", "p"),
            server._idempotency_key(INSTANCE, MODEL_REF, "c", "r", "p", valid),
        )

        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(
                server.farm,
                "gateway_call",
                return_value=completed(
                    {
                        "models": [
                            {"id": "kimi-k3", "provider": "phanrouter-o", "input": ["image"]}
                        ]
                    }
                ),
            ) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat(
                    "inspect", request_id="image-model-gate", approved=True, images=[{"data": PNG_BASE64}]
                )
            )
        self.assertEqual(result["error"]["code"], "model_not_multimodal")
        self.assertEqual(gateway.call_count, 1)

    def test_existing_wrong_session_model_stops_before_agent(self) -> None:
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, "default")
        responses = [
            completed(model_list()),
            completed(
                {
                    "sessions": [
                        {"key": session_key, "label": label, "modelProvider": "other", "model": "fallback"}
                    ]
                }
            ),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(server.kimi_k3_chat("hello", "default", "wrong-session", approved=True))
        self.assertEqual(result["error"]["code"], "model_mismatch")
        self.assertEqual(gateway.call_count, 2)

    def test_cross_process_file_lock_rejects_second_claim(self) -> None:
        session_key = "agent:kimi-k3-api:mcp-kimi-k3-lock-test"
        descriptor = server._claim_session(session_key)
        server._ACTIVE_SESSIONS.clear()
        try:
            with self.assertRaises(server.KimiApiError) as raised:
                server._claim_session(session_key)
            self.assertEqual(raised.exception.code, "conversation_busy")
        finally:
            server._release_session(session_key, descriptor)

    def test_agent_handler_rejections_roll_back_to_prepared_and_scope_can_retry(self) -> None:
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        cases = [
            ("scope", "scope upgrade required", "scope_upgrade_required"),
            ("pairing", "pairing required", "pairing_required"),
            ("auth", "unauthorized authentication", "gateway_auth_error"),
        ]
        for index, (name, detail, expected_code) in enumerate(cases, start=1):
            with self.subTest(name=name):
                conversation_id = f"handler-{name}"
                request_id = f"handler-request-{name}"
                session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
                gateway_request = f"12345678-1234-4234-9234-{index:012d}"
                responses = [
                    completed(model_list()),
                    completed({"sessions": []}),
                    completed({"ok": True, "key": session_key, "entry": {"label": label}}),
                    completed({"sessions": [session_row(session_key, label)]}),
                    completed({}, returncode=1, stderr=f"{detail} {gateway_request}"),
                ]
                with (
                    mock.patch.object(server.farm, "load_registry", return_value=registry),
                    mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
                    mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
                ):
                    result = asyncio.run(
                        server.kimi_k3_chat(
                            "test prompt", conversation_id, request_id, 20_000, True
                        )
                    )
                self.assertEqual(result["error"]["code"], expected_code)
                self.assertIn(gateway_request, json.dumps(result, ensure_ascii=False))
                methods = [call.args[1] for call in gateway.call_args_list]
                self.assertEqual(methods.count("agent"), 1)
                self.assertTrue(gateway.call_args_list[-1].kwargs["expect_final"])
                _, _, journal_path = self.identity(conversation_id, request_id)
                self.assertEqual(json.loads(journal_path.read_text(encoding="utf-8"))["stage"], "prepared")
                active_path = server._active_pointer_path(INSTANCE, MODEL_REF, conversation_id)
                self.assertFalse(active_path.exists())

        conversation_id = "handler-scope"
        request_id = "handler-request-scope"
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        retry_responses = [
            completed(model_list()),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(agent_final()),
        ]
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=retry_responses) as gateway,
        ):
            retried = asyncio.run(
                server.kimi_k3_chat("test prompt", conversation_id, request_id, 20_000, True)
            )
        self.assertTrue(retried["ok"])
        self.assertEqual([call.args[1] for call in gateway.call_args_list].count("agent"), 1)

    def test_direct_output_limit_is_terminal_and_cached_without_resubmit(self) -> None:
        conversation_id = "output-limit"
        request_id = "output-limit-request"
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        responses = [
            completed(model_list()),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(agent_final(text="too long")),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server, "MAX_OUTPUT_CHARS", 4),
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat("test prompt", conversation_id, request_id, 20_000, True)
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "output_limit_exceeded")
        self.assertEqual([call.args[1] for call in gateway.call_args_list].count("agent"), 1)
        _, _, journal_path = self.identity(conversation_id, request_id)
        self.assertEqual(json.loads(journal_path.read_text(encoding="utf-8"))["stage"], "failed")

        with (
            mock.patch.object(server, "MAX_OUTPUT_CHARS", 4),
            mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")),
            mock.patch.object(server.farm, "gateway_call", side_effect=AssertionError("agent called")),
        ):
            cached = asyncio.run(
                server.kimi_k3_chat("test prompt", conversation_id, request_id, 20_000, True)
            )
        self.assertEqual(cached["error"]["code"], "output_limit_exceeded")
        self.assertEqual(cached["recovered_from"], "journal")

    def test_direct_parser_fallback_validates_model_and_usage(self) -> None:
        payload = agent_final(text="preferred", payload_text="visible fallback")
        del payload["result"]["meta"]["finalAssistantVisibleText"]  # type: ignore[index]
        parsed = server._extract_agent_final(
            payload,
            provider="phanrouter-o",
            model_id="kimi-k3",
            conversation_id="direct-parser",
            request_id="direct-parser-request",
            session_created=False,
            image_count=0,
        )
        self.assertEqual(parsed["text"], "visible fallback")
        self.assertNotIn("private reasoning", parsed["text"])

        with self.assertRaises(server.KimiApiError) as raised:
            server._extract_agent_final(
                agent_final(provider="other"),
                provider="phanrouter-o",
                model_id="kimi-k3",
                conversation_id="direct-parser",
                request_id="wrong-model",
                session_created=False,
                image_count=0,
            )
        self.assertEqual(raised.exception.code, "model_mismatch")
        with self.assertRaises(server.KimiApiError) as raised:
            server._extract_agent_final(
                agent_final(include_usage=False),
                provider="phanrouter-o",
                model_id="kimi-k3",
                conversation_id="direct-parser",
                request_id="missing-usage",
                session_created=False,
                image_count=0,
            )
        self.assertEqual(raised.exception.code, "protocol_error")

    def test_history_terminal_error_is_persisted_and_not_resubmitted(self) -> None:
        conversation_id = "terminal-error"
        request_id = "terminal-error-request"
        _, marker, journal_path = self.write_journal(
            conversation_id=conversation_id,
            request_id=request_id,
            stage="accepted",
            run_id="run-error",
        )
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        responses = [
            completed(model_list()),
            completed({"sessions": [session_row(session_key, label)]}),
            completed(
                history(
                    session_key,
                    [marked_user(1, marker), assistant(2, stop_reason="aborted")],
                )
            ),
        ]
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
        ):
            result = asyncio.run(
                server.kimi_k3_chat("test prompt", conversation_id, request_id, 20_000, True)
            )
        self.assertEqual(result["error"]["code"], "model_error")
        self.assertEqual(result["finish_reason"], "aborted")
        self.assertNotIn("agent", [call.args[1] for call in gateway.call_args_list])
        self.assertEqual(json.loads(journal_path.read_text(encoding="utf-8"))["stage"], "failed")

        with mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")):
            cached = asyncio.run(
                server.kimi_k3_chat("test prompt", conversation_id, request_id, 20_000, True)
            )
        self.assertEqual(cached["error"]["code"], "model_error")
        self.assertEqual(cached["recovered_from"], "journal")

    def test_pending_request_blocks_different_request_in_same_conversation(self) -> None:
        conversation_id = "shared-pending"
        session_key, label = server._session_identity(INSTANCE, MODEL_REF, conversation_id)
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        responses = [
            completed(model_list()),
            completed({"sessions": []}),
            completed({"ok": True, "key": session_key, "entry": {"label": label}}),
            completed({"sessions": [session_row(session_key, label)]}),
            completed({}, returncode=1, stderr="transport closed after uncertain submit"),
        ]
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", side_effect=responses) as gateway,
            mock.patch.object(server, "_poll_history_final", return_value=None),
        ):
            pending = asyncio.run(
                server.kimi_k3_chat(
                    "request A", conversation_id, "request-a", 20_000, True
                )
            )
        self.assertEqual(pending["error"]["code"], "recovery_pending")
        self.assertEqual([call.args[1] for call in gateway.call_args_list].count("agent"), 1)

        with (
            mock.patch.object(server.farm, "load_registry", side_effect=AssertionError("registry read")),
            mock.patch.object(server.farm, "gateway_call", side_effect=AssertionError("agent called")),
        ):
            blocked = asyncio.run(
                server.kimi_k3_chat(
                    "request B", conversation_id, "request-b", 20_000, True
                )
            )
        self.assertEqual(blocked["error"]["code"], "conversation_recovery_pending")

    def test_scope_upgrade_keeps_full_id_and_redacts_details(self) -> None:
        scope_request = "12345678-1234-4234-9234-1234567890ab"
        registry = {"instances": {INSTANCE: {"id": INSTANCE, "gateway_url": "wss://example/"}}}
        failure = completed(
            {}, returncode=1, stderr=f"scope upgrade required {scope_request} token={TOKEN} /private/path"
        )
        with (
            mock.patch.object(server.farm, "load_registry", return_value=registry),
            mock.patch.object(server.farm, "lookup_secret", return_value=TOKEN),
            mock.patch.object(server.farm, "gateway_call", return_value=failure),
        ):
            result = asyncio.run(
                server.kimi_k3_chat("private prompt", "default", "scope-test", approved=True)
            )
        rendered = json.dumps(result, ensure_ascii=False)
        self.assertEqual(result["error"]["code"], "scope_upgrade_required")
        self.assertIn(scope_request, rendered)
        self.assertNotIn(TOKEN, rendered)
        self.assertNotIn("private/path", rendered)

    def test_total_deadline_bounds_outer_timeout(self) -> None:
        with (
            mock.patch.object(server.time, "monotonic", return_value=100.0),
            mock.patch.object(server.farm, "gateway_call", return_value=completed({"ok": True})) as gateway,
        ):
            payload = server._gateway_json(
                {"gateway_url": "wss://example/"}, TOKEN, "health", {}, 101.0, timeout_cap_ms=30_000
            )
        self.assertEqual(payload, {"ok": True})
        self.assertEqual(gateway.call_args.args[3], 1000)
        self.assertEqual(gateway.call_args.kwargs["outer_timeout_ms"], 1000)


if __name__ == "__main__":
    unittest.main()
