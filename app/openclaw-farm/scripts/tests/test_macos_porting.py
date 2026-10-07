from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import keychain_store as store
import openclaw_farm as farm
import fast_object_transfer as transfer


class MacPortingTests(unittest.TestCase):
    def test_pairing_metadata_survives_sdk_log_lines_without_credentials(self):
        request = "11111111-2222-3333-4444-555555555555"
        payload = {"code": "PAIRING_REQUIRED", "requestId": request, "deviceId": "a" * 64, "token": "dummy-secret"}
        completed = subprocess.CompletedProcess([], 1, "", 'gateway connect failed: pairing required\n' + json.dumps(payload))
        info = farm.gateway_failure_info(completed, "dummy-secret")
        self.assertEqual(info["requestId"], request)
        self.assertEqual(info["health_error"], "pairing required")
        self.assertNotIn("token", info)

    def test_credential_indexes_do_not_collide(self):
        attrs = [farm.keyring_attributes("ins_a", service, scope)
                 for service in [farm.SECRET_SERVICE, farm.BRIDGE_SECRET_SERVICE]
                 for scope in [None, "read", "write", "delete", "all"]]
        attrs.append(farm.keyring_attributes("ins_b"))
        attrs.append(transfer.profile_attributes("ins_a"))
        keys = [store.account_key(a) for a in attrs]
        self.assertEqual(len(keys), len(set(keys)))

    def test_no_secret_in_error(self):
        secret = "dummy-credential-not-for-production"
        with mock.patch.object(store, "native_backend") as native:
            native.return_value.set_password.side_effect = RuntimeError(secret)
            with self.assertRaises(store.KeychainError) as caught:
                store.keychain_request("set", farm.keyring_attributes("ins_a"), secret)
            self.assertNotIn(secret, str(caught.exception))

    def test_missing_and_denied_remain_distinct(self):
        with mock.patch.object(store, "native_backend") as native:
            native.return_value.get_password.return_value = None
            self.assertIsNone(store.keychain_request("get", farm.keyring_attributes("ins_a")))
            native.return_value.get_password.side_effect = RuntimeError("denied")
            with self.assertRaisesRegex(store.KeychainError, "拒绝"):
                store.keychain_request("get", farm.keyring_attributes("ins_a"))

    def test_package_root_does_not_require_global_openclaw(self):
        with tempfile.TemporaryDirectory(prefix="sdk space ") as directory:
            root = Path(directory); entry = root / "dist/plugin-sdk/testing.js"
            entry.parent.mkdir(parents=True); entry.touch()
            with mock.patch.dict(os.environ, {"OPENCLAW_PACKAGE_ROOT": directory}), mock.patch.object(farm.shutil, "which", return_value=None):
                self.assertEqual(farm.openclaw_package_root(), root.resolve())

    def test_native_registry_metadata_and_object_profile(self):
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(farm.build_record("ins_a", "https://example.com/ins_a/chat", "active")["credential_ref"]["backend"], "macos-keychain")
            payload = {"endpoint": "https://example.com", "bucket": "bucket", "access_key_id": "dummy", "secret_access_key": "dummy-secret"}
            with mock.patch.object(transfer, "keychain_request", return_value=json.dumps(payload)) as native:
                self.assertEqual(transfer.lookup_profile("test"), payload)
                transfer.store_profile("test", payload)
                self.assertEqual(native.call_args.args[0], "set")


@unittest.skipUnless(os.environ.get("OPENCLAW_TEST_KEYCHAIN") == "1", "opt-in actual native credential store smoke")
class NativeKeychainSmoke(unittest.TestCase):
    def test_round_trip_scopes_update_and_cleanup(self):
        instance = "native-store-test-" + uuid.uuid4().hex
        attrs = [farm.keyring_attributes(instance, farm.BRIDGE_SECRET_SERVICE, scope) for scope in ["read", "write", "delete"]]
        attrs += [farm.keyring_attributes(instance), transfer.profile_attributes(instance)]
        try:
            for index, key in enumerate(attrs):
                self.assertIsNone(store.keychain_request("get", key))
                store.keychain_request("set", key, "temporary-self-test-value-" + str(index))
            for index, key in enumerate(attrs):
                self.assertEqual(store.keychain_request("get", key), "temporary-self-test-value-" + str(index))
            store.keychain_request("set", attrs[0], "temporary-self-test-updated")
            self.assertEqual(store.keychain_request("get", attrs[0]), "temporary-self-test-updated")
        finally:
            for key in attrs: store.keychain_request("delete", key)
        for key in attrs: self.assertIsNone(store.keychain_request("get", key))
