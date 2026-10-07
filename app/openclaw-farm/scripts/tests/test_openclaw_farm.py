from __future__ import annotations

import importlib.util
import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "openclaw_farm.py"
SPEC = importlib.util.spec_from_file_location("openclaw_farm", MODULE_PATH)
assert SPEC and SPEC.loader
farm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(farm)


class AdapterTests(unittest.TestCase):
    def test_pairing_responses_uses_main_agent_without_a_model_override(self) -> None:
        request_id = "12345678-1234-1234-1234-123456789abc"
        device_id = "a" * 64
        record = {"id": "ins_demo", "web_url": "https://gateway.example/ins_demo/chat"}
        response = mock.MagicMock(status=200)
        response.read.return_value = b"{}"
        with (
            mock.patch.object(farm, "load_registry", return_value={"instances": {"ins_demo": record}}),
            mock.patch.object(farm, "lookup_secret", return_value="dummy-pairing-token"),
            mock.patch.object(farm.HTTP_OPENER, "open") as opened,
            mock.patch("builtins.print"),
        ):
            opened.return_value.__enter__.return_value = response
            result = farm.command_pairing_approve_via_responses(farm.argparse.Namespace(
                registry="unused-fixture.json", instance_id="ins_demo", request_id=request_id,
                device_id=device_id, timeout=10,
            ))
        self.assertEqual(result, 0)
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "https://gateway.example/ins_demo/v1/responses")
        self.assertEqual(request.get_method(), "POST")
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertNotIn("x-openclaw-model", headers)
        self.assertEqual(headers["x-openclaw-session-key"], "agent:main:openclaw-farm-pairing:" + request_id)
        body = json.loads(request.data)
        self.assertEqual(body["model"], "openclaw:main")
        self.assertIn(request_id, body["input"])
        self.assertIn(device_id, body["input"])

    def test_agent_wait_is_a_read_only_gateway_method(self) -> None:
        self.assertIn("agent.wait", farm.READ_ONLY_METHODS)

    def test_normalize_url_discards_query_and_fragment(self) -> None:
        gateway, web, host = farm.normalize_urls(
            "https://openclaw.example/ins_demo/chat?view=1#token=REDACTED", "ins_demo"
        )
        self.assertEqual(gateway, "wss://openclaw.example/ins_demo/")
        self.assertEqual(web, "https://openclaw.example/ins_demo/chat")
        self.assertEqual(host, "openclaw.example")

    def test_normalize_url_rejects_mismatched_instance(self) -> None:
        with self.assertRaises(farm.FarmError):
            farm.normalize_urls("https://openclaw.example/ins_other/chat", "ins_demo")

    def test_sensitive_rpc_params_are_rejected(self) -> None:
        self.assertTrue(farm.contains_sensitive_params({"authToken": "REDACTED"}))
        self.assertTrue(farm.contains_sensitive_params({"value": "sk-" + "examplecredential000"}))
        self.assertFalse(farm.contains_sensitive_params({"agentId": "main", "limit": 5}))

    def test_bridge_url_requires_loopback_for_plain_http(self) -> None:
        self.assertEqual(farm.normalize_bridge_url("http://127.0.0.1:20080/"), "http://127.0.0.1:20080")
        self.assertEqual(farm.normalize_bridge_url("https://bridge.example/v1"), "https://bridge.example/v1")
        with self.assertRaises(farm.FarmError):
            farm.normalize_bridge_url("http://bridge.example:18081")

    def test_registry_write_is_private_and_backed_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ".openclaw" / "instances.json"
            payload = {"schema_version": 2, "instances": {}}
            backup = farm.write_registry(target, payload)
            self.assertTrue(backup.name.startswith("instances.json.absent."))
            self.assertTrue(farm.storage.is_private(target))
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), payload)

    def test_safe_record_never_contains_credential_refs(self) -> None:
        record = {
            "id": "ins_demo",
            "credential_ref": {"backend": "secret"},
            "file_bridge": {
                "transport": "direct_http",
                "base_url": "http://127.0.0.1:20080",
                "credential_refs": {"all": {"secret": "hidden"}},
            },
        }
        safe = farm.safe_record(record, True)
        self.assertNotIn("credential_ref", safe)
        self.assertNotIn("credential_refs", safe["file_bridge"])

    def test_gateway_call_forwards_expect_final_without_exposing_token(self) -> None:
        completed = subprocess.CompletedProcess(["node"], 0, stdout="{}", stderr="")
        with (
            mock.patch.object(farm.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(farm, "openclaw_package_root", return_value=Path("/opt/openclaw")),
            mock.patch.object(farm, "adapter_state_dir", return_value=Path("/tmp/openclaw-state")),
            mock.patch.object(farm.subprocess, "run", return_value=completed) as run,
        ):
            result = farm.gateway_call(
                {"gateway_url": "wss://openclaw.example/ins_demo/"},
                "agent",
                {"message": "hello", "idempotencyKey": "request-1"},
                10_000,
                "sk-" + "dummycredential000",
                expect_final=True,
            )

        self.assertIs(result, completed)
        args, kwargs = run.call_args
        request = json.loads(kwargs["input"])
        self.assertEqual(request["expectFinal"], True)
        self.assertEqual(kwargs["timeout"], 25)
        self.assertNotIn("dummycredential", " ".join(args[0]))
        self.assertNotIn("dummycredential", kwargs["input"])
        self.assertEqual(kwargs["env"]["OPENCLAW_GATEWAY_TOKEN"], "sk-" + "dummycredential000")

    def test_gateway_call_restricts_expect_final_to_agent(self) -> None:
        with self.assertRaises(farm.FarmError):
            farm.gateway_call(
                {"gateway_url": "wss://openclaw.example/ins_demo/"},
                "health",
                {},
                10_000,
                "dummy-token",
                expect_final=True,
            )

    def test_gateway_call_maps_outer_timeout(self) -> None:
        with (
            mock.patch.object(farm.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(farm, "openclaw_package_root", return_value=Path("/opt/openclaw")),
            mock.patch.object(farm, "adapter_state_dir", return_value=Path("/tmp/openclaw-state")),
            mock.patch.object(
                farm.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["node"], 25),
            ),
            self.assertRaises(farm.GatewayTimeoutError),
        ):
            farm.gateway_call(
                {"gateway_url": "wss://openclaw.example/ins_demo/"},
                "health",
                {},
                10_000,
                "dummy-token",
            )

    def test_gateway_call_honors_explicit_outer_wall_timeout(self) -> None:
        completed = subprocess.CompletedProcess(["node"], 0, stdout="{}", stderr="")
        with (
            mock.patch.object(farm.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(farm, "openclaw_package_root", return_value=Path("/opt/openclaw")),
            mock.patch.object(farm, "adapter_state_dir", return_value=Path("/tmp/openclaw-state")),
            mock.patch.object(farm.subprocess, "run", return_value=completed) as run,
        ):
            farm.gateway_call(
                {"gateway_url": "wss://openclaw.example/ins_demo/"},
                "health",
                {},
                10_000,
                "dummy-token",
                outer_timeout_ms=1_250,
            )
        self.assertEqual(run.call_args.kwargs["timeout"], 1.25)

        with self.assertRaises(farm.FarmError):
            farm.gateway_call(
                {"gateway_url": "wss://openclaw.example/ins_demo/"},
                "health",
                {},
                10_000,
                "dummy-token",
                outer_timeout_ms=0,
            )


if __name__ == "__main__":
    unittest.main()
