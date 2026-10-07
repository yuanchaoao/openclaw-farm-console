from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / "gateway_client.mjs"


@unittest.skipUnless(shutil.which("node"), "Node.js is required by the Gateway helper")
class GatewayClientTests(unittest.TestCase):
    def _fake_environment(self, package_root: Path) -> dict[str, str]:
        sdk_dir = package_root / "dist" / "plugin-sdk"
        sdk_dir.mkdir(parents=True)
        (package_root / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        (sdk_dir / "testing.js").write_text(
            "export async function callGateway(options) { "
            "return {method: options.method, expectFinal: options.expectFinal, "
            "messageLength: options.params?.message?.length ?? 0}; }\n",
            encoding="utf-8",
        )
        env = os.environ.copy()
        env.update(
            {
                "OPENCLAW_PACKAGE_ROOT": str(package_root),
                "OPENCLAW_GATEWAY_URL": "wss://openclaw.example/ins_demo/",
                "OPENCLAW_GATEWAY_TOKEN": "dummy-token",
            }
        )
        return env

    def test_expect_final_is_forwarded_only_for_agent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            package_root = Path(directory)
            env = self._fake_environment(package_root)
            completed = subprocess.run(
                [shutil.which("node") or "node", str(HELPER)],
                input=json.dumps(
                    {
                        "method": "agent",
                        "params": {"message": "hello", "idempotencyKey": "request-1"},
                        "timeoutMs": 1000,
                        "expectFinal": True,
                    }
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=10,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                json.loads(completed.stdout),
                {"method": "agent", "expectFinal": True, "messageLength": 5},
            )

            rejected = subprocess.run(
                [shutil.which("node") or "node", str(HELPER)],
                input=json.dumps(
                    {"method": "health", "params": {}, "timeoutMs": 1000, "expectFinal": True}
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=10,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("restricted to agent", rejected.stderr)

    def test_multimodal_sized_request_is_accepted_below_24_mib(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            package_root = Path(directory)
            env = self._fake_environment(package_root)
            message = "x" * (3 * 1024 * 1024)
            completed = subprocess.run(
                [shutil.which("node") or "node", str(HELPER)],
                input=json.dumps(
                    {"method": "agent", "params": {"message": message}, "timeoutMs": 1000}
                ),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=10,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["messageLength"], len(message))


if __name__ == "__main__":
    unittest.main()
