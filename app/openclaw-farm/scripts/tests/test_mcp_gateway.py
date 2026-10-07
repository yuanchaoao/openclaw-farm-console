import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import openclaw_mcp_server as adapter


class GatewayMcpTests(unittest.TestCase):
    def setUp(self):
        registry = {"instances": {key: {"id": key, "gateway_url": f"wss://example.test/{key}/"}
                                   for key in ["ins_a", "ins_b"]}}
        self.registry = patch.object(adapter.farm, "load_registry", return_value=registry)
        self.secret = patch.object(adapter.farm, "lookup_secret", side_effect=lambda key: "secret-for-" + key)
        self.rpc = patch.object(adapter.farm, "gateway_call", return_value=subprocess.CompletedProcess([], 0, '{"sessions":[]}', ""))
        self.registry_mock = self.registry.start()
        self.secret_mock = self.secret.start()
        self.call = self.rpc.start()
        self.addCleanup(patch.stopall)

    def test_sessions_work_without_bridge_and_use_selected_instance(self):
        for key in ["ins_a", "ins_b"]:
            self.assertEqual(json.loads(adapter.openclaw_sessions_list(key)), {"sessions": []})
            args = self.call.call_args.args
            self.assertEqual(args[0]["id"], key)
            self.assertEqual(args[1], "sessions.list")
            self.assertEqual(args[4], "secret-for-" + key)
            self.assertNotIn("file_bridge", args[0])

    def test_r2_link_from_history_is_preserved_without_gateway_secret(self):
        url = "https://files.example.test/result.pdf?X-Amz-Signature=test-signature"
        self.call.return_value.stdout = json.dumps({"messages": [{"text": url}], "accidental": "secret-for-ins_b"})
        result = adapter.openclaw_chat_history("agent:main:test", "ins_b")
        self.assertIn(url, result)
        self.assertNotIn("secret-for-ins_b", result)
        self.assertEqual(self.call.call_args.args[1], "chat.history")

    def test_send_requires_authorization_and_keeps_retry_id(self):
        args = ("prepare named file", "agent:main:test", "request-123")
        self.assertIn("requires approved=true", adapter.openclaw_chat_send(*args, instance="ins_a"))
        self.call.assert_not_called()
        adapter.openclaw_chat_send(*args, instance="ins_a", approved=True)
        params = self.call.call_args.args[2]
        self.assertEqual(params["idempotencyKey"], "request-123")
        self.assertFalse(params["deliver"])
        self.assertEqual(self.call.call_args.args[1], "chat.send")

    def test_ambiguous_instance_and_invalid_request_do_not_call_gateway(self):
        self.assertIn("没有指定实例", adapter.openclaw_sessions_list())
        self.assertIn("有效会话", adapter.openclaw_chat_history("", "ins_a"))
        self.assertIn("消息不能为空", adapter.openclaw_chat_send("", "test", "id", "ins_a", True))
        self.call.assert_not_called()

    def test_errors_do_not_expose_credentials_or_claim_download_success(self):
        self.call.return_value = subprocess.CompletedProcess([], 1, "", "rejected secret-for-ins_a")
        result = adapter.openclaw_sessions_list("ins_a")
        self.assertIn("openclaw error", result)
        self.assertNotIn("secret-for-ins_a", result)
        self.call.return_value = subprocess.CompletedProcess([], 0, "not json", "")
        self.assertIn("JSONDecodeError", adapter.openclaw_sessions_list("ins_a"))

    def test_exec_approval_requires_authorization_before_registry_or_secret_access(self):
        request_id = "681043e0-8cc4-4bc8-a839-332465d16968"
        for approval in [False, None, "true", 1]:
            self.assertIn("requires approved=true", adapter.openclaw_exec_approve(
                request_id, "ins_a", approved=approval))
        self.registry_mock.assert_not_called()
        self.secret_mock.assert_not_called()
        self.call.assert_not_called()

    def test_exec_approval_only_allows_once_on_the_explicit_instance(self):
        request_id = "681043e0-8cc4-4bc8-a839-332465d16968"
        for instance in ["ins_a", "ins_b"]:
            adapter.openclaw_exec_approve(request_id, instance, approved=True)
            args = self.call.call_args.args
            self.assertEqual(args[0]["id"], instance)
            self.assertEqual(args[1], "exec.approval.resolve")
            self.assertEqual(args[2], {"id": request_id, "decision": "allow-once"})
            self.assertEqual(args[4], "secret-for-" + instance)

    def test_exec_approval_rejects_short_ids_and_default_instances(self):
        request_id = "681043e0-8cc4-4bc8-a839-332465d16968"
        for invalid in ["681043e0", "", request_id + "\n", " " + request_id,
                        request_id.replace("-", ""), "device:" + request_id]:
            self.assertIn("完整请求 UUID", adapter.openclaw_exec_approve(invalid, "ins_a", True))
        for instance in ["", "   "]:
            self.assertIn("明确指定实例", adapter.openclaw_exec_approve(request_id, instance, True))
        self.registry_mock.assert_not_called()
        self.secret_mock.assert_not_called()
        self.call.assert_not_called()

    def test_exec_approval_errors_are_redacted_without_claiming_success(self):
        self.call.return_value = subprocess.CompletedProcess([], 1, "", "denied secret-for-ins_b")
        result = adapter.openclaw_exec_approve("681043e0-8cc4-4bc8-a839-332465d16968", "ins_b", True)
        self.assertIn("openclaw error", result)
        self.assertIn("denied", result)
        self.assertNotIn("secret-for-ins_b", result)


if __name__ == "__main__":
    unittest.main()
