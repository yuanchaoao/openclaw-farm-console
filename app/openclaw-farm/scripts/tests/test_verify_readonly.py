from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("farm_verify_readonly_tests", SCRIPTS / "openclaw_farm.py")
assert SPEC and SPEC.loader
farm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(farm)


class VerifyReadOnlyTests(unittest.TestCase):
    def run_verify(self, directory: str, completed: subprocess.CompletedProcess, no_save: bool):
        path = Path(directory) / "instances.json"
        original = {
            "schema_version": 2,
            "instances": {
                "ins_demo": {
                    "id": "ins_demo",
                    "status": "registered_unverified",
                    "gateway_url": "wss://example.test/ins_demo/",
                    "credential_ref": {"backend": "macos-keychain"},
                },
                "ins_other": {"id": "ins_other", "status": "active"},
            },
        }
        path.write_text(json.dumps(original), encoding="utf-8")
        before = path.read_bytes(), path.stat().st_mtime_ns
        args = farm.build_parser().parse_args([
            "--registry", str(path), "verify", "ins_demo", "--timeout", "1234",
            *(["--no-save"] if no_save else []),
        ])
        output = io.StringIO()
        with (
            mock.patch.object(farm, "lookup_secret", return_value="test-token-private") as lookup,
            mock.patch.object(farm, "gateway_call", return_value=completed) as gateway,
            mock.patch.object(farm, "write_registry", wraps=farm.write_registry) as write,
            contextlib.redirect_stdout(output),
        ):
            code = args.handler(args)
        lookup.assert_called_once_with("ins_demo")
        self.assertEqual(gateway.call_args.args[1:4], ("health", {}, 1234))
        self.assertNotIn("test-token-private", output.getvalue())
        result = json.loads(output.getvalue())
        self.assertNotIn("credential_ref", result["instance"])
        return path, original, before, write, code, result

    def test_no_save_never_writes_or_creates_backups_for_any_health_outcome(self) -> None:
        cases = [
            (subprocess.CompletedProcess([], 0, stdout="{}", stderr=""), "active"),
            (subprocess.CompletedProcess([], 1, stdout="", stderr="token mismatch test-token-private"), "registered_unverified"),
            (subprocess.CompletedProcess([], 4, stdout="", stderr='pairing required\n{"code":"PAIRING_REQUIRED","requestId":"11111111-2222-3333-4444-555555555555"}'), "pairing_required"),
        ]
        for completed, expected_status in cases:
            with self.subTest(status=expected_status), tempfile.TemporaryDirectory(prefix="verify space ") as directory:
                path, _, before, write, code, result = self.run_verify(directory, completed, True)
                write.assert_not_called()
                self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
                self.assertEqual(list(Path(directory).iterdir()), [path])
                self.assertEqual(code, completed.returncode)
                self.assertEqual(result["health_verified"], code == 0)
                self.assertEqual(result["instance"]["status"], expected_status)
                self.assertEqual(result["backup"], "")
                if code == 4:
                    self.assertEqual(result["error_code"], "PAIRING_REQUIRED")
                    self.assertEqual(result["requestId"], "11111111-2222-3333-4444-555555555555")

    def test_verify_still_updates_status_and_creates_backup_by_default(self) -> None:
        with tempfile.TemporaryDirectory(prefix="verify space ") as directory:
            completed = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
            path, original, _, write, code, result = self.run_verify(directory, completed, False)
            write.assert_called_once()
            self.assertEqual(code, 0)
            persisted = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["instances"]["ins_demo"]["status"], "active")
            self.assertEqual(persisted["instances"]["ins_demo"]["control_adapter"], "openclaw-sdk-least-privilege")
            self.assertEqual(persisted["instances"]["ins_other"], original["instances"]["ins_other"])
            self.assertEqual(json.loads(Path(result["backup"]).read_text(encoding="utf-8")), original)


if __name__ == "__main__":
    unittest.main()
