# Third-party notices and provenance

The root MIT license applies to original OpenClaw Farm Console code and documentation. It does not replace upstream licenses or grant rights to trademarks, hosted services, model outputs, or user data.

This source distribution ships application source and dependency manifests/locks, not installed third-party runtimes. The installer downloads dependencies into the user's installation. When redistributing an installed environment, keep every dependency's LICENSE, NOTICE, copyright and other attribution files, including transitive and optional packages actually included.

## Direct and important runtime dependencies

| Component | Locked version / source | Upstream license | Retained attribution |
|---|---|---|---|
| OpenClaw client SDK/package | npm openclaw 2026.4.2; runtime/node/package-lock.json records exact URL and integrity | MIT | Copyright (c) 2025 Peter Steinberger; [full text](docs/licenses/openclaw-MIT.txt) |
| Python MCP SDK | mcp 1.29.0; scripts/requirements-lock.txt | MIT | Copyright (c) 2024 Anthropic, PBC; [full text](docs/licenses/mcp-python-MIT.txt) |
| TypeScript MCP SDK, transitive through OpenClaw | @modelcontextprotocol/sdk 1.29.0; npm lock | MIT | Copyright (c) 2024 Anthropic, PBC; [full text](docs/licenses/mcp-typescript-MIT.txt) |
| Boto3, optional object-storage transfer path | scripts/requirements-lock.txt identifies exact boto3 version | Apache-2.0 | [full license](docs/licenses/boto3-APACHE-2.0.txt), [NOTICE](docs/licenses/boto3-NOTICE.txt) |
| @mistralai/mistralai, transitive SDK dependency | npm 1.14.1; exact tarball checked against lockfile integrity | Apache-2.0 | [original package license](docs/licenses/mistralai-APACHE-2.0.txt) |
| qrcode-terminal, transitive SDK dependency | npm 0.12.0; exact tarball checked against lockfile integrity | Apache-2.0 | [original package license](docs/licenses/qrcode-terminal-APACHE-2.0.txt) |
| keyring and platform credential adapters | scripts/requirements.in and scripts/requirements-lock.txt | Consult installed package metadata and dependency inventory | Native OS stores only; no plaintext fallback |
| Node.js, Python, uv | Installer downloads Node 22.14.0, Python 3.12.10 and uv 0.8.22; see dependency inventory | Their own upstream and component licenses | Not bundled in source archives; retain downloaded distribution notices |
| OpenSSH | External operating-system client and Linux relay server | Its upstream and OS distribution licenses | Not downloaded or bundled by this source archive |

Boto3's retained NOTICE: “boto3 — Copyright 2013-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.”

## Canonical upstream sources

- [OpenClaw 2026.4.2 license](https://github.com/openclaw/openclaw/blob/v2026.4.2/LICENSE), [npm package](https://www.npmjs.com/package/openclaw/v/2026.4.2).
- [Python MCP SDK 1.29.0 license](https://github.com/modelcontextprotocol/python-sdk/blob/v1.29.0/LICENSE).
- [TypeScript MCP SDK 1.29.0 license](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/LICENSE).
- [Boto3 repository](https://github.com/boto/boto3) contains version-specific LICENSE and NOTICE files copied under docs/licenses.

The full version inventory is in [dependencies.md](docs/dependencies.md); machine-readable provenance is in [dependency-inventory.json](docs/dependency-inventory.json). npm information comes from the lockfile. Python license metadata comes from each exact PyPI version when available and is marked unresolved if retrieval fails; absence is never treated as permission. Package metadata is an inventory aid, not a replacement for upstream license text. Refresh this inventory when a dependency lock changes.

The lock includes optional sharp/libvips packages with LGPL-3.0-or-later or combined licenses and Python certifi with MPL-2.0 metadata. These packages retain their own terms. This source-only release does not include their binaries; an installed-environment redistribution requires a separate review of the packages actually included and all corresponding license, notice and source obligations.

## Implementation provenance

The application integrates with OpenClaw using the installed official package, not a copied SDK implementation. The repository's Gateway adapter, MCP wrapper, console, file bridge, transfer helpers and install/control tooling are original integration code covered by the root MIT license unless a file states otherwise. Legacy operation instructions have been replaced with public, provider-neutral documentation. No private instance inventory, hosts, tokens, user chat or historical acceptance claim is part of this public release.
