"""Isolated portability and ownership tests. No real services or credentials touched."""
from __future__ import annotations
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'app/openclaw-farm/scripts'
sys.path.insert(0,str(SCRIPTS))
sys.path.insert(0,str(ROOT))
import control
import private_storage as storage
import keychain_store as credentials
import openclaw_farm as farm
import bridge_forward_recovery as recovery


class RuntimeTests(unittest.TestCase):
    def test_platform_application_directories(self):
        self.assertEqual(storage.user_data_root('darwin',{},'/u'),Path('/u/Library/Application Support/OpenClaw Farm Console'))
        self.assertEqual(storage.user_data_root('win32',{'LOCALAPPDATA':'D:/Users/u/AppData/Local'},'/u'),Path('D:/Users/u/AppData/Local/OpenClaw Farm Console'))
        self.assertEqual(storage.user_data_root('linux',{'XDG_DATA_HOME':'/data'},'/u'),Path('/data/openclaw-farm-console'))
        self.assertEqual(storage.user_data_root('linux',{},'/u'),Path('/u/.local/share/openclaw-farm-console'))

    def test_atomic_private_storage_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'private/value.json'
            storage.write_json(path,{'value':1})
            self.assertEqual(json.loads(path.read_text()),{'value':1})
            self.assertTrue(storage.is_private(path))
            with storage.file_lock(Path(directory)/'lock'):
                with self.assertRaises(BlockingIOError):
                    with storage.file_lock(Path(directory)/'lock',timeout=0): pass
            with storage.file_lock(Path(directory)/'lock',timeout=0): pass

    def test_atomic_storage_refuses_symlink(self):
        if os.name == 'nt': self.skipTest('Symlink creation requires Windows optional privilege')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path/'real').mkdir()
            (path/'linked').symlink_to(path/'real',target_is_directory=True)
            with self.assertRaises(OSError): storage.private_directory(path/'linked')

    def test_native_backend_failure_never_falls_back(self):
        with mock.patch.dict(sys.modules,{'keyring.backends.macOS':None,'keyring.backends.SecretService':None,'keyring.backends.Windows':None}):
            with self.assertRaises(credentials.KeychainError): credentials.native_backend()

    def test_windows_arm64_emulated_python_still_selects_native_node(self):
        with mock.patch.object(control.sys, 'platform', 'win32'), mock.patch.object(control.platform, 'machine', return_value='AMD64'), mock.patch.dict(os.environ, {'PROCESSOR_ARCHITEW6432':'ARM64','PROCESSOR_ARCHITECTURE':'AMD64'}):
            self.assertEqual(control.host_arch(), 'arm64')
            self.assertEqual(control.python_request(), 'cpython-3.12.10-windows-x86_64-none')

    def test_credential_indexes_are_compatible(self):
        self.assertEqual(credentials.account_key(['service','openclaw-file-bridge','instance','1','scope','all']),
                         ('openclaw-file-bridge','{"instance":"1","scope":"all"}'))
        with mock.patch.object(credentials,'native_backend') as backend:
            backend.return_value.get_password.return_value='test-value'
            with mock.patch.object(farm,'sys') as fake_sys:
                fake_sys.platform='win32'
                self.assertEqual(farm.lookup_secret('1'),'test-value')
            backend.return_value.get_password.assert_called_once_with('openclaw-farm','{"instance":"1"}')

    def test_json_set_protocol_does_not_echo_secret(self):
        text='unique-test-secret'
        stdin=io.StringIO(json.dumps({'action':'set','service':'s','account':'a','value':text}))
        stdout=io.StringIO()
        with mock.patch.object(credentials,'credential_request',return_value=None) as request, mock.patch.object(sys,'argv',['keychain_store.py']), mock.patch.object(sys,'stdin',stdin), contextlib.redirect_stdout(stdout):
            self.assertEqual(credentials.main(),0)
        request.assert_called_once_with('set','s','a',text)
        self.assertNotIn(text,stdout.getvalue())
        self.assertEqual(json.loads(stdout.getvalue()),{'ok':True})

    def test_unknown_forward_is_never_killed(self):
        bridge={'transport':'ssh_relay','local_port':20001,'relay_port':19901,'relay_host':'relay.example','relay_user':'user','relay_key':'key'}
        registry={'instances':{'1':{'file_bridge':bridge}}}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(farm,'adapter_state_dir',return_value=Path(directory)), mock.patch.object(farm,'port_open',return_value=True), mock.patch.object(farm,'managed_forward_record',return_value=None), mock.patch.object(storage,'stop_owned') as stop:
            with self.assertRaises(farm.FarmError): recovery.recover_forward('1',registry,farm)
            stop.assert_not_called()

    def test_shared_forward_port_is_never_killed(self):
        bridge={'transport':'ssh_relay','local_port':20001}
        registry={'instances':{'1':{'file_bridge':bridge},'2':{'file_bridge':bridge}}}
        with mock.patch.object(storage,'stop_owned') as stop:
            with self.assertRaises(farm.FarmError): recovery.recover_forward('1',registry,farm)
            stop.assert_not_called()

    def test_pid_reuse_is_not_owned(self):
        fake=mock.Mock()
        fake.Process.return_value.create_time.return_value=456
        with mock.patch.dict(sys.modules,{'psutil':fake}):
            fake.Error=RuntimeError
            self.assertIsNone(storage.owned_process({'pid':123,'created':123,'command':['ssh','-N']}))
            fake.Process.return_value.terminate.assert_not_called()

    def test_runtime_extract_refuses_parent_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'bad.tar.gz'
            with tarfile.open(archive,'w:gz') as handle:
                info=tarfile.TarInfo('../escape');info.size=1
                handle.addfile(info,io.BytesIO(b'x'))
            with self.assertRaises(RuntimeError): control.safe_extract(archive,Path(directory)/'out')

    def test_config_env_matches_wizard_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            storage.write_json(root/'installation.json',{'id':'isolated-id'})
            storage.write_json(root/'config/local.json',{'node':'/node','python':'/python','consolePort':14317,'environment':{},
                'relay':{'host':'relay.example','user':'alice','sshPort':2222,'identityFile':'/key','portRange':[19900,20080]},
                'bridge':{'podPort':18081,'workspace':'/remote/workspace'}})
            _,env=control.environment(root)
            self.assertEqual(env['OPENCLAW_RELAY_SSH_PORT'],'2222')
            self.assertEqual(env['OPENCLAW_ORACLE_HOST'],'alice@relay.example')
            self.assertEqual(env['OPENCLAW_UI_PORT'],'14317')
            self.assertEqual(env['OPENCLAW_INSTALLATION_ID'],'isolated-id')

    def test_status_does_not_claim_other_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            storage.write_json(root/'installation.json',{'id':'our-id'})
            storage.write_json(root/'config/local.json',{'environment':{'OPENCLAW_UI_PORT':'14317'}})
            response=io.BytesIO(json.dumps({'service':'openclaw-farm-console','installationId':'another-id'}).encode())
            with mock.patch.object(control.urllib.request,'build_opener') as opener:
                opener.return_value.open.return_value=response
                self.assertIsNone(control.live_status(root))

    def test_background_registration_is_per_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            roots=[Path(directory)/name for name in ['first','second']]
            for root in roots: storage.write_json(root/'installation.json',{'id':root.name})
            self.assertNotEqual(control.service_label(roots[0]),control.service_label(roots[1]))
            self.assertNotEqual(control.service_task(roots[0]),control.service_task(roots[1]))
            with mock.patch.object(control.sys,'platform','win32'):
                paths=[control.unit_paths(root)[0] for root in roots]
                self.assertTrue(str(paths[0]).endswith('.cmd'))
                self.assertNotEqual(paths[0],paths[1])

    def test_download_resumes_after_interruption(self):
        value=b'official-verified-runtime'
        class Interrupted(io.BytesIO):
            status=200
            headers={}
            def read(self, size=-1):
                if self.tell(): raise OSError('Interrupted download')
                return super().read(8)
        first=Interrupted(value)
        second=io.BytesIO(value[8:]);second.status=206;second.headers={'Content-Range':f'bytes 8-{len(value)-1}/{len(value)}'}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(control.urllib.request,'urlopen',side_effect=[first,second]) as open_url, mock.patch.object(control.time,'sleep'):
            destination=Path(directory)/'runtime.bin'
            control.download('https://example.test/runtime',destination,hashlib.sha256(value).hexdigest())
            self.assertEqual(destination.read_bytes(),value)
            self.assertEqual(open_url.call_args.args[0].get_header('Range'),'bytes=8-')

    def test_windows_uninstall_defers_running_runtime_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'app'
            storage.write_json(root/'installation.json',{'id':'windows-fixture','backgroundMode':'managed-process'})
            (root/'runtime').mkdir();(root/'app').mkdir();(root/'cache').mkdir()
            external=Path(directory)/'external'
            with mock.patch.object(control.sys,'platform','win32'), mock.patch.object(control,'stop'), mock.patch.object(control,'defer_windows_uninstall',return_value=external/'result.json') as cleanup, mock.patch.object(control.shutil,'rmtree') as remove, contextlib.redirect_stdout(io.StringIO()):
                control.uninstall(root)
            remove.assert_not_called()
            cleanup.assert_called_once_with(root,{'id':'windows-fixture','backgroundMode':'managed-process'},False)
            marker=json.loads((root/'installation.json').read_text())
            self.assertTrue(marker['uninstalled'])
            self.assertTrue(marker['uninstallPending'])
            self.assertTrue((root/'runtime').exists())

    def test_install_upgrade_keeps_registry_and_user_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'app'
            storage.write_json(root/'installation.json',{'id':'kept-id','uninstalled':True})
            storage.write_json(root/'data/instances.json',{'schema_version':2,'instances':{'42':{'gateway_url':'wss://example/42/'}}})
            storage.write_json(root/'config/local.json',{'consolePort':12345,'relay':{'host':'kept.example'},'setupComplete':True,'environment':{'USER_OPTION':'keep'}})
            sdk_python=root/'runtime/python'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
            sdk_python.parent.mkdir(parents=True);sdk_python.touch()
            node=root/'runtime/node-bin'/('node.exe' if os.name=='nt' else 'bin/node')
            node.parent.mkdir(parents=True);node.touch()
            result=subprocess.CompletedProcess([],0,stdout=str(sdk_python)+'\n')
            with mock.patch.object(control,'bootstrap_uv',return_value=root/'runtime/tools/uv'), mock.patch.object(control,'bootstrap_node',return_value=node), mock.patch.object(control,'run',return_value=result), mock.patch.object(control.subprocess,'run',return_value=result), contextlib.redirect_stdout(io.StringIO()):
                control.install(root,no_start=True,no_autostart=True)
            values=control.settings(root)
            self.assertEqual(values['relay']['host'],'kept.example')
            self.assertTrue(values['setupComplete'])
            self.assertEqual(values['environment']['USER_OPTION'],'keep')
            self.assertIn('42',json.loads((root/'data/instances.json').read_text())['instances'])
            self.assertEqual(json.loads((root/'installation.json').read_text())['id'],'kept-id')
            self.assertEqual(json.loads((root/'installation.json').read_text())['backgroundMode'],'managed-process')

if __name__=='__main__': unittest.main()
