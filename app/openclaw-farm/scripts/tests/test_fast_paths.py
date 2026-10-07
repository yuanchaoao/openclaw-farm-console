from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


transfer = load_module("fast_object_transfer_tests", SCRIPTS / "fast_object_transfer.py")
sender = load_module("gateway_send_file_tests", SCRIPTS / "gateway_send_file.py")


class FastObjectTransferTests(unittest.TestCase):
    def test_upload_defaults_match_measured_fast_path(self) -> None:
        parser = transfer.build_parser()
        args = parser.parse_args(
            [
                "upload",
                "--source",
                "/tmp/source",
                "--key",
                "transfers/demo/file.zip",
                "--remote-path",
                "/home/node/.openclaw/workspace/file.zip",
                "--prompt-output",
                "/tmp/prompt.txt",
            ]
        )
        self.assertEqual(args.workers, 20)
        self.assertEqual(args.part_mib, 5)
        self.assertEqual(args.remote_jobs, 20)
        self.assertEqual(args.remote_chunk_mib, 64)
        self.assertEqual(args.presign_seconds, 172800)

    @unittest.skipUnless(os.name != "nt", "Remote Linux shell syntax check requires a POSIX shell")
    def test_remote_parallel_script_is_private_and_valid_shell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            prompt = Path(directory) / "prompt.txt"
            transfer.write_remote_prompt(
                prompt,
                url="https://objects.example/file?signature=test",
                remote_path="/home/node/.openclaw/workspace/经典.zip",
                expected_sha256="a" * 64,
                expected_bytes=7_099_763_358,
                expires=172800,
            )
            self.assertTrue(transfer.storage.is_private(prompt))
            text = prompt.read_text(encoding="utf-8")
            self.assertIn("JOBS=20", text)
            self.assertIn("CHUNK_BYTES=67108864", text)
            self.assertIn("不需要安装 cloudflared", text)
            script = text.split("```sh\n", 1)[1].split("```", 1)[0]
            checked = subprocess.run(
                ["sh", "-n"], input=script, text=True, capture_output=True, check=False
            )
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_profile_validation_rejects_plain_http(self) -> None:
        with self.assertRaises(SystemExit):
            transfer.validate_profile_payload(
                {
                    "endpoint": "http://objects.example",
                    "access_key_id": "access",
                    "secret_access_key": "secret",
                    "bucket": "bucket",
                }
            )


class GatewaySendFileTests(unittest.TestCase):
    def test_pairing_request_is_reported_without_message_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            message_path = Path(directory) / "message.txt"
            message_path.write_text("PRIVATE SIGNED DOWNLOAD INSTRUCTION", encoding="utf-8")
            originals = {
                "argv": sys.argv,
                "load_registry": sender.farm.load_registry,
                "get_record": sender.farm.get_record,
                "lookup_secret": sender.farm.lookup_secret,
                "resolve_session_key": sender.resolve_session_key,
                "gateway_result": sender.gateway_result,
            }
            sender.farm.load_registry = lambda _path: {"instances": {}}
            sender.farm.get_record = lambda _registry, _instance: {"id": "ins_demo"}
            sender.farm.lookup_secret = lambda _instance: "token-value-long-enough-123456"
            sender.resolve_session_key = lambda *_args: "agent:main:main"
            sender.gateway_result = lambda *_args: (
                1,
                "scope upgrade pending approval (requestId: 11111111-2222-3333-4444-555555555555)",
            )
            sys.argv = [
                "gateway_send_file.py",
                "ins_demo",
                str(message_path),
                "--approved-write",
            ]
            output = io.StringIO()
            try:
                with contextlib.redirect_stdout(output):
                    code = sender.main()
            finally:
                sys.argv = originals["argv"]
                sender.farm.load_registry = originals["load_registry"]
                sender.farm.get_record = originals["get_record"]
                sender.farm.lookup_secret = originals["lookup_secret"]
                sender.resolve_session_key = originals["resolve_session_key"]
                sender.gateway_result = originals["gateway_result"]
            self.assertEqual(code, 4)
            payload = json.loads(output.getvalue())
            self.assertEqual(payload["status"], "scope_upgrade_required")
            self.assertEqual(payload["requested_scope"], "operator.write")
            self.assertNotIn("PRIVATE SIGNED", output.getvalue())


if __name__ == "__main__":
    unittest.main()
