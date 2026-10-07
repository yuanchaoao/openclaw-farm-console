from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import threading
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


server_module = load_module("file_bridge_server", SCRIPTS / "file_bridge_server.py")
farm = load_module("openclaw_farm_bridge_tests", SCRIPTS / "openclaw_farm.py")


TOKEN = "bridge-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class RunningBridge:
    def __init__(self, base: Path, *, write: bool = True, delete: bool = True) -> None:
        self.root = base / "workspace"
        self.root.mkdir(parents=True)
        self.state = base / "state"
        self.secret = base / "bridge-secrets.json"
        self.secret.write_text(
            json.dumps({"tokens": [{"token": TOKEN, "scopes": ["read", "write", "delete"]}]}),
            encoding="utf-8",
        )
        self.secret.chmod(0o600)
        args = argparse.Namespace(
            host="127.0.0.1",
            port=0,
            root=str(self.root),
            state_dir=str(self.state),
            secret_file=str(self.secret),
            audit_log=None,
            enable_write=write,
            enable_delete=delete,
            allow_root_for_test=True,
            allow_unisolated_for_test=True,
            max_json_bytes=1024 * 1024,
            max_chunk_bytes=16 * 1024 * 1024,
            max_read_bytes=1024 * 1024,
            max_download_bytes=64 * 1024 * 1024,
            max_file_bytes=64 * 1024 * 1024,
            max_entries=100,
            max_workers=4,
            socket_timeout=10.0,
        )
        settings = server_module.build_settings(args)
        self.server = server_module.BridgeHTTPServer(("127.0.0.1", 0), server_module.Handler, settings)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.record = {
            "id": "ins_test",
            "file_bridge": {
                "status": "active",
                "transport": "direct_http",
                "base_url": f"http://127.0.0.1:{self.port}",
            },
        }

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@unittest.skipIf(os.name == "nt", "Remote file bridge runs on Linux; desktop Windows uses the client adapter")
class FileBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.bridge = RunningBridge(self.base)
        self.original_lookup = farm.lookup_bridge_secret
        self.original_state_dir = farm.adapter_state_dir
        farm.lookup_bridge_secret = lambda _instance, _scope: TOKEN
        farm.adapter_state_dir = lambda: self.base / "client-state"

    def tearDown(self) -> None:
        farm.lookup_bridge_secret = self.original_lookup
        farm.adapter_state_dir = self.original_state_dir
        self.bridge.close()
        self.temporary.cleanup()

    def test_health_and_wrong_auth(self) -> None:
        health = farm.bridge_health("ins_test", self.bridge.record)
        self.assertEqual(health["version"], "2.0")
        self.assertTrue(health["capabilities"]["resumable_upload"])

        request = urllib.request.Request(
            f"http://127.0.0.1:{self.bridge.port}/v1/health",
            headers={"X-OpenClaw-Token": "wrong-token-value-that-is-long-enough"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 401)
        payload = json.loads(caught.exception.read().decode("utf-8"))
        self.assertEqual(payload["error"]["code"], "unauthorized")
        self.assertNotIn(str(self.bridge.root), json.dumps(payload))

        invalid_limit = urllib.request.Request(
            f"http://127.0.0.1:{self.bridge.port}/v1/read?path=missing&max_bytes=bad",
            headers={"X-OpenClaw-Token": TOKEN},
        )
        with self.assertRaises(urllib.error.HTTPError) as invalid_caught:
            urllib.request.urlopen(invalid_limit, timeout=5)
        self.assertEqual(invalid_caught.exception.code, 400)
        invalid_payload = json.loads(invalid_caught.exception.read().decode("utf-8"))
        self.assertEqual(invalid_payload["error"]["code"], "invalid_limit")

    def test_lost_local_forward_is_recreated_for_read_only_request(self) -> None:
        record = {
            "file_bridge": {
                "transport": "ssh_relay",
                "base_url": f"http://127.0.0.1:{self.bridge.port}",
                "local_port": self.bridge.port,
            }
        }
        with mock.patch.object(farm, "ensure_local_bridge_forward") as ensure, \
             mock.patch.object(farm, "port_open", return_value=False), \
             mock.patch.object(
                 farm.HTTP_OPENER,
                 "open",
                 side_effect=[urllib.error.URLError("forward exited"), mock.sentinel.response],
             ) as opened:
            response = farm.bridge_open("ins_test", record, "read", "GET", "/v1/capabilities")

        self.assertIs(response, mock.sentinel.response)
        self.assertEqual(ensure.call_count, 2)
        self.assertEqual(opened.call_count, 2)

    def test_lost_local_forward_does_not_replay_mutation(self) -> None:
        record = {
            "file_bridge": {
                "transport": "ssh_relay",
                "base_url": f"http://127.0.0.1:{self.bridge.port}",
                "local_port": self.bridge.port,
            }
        }
        with mock.patch.object(farm, "ensure_local_bridge_forward") as ensure, \
             mock.patch.object(farm, "port_open") as port_check, \
             mock.patch.object(farm.HTTP_OPENER, "open", side_effect=urllib.error.URLError("forward exited")) as opened:
            with self.assertRaisesRegex(farm.FarmError, "文件桥连接失败"):
                farm.bridge_open("ins_test", record, "write", "POST", "/v1/write", data=b"payload")

        ensure.assert_called_once()
        port_check.assert_not_called()
        opened.assert_called_once()

    def test_atomic_write_precondition_and_backup(self) -> None:
        first = farm.bridge_write("ins_test", self.bridge.record, "note.txt", "first")
        self.assertEqual(first["size"], 5)
        current = farm.bridge_stat("ins_test", self.bridge.record, "note.txt")["stat"]
        self.assertEqual(farm.bridge_read("ins_test", self.bridge.record, "note.txt"), "first")

        with self.assertRaises(farm.FarmError):
            farm.bridge_write("ins_test", self.bridge.record, "note.txt", "second")

        second = farm.bridge_write(
            "ins_test", self.bridge.record, "note.txt", "second", current["sha256"]
        )
        self.assertEqual(farm.bridge_read("ins_test", self.bridge.record, "note.txt"), "second")
        self.assertTrue(second["backup"])

    def test_resumable_upload_download_and_mutations(self) -> None:
        local = self.base / "payload.bin"
        local.write_bytes(os.urandom(2 * 1024 * 1024 + 37))
        farm.bridge_mutation(
            "ins_test", self.bridge.record, "/v1/mkdir", {"path": "incoming", "parents": True}
        )
        uploaded = farm.bridge_upload(
            "ins_test",
            self.bridge.record,
            str(local),
            "incoming/payload.bin",
            chunk_size=256 * 1024,
        )
        self.assertEqual(uploaded["uploaded"], local.stat().st_size)
        self.assertEqual(uploaded["sha256"], farm.file_sha256(local))

        destination = self.base / "downloaded.bin"
        downloaded = farm.bridge_download(
            "ins_test", self.bridge.record, "incoming/payload.bin", str(destination)
        )
        self.assertEqual(downloaded["sha256"], farm.file_sha256(destination))
        self.assertEqual(local.read_bytes(), destination.read_bytes())

        farm.bridge_mutation(
            "ins_test",
            self.bridge.record,
            "/v1/copy",
            {"src": "incoming/payload.bin", "dst": "incoming/copy.bin"},
        )
        farm.bridge_mutation(
            "ins_test",
            self.bridge.record,
            "/v1/move",
            {"src": "incoming/copy.bin", "dst": "incoming/moved.bin"},
        )
        moved = farm.bridge_stat("ins_test", self.bridge.record, "incoming/moved.bin")["stat"]
        deleted = farm.bridge_mutation(
            "ins_test",
            self.bridge.record,
            "/v1/delete",
            {
                "path": "incoming/moved.bin",
                "confirm": "incoming/moved.bin",
                "expected_sha256": moved["sha256"],
            },
            delete=True,
        )
        self.assertTrue(deleted["backup"])

    def test_traversal_symlink_and_read_only_are_rejected(self) -> None:
        with self.assertRaises(farm.FarmError):
            farm.bridge_list("ins_test", self.bridge.record, "../")
        outside = self.base / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        (self.bridge.root / "escape.txt").symlink_to(outside)
        with self.assertRaises(farm.FarmError):
            farm.bridge_stat("ins_test", self.bridge.record, "escape.txt")

        self.bridge.close()
        self.bridge = RunningBridge(self.base / "readonly", write=False, delete=False)
        with self.assertRaises(farm.FarmError):
            farm.bridge_write("ins_test", self.bridge.record, "blocked.txt", "no")

    def test_secret_permissions_are_enforced(self) -> None:
        bad = self.base / "bad-secret.json"
        bad.write_text(json.dumps({"tokens": [{"token": TOKEN, "scopes": ["read"]}]}), encoding="utf-8")
        bad.chmod(0o644)
        with self.assertRaises(SystemExit):
            server_module.validate_secret_file(bad)

        weak = self.base / "weak-secret.json"
        weak.write_text(
            json.dumps({"tokens": [{"token": "a" * 32, "scopes": ["read"]}]}),
            encoding="utf-8",
        )
        weak.chmod(0o600)
        with self.assertRaises(SystemExit):
            server_module.validate_secret_file(weak)

        duplicate = self.base / "duplicate-secret.json"
        duplicate.write_text(
            json.dumps(
                {
                    "tokens": [
                        {"token": TOKEN, "scopes": ["read"]},
                        {"token": TOKEN, "scopes": ["write"]},
                    ]
                }
            ),
            encoding="utf-8",
        )
        duplicate.chmod(0o600)
        with self.assertRaises(SystemExit):
            server_module.validate_secret_file(duplicate)

    def test_local_transfer_symlinks_and_hardlinked_parts_are_rejected(self) -> None:
        source = self.base / "source.bin"
        source.write_bytes(b"source")
        source_link = self.base / "source-link.bin"
        source_link.symlink_to(source)
        with self.assertRaises(farm.FarmError):
            farm.bridge_upload("ins_test", self.bridge.record, str(source_link), "source.bin")

        farm.bridge_write("ins_test", self.bridge.record, "remote.txt", "remote")
        outside = self.base / "outside.txt"
        outside.write_text("keep", encoding="utf-8")
        destination = self.base / "destination.txt"
        destination.symlink_to(outside)
        with self.assertRaises(farm.FarmError):
            farm.bridge_download(
                "ins_test", self.bridge.record, "remote.txt", str(destination), overwrite=True
            )
        self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

        safe_destination = self.base / "safe.txt"
        part = self.base / "safe.txt.openclaw.part"
        hardlink_peer = self.base / "part-peer"
        part.write_bytes(b"")
        os.link(part, hardlink_peer)
        with self.assertRaises(farm.FarmError):
            farm.bridge_download(
                "ins_test", self.bridge.record, "remote.txt", str(safe_destination)
            )

    def test_upload_staging_is_hidden_reserved_and_single_link_only(self) -> None:
        source = self.base / "one-byte.bin"
        source.write_bytes(b"x")
        started = farm.bridge_json(
            "ins_test",
            self.bridge.record,
            "write",
            "POST",
            "/v1/uploads",
            payload={
                "path": "staged.bin",
                "total_size": 1,
                "sha256": farm.file_sha256(source),
                "expected_sha256": None,
            },
        )
        upload_id = started["upload_id"]
        internal_name = f".openclaw-upload.{upload_id}.part"
        listing = farm.bridge_list("ins_test", self.bridge.record, ".")
        self.assertNotIn(internal_name, {entry["name"] for entry in listing["entries"]})
        with self.assertRaises(farm.FarmError):
            farm.bridge_stat("ins_test", self.bridge.record, internal_name)

        part = self.bridge.root / internal_name
        peer = self.bridge.root / "staging-hardlink-peer"
        os.link(part, peer)
        with self.assertRaises(farm.FarmError):
            with farm.bridge_open(
                "ins_test",
                self.bridge.record,
                "write",
                "PUT",
                f"/v1/uploads/{upload_id}",
                data=b"x",
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": "1",
                    "X-Upload-Offset": "0",
                },
            ):
                pass
        peer.unlink()
        aborted = farm.bridge_json(
            "ins_test",
            self.bridge.record,
            "write",
            "DELETE",
            f"/v1/uploads/{upload_id}",
        )
        self.assertTrue(aborted["aborted"])


if __name__ == "__main__":
    unittest.main()
