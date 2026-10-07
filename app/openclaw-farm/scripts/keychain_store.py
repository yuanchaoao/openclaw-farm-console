#!/usr/bin/env python3
"""Native OS credentials only. JSON stdin protocol and a safe credential CLI."""
from __future__ import annotations
import argparse
import json
import sys
import private_storage

class KeychainError(RuntimeError): pass


def backend_name():
    return {'darwin': 'macos-keychain', 'win32': 'windows-credential-manager'}.get(sys.platform, 'secret-service')


def native_backend():
    try:
        if sys.platform == 'darwin':
            from keyring.backends.macOS import Keyring
        elif sys.platform == 'win32':
            from keyring.backends.Windows import WinVaultKeyring as Keyring
        else:
            from keyring.backends.SecretService import Keyring
        backend = Keyring()
        if backend.priority <= 0: raise KeychainError('系统凭据存储尚未可用。')
        return backend
    except Exception:
        raise KeychainError('系统凭据存储不可用；请解锁登录钥匙串或启用桌面 Secret Service。不会改用明文存储。') from None


def account_key(attributes):
    if len(attributes) % 2: raise KeychainError('凭据索引不完整。')
    values = dict(zip(attributes[::2], attributes[1::2]))
    service = values.pop('service', None)
    if not service or not values: raise KeychainError('凭据索引缺少 service 或 account。')
    return service, json.dumps(values, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def credential_request(action, service, account, value=None):
    if not isinstance(service, str) or not service or not isinstance(account, str) or not account:
        raise KeychainError('凭据服务名和账户名不能为空。')
    backend = native_backend()
    try:
        if action == 'get': return backend.get_password(service, account)
        if action == 'set':
            if not isinstance(value, str) or not value: raise KeychainError('凭据内容不能为空。')
            backend.set_password(service, account, value)
            return None
        if action == 'delete':
            from keyring.errors import PasswordDeleteError
            try: backend.delete_password(service, account)
            except PasswordDeleteError:
                if backend.get_password(service, account) is not None: raise
            return None
        raise KeychainError('凭据操作不支持。')
    except KeychainError: raise
    except Exception:
        raise KeychainError('系统凭据存储操作失败或访问被拒绝；请解锁并允许当前应用访问。') from None


def keychain_request(action, attributes, value=None):
    service, account = account_key(attributes)
    return credential_request(action, service, account, value)


def probe():
    native_backend()
    return {'ok': True, 'backend': backend_name(), 'plaintextFallback': False}


def main():
    # Existing helper callers send one JSON document. Never accept a secret in argv.
    if len(sys.argv) == 1:
        try:
            request = json.loads(sys.stdin.read(1024 * 1024))
            action = request.get('action')
            if action == 'probe': result = probe()
            else:
                value = credential_request(action, request.get('service'), request.get('account'), request.get('value'))
                result = {'ok': True}
                if action == 'get': result['value'] = value
            print(json.dumps(result, ensure_ascii=False))
            return 0
        except Exception:
            print(json.dumps({'ok': False, 'error': 'credential_store_unavailable'}))
            return 1
    parser = argparse.ArgumentParser(description='Native OS credential store; set reads its value from stdin.')
    parser.add_argument('action', choices=['get', 'set', 'delete', 'probe'])
    parser.add_argument('--service')
    parser.add_argument('--account')
    args = parser.parse_args()
    try:
        if args.action == 'probe': print(json.dumps(probe())); return 0
        value = credential_request(args.action, args.service, args.account,
                                   sys.stdin.read(1024 * 1024).rstrip('\r\n') if args.action == 'set' else None)
        if args.action == 'get' and value is not None: sys.stdout.write(value)
        return 3 if args.action == 'get' and value is None else 0
    except KeychainError as exc:
        print(str(exc), file=sys.stderr)
        return 1

if __name__ == '__main__': raise SystemExit(main())
