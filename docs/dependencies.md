# Locked dependency inventory and license provenance

This inventory records all 523 package locations from `runtime/node/package-lock.json` and 51 version/marker entries from `scripts/requirements-lock.txt`, including transitive, optional and platform-specific dependencies. It does not assert that every entry is installed or tested on any machine. Complete URLs, integrity values, SHA-256 hashes, markers and metadata are retained in [dependency-inventory.json](dependency-inventory.json).

The root MIT license covers original project code only. Third-party license metadata comes from the npm lock or each exact official npm/PyPI version. For @mistralai/mistralai and qrcode-terminal, the missing standard metadata is resolved from the exact locked npm tarball after SRI verification; their original package/LICENSE files are retained under docs/licenses. Metadata does not replace license text. Missing metadata is unresolved, never permission. Regenerate the inventory when a lock changes; retain all LICENSE, NOTICE and copyright files for packages actually redistributed. Major upstream license texts and notices are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Downloaded runtime environment

| Component | Fixed version | Official source and license |
|---|---|---|
| Node.js | 22.14.0 | [Release](https://nodejs.org/dist/v22.14.0/), [full LICENSE including component licenses](https://github.com/nodejs/node/blob/v22.14.0/LICENSE) |
| Python | 3.12.10 | uv-managed [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases), [CPython LICENSE](https://github.com/python/cpython/blob/v3.12.10/LICENSE); retain the standalone distribution component licenses |
| uv | 0.8.22 | [Release](https://github.com/astral-sh/uv/releases/tag/0.8.22), [MIT](https://github.com/astral-sh/uv/blob/0.8.22/LICENSE-MIT) OR [Apache-2.0](https://github.com/astral-sh/uv/blob/0.8.22/LICENSE-APACHE) |
| OpenSSH | OS version | External OS client and Linux relay service; not shipped in the source archive |

The SSH relay does not use OCI APIs. Boto3 supports user-selected object-storage transfers and is not a relay requirement. Source archives contain manifests, not downloaded third-party binaries.

## npm locked packages

Entries follow lockfile package locations; a package can occur at multiple versions or nested locations. OpenClaw is locked to 2026.4.2, and the TypeScript MCP SDK to 1.29.0. The osc-progress transitive dependency is explicitly overridden to 0.3.0 for the fixed Node 22 runtime; the override and exact resolution are retained in the npm manifest and lock. Download URLs and SRI integrity values are in the machine inventory and lockfile. Optional installation depends on platform and npm.

| Package | Version | License metadata | Lock location / conditions |
|---|---|---|---|
| @agentclientprotocol/sdk | 0.17.1 | Apache-2.0 | node_modules/@agentclientprotocol/sdk |
| @anthropic-ai/sdk | 0.123.0 | MIT | node_modules/@anthropic-ai/sdk |
| @anthropic-ai/vertex-sdk | 0.14.4 | MIT | node_modules/@anthropic-ai/vertex-sdk |
| @aws-crypto/sha256-browser | 5.2.0 | Apache-2.0 | node_modules/@aws-crypto/sha256-browser |
| @smithy/util-utf8 | 2.3.0 | Apache-2.0 | node_modules/@aws-crypto/sha256-browser/node_modules/@smithy/util-utf8 |
| @aws-crypto/sha256-js | 5.2.0 | Apache-2.0 | node_modules/@aws-crypto/sha256-js |
| @aws-crypto/supports-web-crypto | 5.2.0 | Apache-2.0 | node_modules/@aws-crypto/supports-web-crypto |
| @aws-crypto/util | 5.2.0 | Apache-2.0 | node_modules/@aws-crypto/util |
| @smithy/util-utf8 | 2.3.0 | Apache-2.0 | node_modules/@aws-crypto/util/node_modules/@smithy/util-utf8 |
| @aws-sdk/client-bedrock | 3.1020.0 | Apache-2.0 | node_modules/@aws-sdk/client-bedrock |
| @aws-sdk/client-bedrock-runtime | 3.1124.0 | Apache-2.0 | node_modules/@aws-sdk/client-bedrock-runtime |
| @aws-sdk/token-providers | 3.1124.0 | Apache-2.0 | node_modules/@aws-sdk/client-bedrock-runtime/node_modules/@aws-sdk/token-providers |
| @aws-sdk/core | 3.977.9 | Apache-2.0 | node_modules/@aws-sdk/core |
| @aws-sdk/credential-provider-env | 3.972.70 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-env |
| @aws-sdk/credential-provider-http | 3.972.72 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-http |
| @aws-sdk/credential-provider-ini | 3.973.15 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-ini |
| @aws-sdk/credential-provider-login | 3.972.77 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-login |
| @aws-sdk/credential-provider-node | 3.972.82 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-node |
| @aws-sdk/credential-provider-process | 3.972.70 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-process |
| @aws-sdk/credential-provider-sso | 3.973.14 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-sso |
| @aws-sdk/token-providers | 3.1116.0 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers |
| @aws-sdk/credential-provider-web-identity | 3.972.76 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-web-identity |
| @aws-sdk/eventstream-handler-node | 3.972.34 | Apache-2.0 | node_modules/@aws-sdk/eventstream-handler-node |
| @aws-sdk/middleware-eventstream | 3.972.29 | Apache-2.0 | node_modules/@aws-sdk/middleware-eventstream |
| @aws-sdk/middleware-host-header | 3.972.45 | Apache-2.0 | node_modules/@aws-sdk/middleware-host-header |
| @aws-sdk/middleware-logger | 3.972.44 | Apache-2.0 | node_modules/@aws-sdk/middleware-logger |
| @aws-sdk/middleware-recursion-detection | 3.972.46 | Apache-2.0 | node_modules/@aws-sdk/middleware-recursion-detection |
| @aws-sdk/middleware-user-agent | 3.972.74 | Apache-2.0 | node_modules/@aws-sdk/middleware-user-agent |
| @aws-sdk/middleware-websocket | 3.972.52 | Apache-2.0 | node_modules/@aws-sdk/middleware-websocket |
| @aws-sdk/nested-clients | 3.997.44 | Apache-2.0 | node_modules/@aws-sdk/nested-clients |
| @aws-sdk/region-config-resolver | 3.972.48 | Apache-2.0 | node_modules/@aws-sdk/region-config-resolver |
| @aws-sdk/signature-v4-multi-region | 3.996.46 | Apache-2.0 | node_modules/@aws-sdk/signature-v4-multi-region |
| @aws-sdk/token-providers | 3.1020.0 | Apache-2.0 | node_modules/@aws-sdk/token-providers |
| @aws-sdk/types | 3.974.5 | Apache-2.0 | node_modules/@aws-sdk/types |
| @aws-sdk/util-endpoints | 3.996.43 | Apache-2.0 | node_modules/@aws-sdk/util-endpoints |
| @aws-sdk/util-locate-window | 3.965.10 | Apache-2.0 | node_modules/@aws-sdk/util-locate-window |
| @aws-sdk/util-user-agent-browser | 3.972.45 | Apache-2.0 | node_modules/@aws-sdk/util-user-agent-browser |
| @aws-sdk/util-user-agent-node | 3.973.60 | Apache-2.0 | node_modules/@aws-sdk/util-user-agent-node |
| @aws-sdk/xml-builder | 3.972.40 | Apache-2.0 | node_modules/@aws-sdk/xml-builder |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | node_modules/@aws/lambda-invoke-store |
| @babel/runtime | 7.29.7 | MIT | node_modules/@babel/runtime |
| @borewit/text-codec | 0.2.2 | MIT | node_modules/@borewit/text-codec |
| @clack/core | 1.4.3 | MIT | node_modules/@clack/core |
| @clack/prompts | 1.7.0 | MIT | node_modules/@clack/prompts |
| @emnapi/runtime | 1.11.3 | MIT | node_modules/@emnapi/runtime; optional |
| @google/genai | 1.52.0 | Apache-2.0 | node_modules/@google/genai |
| gcp-metadata | 8.1.2 | Apache-2.0 | node_modules/@google/genai/node_modules/gcp-metadata |
| google-auth-library | 10.9.1 | Apache-2.0 | node_modules/@google/genai/node_modules/google-auth-library |
| google-logging-utils | 1.1.3 | Apache-2.0 | node_modules/@google/genai/node_modules/google-logging-utils |
| @homebridge/ciao | 1.3.12 | MIT | node_modules/@homebridge/ciao |
| @hono/node-server | 1.19.17 | MIT | node_modules/@hono/node-server |
| @img/colour | 1.1.0 | MIT | node_modules/@img/colour |
| @img/sharp-darwin-arm64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-darwin-arm64; optional; os=darwin; cpu=arm64 |
| @img/sharp-darwin-x64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-darwin-x64; optional; os=darwin; cpu=x64 |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-darwin-arm64; optional; os=darwin; cpu=arm64 |
| @img/sharp-libvips-darwin-x64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-darwin-x64; optional; os=darwin; cpu=x64 |
| @img/sharp-libvips-linux-arm | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-arm; optional; os=linux; cpu=arm |
| @img/sharp-libvips-linux-arm64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-arm64; optional; os=linux; cpu=arm64 |
| @img/sharp-libvips-linux-ppc64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-ppc64; optional; os=linux; cpu=ppc64 |
| @img/sharp-libvips-linux-riscv64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-riscv64; optional; os=linux; cpu=riscv64 |
| @img/sharp-libvips-linux-s390x | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-s390x; optional; os=linux; cpu=s390x |
| @img/sharp-libvips-linux-x64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linux-x64; optional; os=linux; cpu=x64 |
| @img/sharp-libvips-linuxmusl-arm64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linuxmusl-arm64; optional; os=linux; cpu=arm64 |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | LGPL-3.0-or-later | node_modules/@img/sharp-libvips-linuxmusl-x64; optional; os=linux; cpu=x64 |
| @img/sharp-linux-arm | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-arm; optional; os=linux; cpu=arm |
| @img/sharp-linux-arm64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-arm64; optional; os=linux; cpu=arm64 |
| @img/sharp-linux-ppc64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-ppc64; optional; os=linux; cpu=ppc64 |
| @img/sharp-linux-riscv64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-riscv64; optional; os=linux; cpu=riscv64 |
| @img/sharp-linux-s390x | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-s390x; optional; os=linux; cpu=s390x |
| @img/sharp-linux-x64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linux-x64; optional; os=linux; cpu=x64 |
| @img/sharp-linuxmusl-arm64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linuxmusl-arm64; optional; os=linux; cpu=arm64 |
| @img/sharp-linuxmusl-x64 | 0.34.5 | Apache-2.0 | node_modules/@img/sharp-linuxmusl-x64; optional; os=linux; cpu=x64 |
| @img/sharp-wasm32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | node_modules/@img/sharp-wasm32; optional; cpu=wasm32 |
| @img/sharp-win32-arm64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | node_modules/@img/sharp-win32-arm64; optional; os=win32; cpu=arm64 |
| @img/sharp-win32-ia32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | node_modules/@img/sharp-win32-ia32; optional; os=win32; cpu=ia32 |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | node_modules/@img/sharp-win32-x64; optional; os=win32; cpu=x64 |
| @isaacs/fs-minipass | 4.0.1 | ISC | node_modules/@isaacs/fs-minipass |
| @line/bot-sdk | 10.8.0 | Apache-2.0 | node_modules/@line/bot-sdk |
| @lydell/node-pty | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty |
| @lydell/node-pty-darwin-arm64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-darwin-arm64; optional; os=darwin; cpu=arm64 |
| @lydell/node-pty-darwin-x64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-darwin-x64; optional; os=darwin; cpu=x64 |
| @lydell/node-pty-linux-arm64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-linux-arm64; optional; os=linux; cpu=arm64 |
| @lydell/node-pty-linux-x64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-linux-x64; optional; os=linux; cpu=x64 |
| @lydell/node-pty-win32-arm64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-win32-arm64; optional; os=win32; cpu=arm64 |
| @lydell/node-pty-win32-x64 | 1.2.0-beta.3 | MIT | node_modules/@lydell/node-pty-win32-x64; optional; os=win32; cpu=x64 |
| @mariozechner/clipboard | 0.3.9 | MIT | node_modules/@mariozechner/clipboard; optional |
| @mariozechner/clipboard-darwin-arm64 | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-darwin-arm64; optional; os=darwin; cpu=arm64 |
| @mariozechner/clipboard-darwin-universal | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-darwin-universal; optional; os=darwin |
| @mariozechner/clipboard-darwin-x64 | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-darwin-x64; optional; os=darwin; cpu=x64 |
| @mariozechner/clipboard-linux-arm64-gnu | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-linux-arm64-gnu; optional; os=linux; cpu=arm64 |
| @mariozechner/clipboard-linux-arm64-musl | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-linux-arm64-musl; optional; os=linux; cpu=arm64 |
| @mariozechner/clipboard-linux-riscv64-gnu | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-linux-riscv64-gnu; optional; os=linux; cpu=riscv64 |
| @mariozechner/clipboard-linux-x64-gnu | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-linux-x64-gnu; optional; os=linux; cpu=x64 |
| @mariozechner/clipboard-linux-x64-musl | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-linux-x64-musl; optional; os=linux; cpu=x64 |
| @mariozechner/clipboard-win32-arm64-msvc | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-win32-arm64-msvc; optional; os=win32; cpu=arm64 |
| @mariozechner/clipboard-win32-x64-msvc | 0.3.9 | MIT | node_modules/@mariozechner/clipboard-win32-x64-msvc; optional; os=win32; cpu=x64 |
| @mariozechner/jiti | 2.6.5 | MIT | node_modules/@mariozechner/jiti |
| @mariozechner/pi-agent-core | 0.64.0 | MIT | node_modules/@mariozechner/pi-agent-core |
| @mariozechner/pi-ai | 0.64.0 | MIT | node_modules/@mariozechner/pi-ai |
| @anthropic-ai/sdk | 0.73.0 | MIT | node_modules/@mariozechner/pi-ai/node_modules/@anthropic-ai/sdk |
| @mariozechner/pi-coding-agent | 0.64.0 | MIT | node_modules/@mariozechner/pi-coding-agent |
| file-type | 21.3.4 | MIT | node_modules/@mariozechner/pi-coding-agent/node_modules/file-type |
| @mariozechner/pi-tui | 0.64.0 | MIT | node_modules/@mariozechner/pi-tui |
| @matrix-org/matrix-sdk-crypto-nodejs | 0.4.0 | Apache-2.0 | node_modules/@matrix-org/matrix-sdk-crypto-nodejs; optional |
| @matrix-org/matrix-sdk-crypto-wasm | 18.0.0 | Apache-2.0 | node_modules/@matrix-org/matrix-sdk-crypto-wasm |
| @mistralai/mistralai | 1.14.1 | Apache-2.0 | node_modules/@mistralai/mistralai |
| @modelcontextprotocol/sdk | 1.29.0 | MIT | node_modules/@modelcontextprotocol/sdk |
| @mozilla/readability | 0.6.0 | Apache-2.0 | node_modules/@mozilla/readability |
| @napi-rs/canvas | 0.1.100 | MIT | node_modules/@napi-rs/canvas |
| @napi-rs/canvas-android-arm64 | 0.1.100 | MIT | node_modules/@napi-rs/canvas-android-arm64; optional; os=android; cpu=arm64 |
| @napi-rs/canvas-darwin-arm64 | 0.1.100 | MIT | node_modules/@napi-rs/canvas-darwin-arm64; optional; os=darwin; cpu=arm64 |
| @napi-rs/canvas-darwin-x64 | 0.1.100 | MIT | node_modules/@napi-rs/canvas-darwin-x64; optional; os=darwin; cpu=x64 |
| @napi-rs/canvas-linux-arm-gnueabihf | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-arm-gnueabihf; optional; os=linux; cpu=arm |
| @napi-rs/canvas-linux-arm64-gnu | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-arm64-gnu; optional; os=linux; cpu=arm64 |
| @napi-rs/canvas-linux-arm64-musl | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-arm64-musl; optional; os=linux; cpu=arm64 |
| @napi-rs/canvas-linux-riscv64-gnu | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-riscv64-gnu; optional; os=linux; cpu=riscv64 |
| @napi-rs/canvas-linux-x64-gnu | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-x64-gnu; optional; os=linux; cpu=x64 |
| @napi-rs/canvas-linux-x64-musl | 0.1.100 | MIT | node_modules/@napi-rs/canvas-linux-x64-musl; optional; os=linux; cpu=x64 |
| @napi-rs/canvas-win32-arm64-msvc | 0.1.100 | MIT | node_modules/@napi-rs/canvas-win32-arm64-msvc; optional; os=win32; cpu=arm64 |
| @napi-rs/canvas-win32-x64-msvc | 0.1.100 | MIT | node_modules/@napi-rs/canvas-win32-x64-msvc; optional; os=win32; cpu=x64 |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | node_modules/@protobufjs/aspromise |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | node_modules/@protobufjs/base64 |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | node_modules/@protobufjs/codegen |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | node_modules/@protobufjs/eventemitter |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | node_modules/@protobufjs/fetch |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | node_modules/@protobufjs/float |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | node_modules/@protobufjs/path |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | node_modules/@protobufjs/pool |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | node_modules/@protobufjs/utf8 |
| @silvia-odwyer/photon-node | 0.3.4 | Apache-2.0 | node_modules/@silvia-odwyer/photon-node |
| @sinclair/typebox | 0.34.49 | MIT | node_modules/@sinclair/typebox |
| @smithy/config-resolver | 4.7.2 | Apache-2.0 | node_modules/@smithy/config-resolver |
| @smithy/core | 3.33.3 | Apache-2.0 | node_modules/@smithy/core |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | node_modules/@smithy/credential-provider-imds |
| @smithy/fetch-http-handler | 5.7.2 | Apache-2.0 | node_modules/@smithy/fetch-http-handler |
| @smithy/hash-node | 4.5.2 | Apache-2.0 | node_modules/@smithy/hash-node |
| @smithy/invalid-dependency | 4.5.2 | Apache-2.0 | node_modules/@smithy/invalid-dependency |
| @smithy/is-array-buffer | 2.2.0 | Apache-2.0 | node_modules/@smithy/is-array-buffer |
| @smithy/middleware-content-length | 4.5.2 | Apache-2.0 | node_modules/@smithy/middleware-content-length |
| @smithy/middleware-endpoint | 4.7.2 | Apache-2.0 | node_modules/@smithy/middleware-endpoint |
| @smithy/middleware-retry | 4.8.2 | Apache-2.0 | node_modules/@smithy/middleware-retry |
| @smithy/middleware-serde | 4.5.2 | Apache-2.0 | node_modules/@smithy/middleware-serde |
| @smithy/middleware-stack | 4.5.2 | Apache-2.0 | node_modules/@smithy/middleware-stack |
| @smithy/node-config-provider | 4.6.2 | Apache-2.0 | node_modules/@smithy/node-config-provider |
| @smithy/node-http-handler | 4.12.0 | Apache-2.0 | node_modules/@smithy/node-http-handler |
| @smithy/property-provider | 4.5.2 | Apache-2.0 | node_modules/@smithy/property-provider |
| @smithy/protocol-http | 5.6.2 | Apache-2.0 | node_modules/@smithy/protocol-http |
| @smithy/shared-ini-file-loader | 4.7.2 | Apache-2.0 | node_modules/@smithy/shared-ini-file-loader |
| @smithy/signature-v4 | 5.7.3 | Apache-2.0 | node_modules/@smithy/signature-v4 |
| @smithy/smithy-client | 4.15.2 | Apache-2.0 | node_modules/@smithy/smithy-client |
| @smithy/types | 4.17.2 | Apache-2.0 | node_modules/@smithy/types |
| @smithy/url-parser | 4.5.2 | Apache-2.0 | node_modules/@smithy/url-parser |
| @smithy/util-base64 | 4.6.2 | Apache-2.0 | node_modules/@smithy/util-base64 |
| @smithy/util-body-length-browser | 4.5.2 | Apache-2.0 | node_modules/@smithy/util-body-length-browser |
| @smithy/util-body-length-node | 4.5.2 | Apache-2.0 | node_modules/@smithy/util-body-length-node |
| @smithy/util-buffer-from | 2.2.0 | Apache-2.0 | node_modules/@smithy/util-buffer-from |
| @smithy/util-defaults-mode-browser | 4.6.2 | Apache-2.0 | node_modules/@smithy/util-defaults-mode-browser |
| @smithy/util-defaults-mode-node | 4.5.2 | Apache-2.0 | node_modules/@smithy/util-defaults-mode-node |
| @smithy/util-endpoints | 3.7.2 | Apache-2.0 | node_modules/@smithy/util-endpoints |
| @smithy/util-middleware | 4.5.2 | Apache-2.0 | node_modules/@smithy/util-middleware |
| @smithy/util-retry | 4.6.2 | Apache-2.0 | node_modules/@smithy/util-retry |
| @smithy/util-utf8 | 4.5.2 | Apache-2.0 | node_modules/@smithy/util-utf8 |
| @stablelib/base64 | 1.0.1 | MIT | node_modules/@stablelib/base64 |
| @telegraf/types | 7.1.0 | MIT | node_modules/@telegraf/types; optional |
| @tokenizer/inflate | 0.4.1 | MIT | node_modules/@tokenizer/inflate |
| @tokenizer/token | 0.3.0 | MIT | node_modules/@tokenizer/token |
| @tootallnate/quickjs-emscripten | 0.23.0 | MIT | node_modules/@tootallnate/quickjs-emscripten |
| @types/events | 3.0.3 | MIT | node_modules/@types/events |
| @types/mime-types | 2.1.4 | MIT | node_modules/@types/mime-types |
| @types/node | 24.13.3 | MIT | node_modules/@types/node |
| @types/retry | 0.12.0 | MIT | node_modules/@types/retry |
| @types/yauzl | 2.10.3 | MIT | node_modules/@types/yauzl; optional |
| abort-controller | 3.0.0 | MIT | node_modules/abort-controller; optional |
| accepts | 2.0.0 | MIT | node_modules/accepts |
| agent-base | 7.1.4 | MIT | node_modules/agent-base |
| ajv | 8.20.0 | MIT | node_modules/ajv |
| ajv-formats | 3.0.1 | MIT | node_modules/ajv-formats |
| another-json | 0.2.0 | Apache-2.0 | node_modules/another-json |
| ansi-regex | 6.3.0 | MIT | node_modules/ansi-regex |
| ansi-styles | 4.3.0 | MIT | node_modules/ansi-styles |
| any-promise | 1.3.0 | MIT | node_modules/any-promise |
| argparse | 2.0.1 | Python-2.0 | node_modules/argparse |
| ast-types | 0.13.4 | MIT | node_modules/ast-types |
| asynckit | 0.4.0 | MIT | node_modules/asynckit; optional |
| axios | 1.20.0 | MIT | node_modules/axios; optional |
| agent-base | 6.0.2 | MIT | node_modules/axios/node_modules/agent-base; optional |
| https-proxy-agent | 5.0.1 | MIT | node_modules/axios/node_modules/https-proxy-agent; optional |
| balanced-match | 4.0.4 | MIT | node_modules/balanced-match |
| base-x | 5.0.1 | MIT | node_modules/base-x |
| base64-js | 1.5.1 | MIT | node_modules/base64-js |
| basic-ftp | 5.3.1 | MIT | node_modules/basic-ftp |
| bignumber.js | 9.3.1 | MIT | node_modules/bignumber.js |
| body-parser | 2.3.0 | MIT | node_modules/body-parser |
| content-type | 2.1.0 | MIT | node_modules/body-parser/node_modules/content-type |
| boolbase | 2.0.0 | ISC | node_modules/boolbase |
| bowser | 2.14.1 | MIT | node_modules/bowser |
| brace-expansion | 5.0.9 | MIT | node_modules/brace-expansion |
| bs58 | 6.0.0 | MIT | node_modules/bs58 |
| buffer-alloc | 1.2.0 | MIT | node_modules/buffer-alloc; optional |
| buffer-alloc-unsafe | 1.1.0 | MIT | node_modules/buffer-alloc-unsafe; optional |
| buffer-crc32 | 0.2.13 | MIT | node_modules/buffer-crc32 |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | node_modules/buffer-equal-constant-time |
| buffer-fill | 1.0.0 | MIT | node_modules/buffer-fill; optional |
| buffer-from | 1.1.2 | MIT | node_modules/buffer-from |
| bytes | 3.1.2 | MIT | node_modules/bytes |
| call-bind-apply-helpers | 1.0.2 | MIT | node_modules/call-bind-apply-helpers |
| call-bound | 1.0.4 | MIT | node_modules/call-bound |
| chalk | 5.6.2 | MIT | node_modules/chalk |
| chokidar | 5.0.0 | MIT | node_modules/chokidar |
| chownr | 3.0.0 | BlueOak-1.0.0 | node_modules/chownr |
| cli-highlight | 2.1.11 | ISC | node_modules/cli-highlight |
| chalk | 4.1.2 | MIT | node_modules/cli-highlight/node_modules/chalk |
| cliui | 7.0.4 | ISC | node_modules/cliui |
| ansi-regex | 5.0.1 | MIT | node_modules/cliui/node_modules/ansi-regex |
| strip-ansi | 6.0.1 | MIT | node_modules/cliui/node_modules/strip-ansi |
| color-convert | 2.0.1 | MIT | node_modules/color-convert |
| color-name | 1.1.4 | MIT | node_modules/color-name |
| combined-stream | 1.0.8 | MIT | node_modules/combined-stream; optional |
| commander | 14.0.3 | MIT | node_modules/commander |
| content-disposition | 1.1.0 | MIT | node_modules/content-disposition |
| content-type | 1.0.5 | MIT | node_modules/content-type |
| cookie | 0.7.2 | MIT | node_modules/cookie |
| cookie-signature | 1.2.2 | MIT | node_modules/cookie-signature |
| core-util-is | 1.0.3 | MIT | node_modules/core-util-is |
| cors | 2.8.6 | MIT | node_modules/cors |
| croner | 10.0.1 | MIT | node_modules/croner |
| cross-spawn | 7.0.6 | MIT | node_modules/cross-spawn |
| css-select | 7.0.0 | BSD-2-Clause | node_modules/css-select |
| css-what | 8.0.0 | BSD-2-Clause | node_modules/css-what |
| cssom | 0.5.0 | MIT | node_modules/cssom |
| data-uri-to-buffer | 4.0.1 | MIT | node_modules/data-uri-to-buffer |
| debug | 4.4.3 | MIT | node_modules/debug |
| degenerator | 5.0.1 | MIT | node_modules/degenerator |
| delayed-stream | 1.0.0 | MIT | node_modules/delayed-stream; optional |
| depd | 2.0.0 | MIT | node_modules/depd |
| detect-libc | 2.1.2 | Apache-2.0 | node_modules/detect-libc |
| diff | 8.0.4 | BSD-3-Clause | node_modules/diff |
| dom-serializer | 3.1.1 | MIT | node_modules/dom-serializer |
| domelementtype | 3.0.0 | BSD-2-Clause | node_modules/domelementtype |
| domhandler | 6.0.1 | BSD-2-Clause | node_modules/domhandler |
| domutils | 4.0.2 | BSD-2-Clause | node_modules/domutils |
| dotenv | 17.4.2 | BSD-2-Clause | node_modules/dotenv |
| dunder-proto | 1.0.1 | MIT | node_modules/dunder-proto |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | node_modules/ecdsa-sig-formatter |
| ee-first | 1.1.1 | MIT | node_modules/ee-first |
| emoji-regex | 8.0.0 | MIT | node_modules/emoji-regex |
| encodeurl | 2.0.0 | MIT | node_modules/encodeurl |
| end-of-stream | 1.4.5 | MIT | node_modules/end-of-stream |
| entities | 8.0.0 | BSD-2-Clause | node_modules/entities |
| es-define-property | 1.0.1 | MIT | node_modules/es-define-property |
| es-errors | 1.3.0 | MIT | node_modules/es-errors |
| es-object-atoms | 1.1.2 | MIT | node_modules/es-object-atoms |
| es-set-tostringtag | 2.1.0 | MIT | node_modules/es-set-tostringtag; optional |
| escalade | 3.2.0 | MIT | node_modules/escalade |
| escape-html | 1.0.3 | MIT | node_modules/escape-html |
| escodegen | 2.1.0 | BSD-2-Clause | node_modules/escodegen |
| esprima | 4.0.1 | BSD-2-Clause | node_modules/esprima |
| estraverse | 5.3.0 | BSD-2-Clause | node_modules/estraverse |
| esutils | 2.0.3 | BSD-2-Clause | node_modules/esutils |
| etag | 1.8.1 | MIT | node_modules/etag |
| event-target-shim | 5.0.1 | MIT | node_modules/event-target-shim; optional |
| events | 3.3.0 | MIT | node_modules/events |
| eventsource | 3.0.7 | MIT | node_modules/eventsource |
| eventsource-parser | 3.1.1 | MIT | node_modules/eventsource-parser |
| express | 5.2.1 | MIT | node_modules/express |
| express-rate-limit | 8.7.0 | MIT | node_modules/express-rate-limit |
| extend | 3.0.2 | MIT | node_modules/extend |
| extract-zip | 2.0.1 | BSD-2-Clause | node_modules/extract-zip |
| fast-deep-equal | 3.1.3 | MIT | node_modules/fast-deep-equal |
| fast-sha256 | 1.3.0 | Unlicense | node_modules/fast-sha256 |
| fast-string-truncated-width | 3.0.3 | MIT | node_modules/fast-string-truncated-width |
| fast-string-width | 3.0.2 | MIT | node_modules/fast-string-width |
| fast-uri | 3.1.6 | BSD-3-Clause | node_modules/fast-uri |
| fast-wrap-ansi | 0.2.2 | MIT | node_modules/fast-wrap-ansi |
| fd-slicer | 1.1.0 | MIT | node_modules/fd-slicer |
| fetch-blob | 3.2.0 | MIT | node_modules/fetch-blob |
| file-type | 22.0.0 | MIT | node_modules/file-type |
| finalhandler | 2.1.1 | MIT | node_modules/finalhandler |
| follow-redirects | 1.16.0 | MIT | node_modules/follow-redirects; optional |
| form-data | 4.0.6 | MIT | node_modules/form-data; optional |
| mime-db | 1.52.0 | MIT | node_modules/form-data/node_modules/mime-db; optional |
| mime-types | 2.1.35 | MIT | node_modules/form-data/node_modules/mime-types; optional |
| formdata-polyfill | 4.0.10 | MIT | node_modules/formdata-polyfill |
| forwarded | 0.2.0 | MIT | node_modules/forwarded |
| fresh | 2.0.0 | MIT | node_modules/fresh |
| function-bind | 1.1.2 | MIT | node_modules/function-bind |
| gaxios | 7.1.4 | Apache-2.0 | node_modules/gaxios |
| gcp-metadata | 6.1.1 | Apache-2.0 | node_modules/gcp-metadata |
| gaxios | 6.7.1 | Apache-2.0 | node_modules/gcp-metadata/node_modules/gaxios |
| node-fetch | 2.7.0 | MIT | node_modules/gcp-metadata/node_modules/node-fetch |
| uuid | 9.0.1 | MIT | node_modules/gcp-metadata/node_modules/uuid |
| get-caller-file | 2.0.5 | ISC | node_modules/get-caller-file |
| get-east-asian-width | 1.6.0 | MIT | node_modules/get-east-asian-width |
| get-intrinsic | 1.3.0 | MIT | node_modules/get-intrinsic |
| get-proto | 1.0.1 | MIT | node_modules/get-proto |
| get-stream | 5.2.0 | MIT | node_modules/get-stream |
| get-uri | 6.0.5 | MIT | node_modules/get-uri |
| data-uri-to-buffer | 6.0.2 | MIT | node_modules/get-uri/node_modules/data-uri-to-buffer |
| glob | 13.0.6 | BlueOak-1.0.0 | node_modules/glob |
| google-auth-library | 9.15.1 | Apache-2.0 | node_modules/google-auth-library |
| gaxios | 6.7.1 | Apache-2.0 | node_modules/google-auth-library/node_modules/gaxios |
| node-fetch | 2.7.0 | MIT | node_modules/google-auth-library/node_modules/node-fetch |
| uuid | 9.0.1 | MIT | node_modules/google-auth-library/node_modules/uuid |
| google-logging-utils | 0.0.2 | Apache-2.0 | node_modules/google-logging-utils |
| gopd | 1.2.0 | MIT | node_modules/gopd |
| graceful-fs | 4.2.11 | ISC | node_modules/graceful-fs |
| gtoken | 7.1.0 | MIT | node_modules/gtoken |
| gaxios | 6.7.1 | Apache-2.0 | node_modules/gtoken/node_modules/gaxios |
| node-fetch | 2.7.0 | MIT | node_modules/gtoken/node_modules/node-fetch |
| uuid | 9.0.1 | MIT | node_modules/gtoken/node_modules/uuid |
| has-flag | 4.0.0 | MIT | node_modules/has-flag |
| has-symbols | 1.1.0 | MIT | node_modules/has-symbols |
| has-tostringtag | 1.0.2 | MIT | node_modules/has-tostringtag; optional |
| hasown | 2.0.4 | MIT | node_modules/hasown |
| highlight.js | 10.7.3 | BSD-3-Clause | node_modules/highlight.js |
| hono | 4.12.9 | MIT | node_modules/hono |
| hosted-git-info | 9.0.3 | ISC | node_modules/hosted-git-info |
| html-escaper | 3.0.3 | MIT | node_modules/html-escaper |
| htmlparser2 | 10.1.0 | MIT | node_modules/htmlparser2 |
| dom-serializer | 2.0.0 | MIT | node_modules/htmlparser2/node_modules/dom-serializer |
| entities | 4.5.0 | BSD-2-Clause | node_modules/htmlparser2/node_modules/dom-serializer/node_modules/entities |
| domelementtype | 2.3.0 | BSD-2-Clause | node_modules/htmlparser2/node_modules/domelementtype |
| domhandler | 5.0.3 | BSD-2-Clause | node_modules/htmlparser2/node_modules/domhandler |
| domutils | 3.2.2 | BSD-2-Clause | node_modules/htmlparser2/node_modules/domutils |
| entities | 7.0.1 | BSD-2-Clause | node_modules/htmlparser2/node_modules/entities |
| http-errors | 2.0.1 | MIT | node_modules/http-errors |
| http-proxy-agent | 7.0.2 | MIT | node_modules/http-proxy-agent |
| https-proxy-agent | 7.0.6 | MIT | node_modules/https-proxy-agent |
| iconv-lite | 0.7.3 | MIT | node_modules/iconv-lite |
| ieee754 | 1.2.1 | BSD-3-Clause | node_modules/ieee754 |
| ignore | 7.0.8 | MIT | node_modules/ignore |
| immediate | 3.0.6 | MIT | node_modules/immediate |
| inherits | 2.0.4 | ISC | node_modules/inherits |
| ip-address | 10.7.0 | MIT | node_modules/ip-address |
| ipaddr.js | 2.5.0 | MIT | node_modules/ipaddr.js |
| is-fullwidth-code-point | 3.0.0 | MIT | node_modules/is-fullwidth-code-point |
| is-network-error | 1.3.2 | MIT | node_modules/is-network-error |
| is-promise | 4.0.0 | MIT | node_modules/is-promise |
| is-stream | 2.0.1 | MIT | node_modules/is-stream |
| isarray | 1.0.0 | MIT | node_modules/isarray |
| isexe | 2.0.0 | ISC | node_modules/isexe |
| jiti | 2.7.0 | MIT | node_modules/jiti |
| jose | 6.2.10 | MIT | node_modules/jose |
| json-bigint | 1.0.0 | MIT | node_modules/json-bigint |
| json-schema-to-ts | 3.1.1 | MIT | node_modules/json-schema-to-ts |
| json-schema-traverse | 1.0.0 | MIT | node_modules/json-schema-traverse |
| json-schema-typed | 8.0.2 | BSD-2-Clause | node_modules/json-schema-typed |
| json5 | 2.2.3 | MIT | node_modules/json5 |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | node_modules/jszip |
| jwa | 2.0.1 | MIT | node_modules/jwa |
| jws | 4.0.1 | MIT | node_modules/jws |
| jwt-decode | 4.0.0 | MIT | node_modules/jwt-decode |
| koffi | 2.16.3 | MIT | node_modules/koffi; optional |
| lie | 3.3.0 | MIT | node_modules/lie |
| linkedom | 0.18.13 | ISC | node_modules/linkedom |
| linkify-it | 5.0.2 | MIT | node_modules/linkify-it |
| loglevel | 1.9.2 | MIT | node_modules/loglevel |
| long | 5.3.2 | Apache-2.0 | node_modules/long |
| lru-cache | 11.5.2 | BlueOak-1.0.0 | node_modules/lru-cache |
| markdown-it | 14.3.1 | MIT | node_modules/markdown-it |
| entities | 4.5.0 | BSD-2-Clause | node_modules/markdown-it/node_modules/entities |
| marked | 15.0.12 | MIT | node_modules/marked |
| math-intrinsics | 1.1.0 | MIT | node_modules/math-intrinsics |
| matrix-events-sdk | 0.0.1 | Apache-2.0 | node_modules/matrix-events-sdk |
| matrix-js-sdk | 41.3.0-rc.0 | Apache-2.0 | node_modules/matrix-js-sdk |
| p-retry | 7.1.1 | MIT | node_modules/matrix-js-sdk/node_modules/p-retry |
| matrix-widget-api | 1.19.0 | Apache-2.0 | node_modules/matrix-widget-api |
| mdurl | 2.1.0 | MIT | node_modules/mdurl |
| media-typer | 1.1.1 | MIT | node_modules/media-typer |
| merge-descriptors | 2.0.0 | MIT | node_modules/merge-descriptors |
| mime-db | 1.54.0 | MIT | node_modules/mime-db |
| mime-types | 3.0.2 | MIT | node_modules/mime-types |
| minimatch | 10.2.6 | BlueOak-1.0.0 | node_modules/minimatch |
| minipass | 7.1.3 | BlueOak-1.0.0 | node_modules/minipass |
| minizlib | 3.1.0 | MIT | node_modules/minizlib |
| mri | 1.2.0 | MIT | node_modules/mri; optional |
| ms | 2.1.3 | MIT | node_modules/ms |
| mz | 2.7.0 | MIT | node_modules/mz |
| negotiator | 1.1.0 | MIT | node_modules/negotiator |
| content-type | 2.1.0 | MIT | node_modules/negotiator/node_modules/content-type |
| netmask | 2.1.1 | MIT | node_modules/netmask |
| node-domexception | 1.0.0 | MIT | node_modules/node-domexception |
| node-downloader-helper | 2.1.11 | MIT | node_modules/node-downloader-helper; optional |
| node-edge-tts | 1.2.10 | MIT | node_modules/node-edge-tts |
| ansi-regex | 5.0.1 | MIT | node_modules/node-edge-tts/node_modules/ansi-regex |
| cliui | 8.0.1 | ISC | node_modules/node-edge-tts/node_modules/cliui |
| strip-ansi | 6.0.1 | MIT | node_modules/node-edge-tts/node_modules/strip-ansi |
| yargs | 17.7.3 | MIT | node_modules/node-edge-tts/node_modules/yargs |
| yargs-parser | 21.1.1 | ISC | node_modules/node-edge-tts/node_modules/yargs-parser |
| node-fetch | 3.3.2 | MIT | node_modules/node-fetch |
| nth-check | 3.0.1 | BSD-2-Clause | node_modules/nth-check |
| object-assign | 4.1.1 | MIT | node_modules/object-assign |
| object-inspect | 1.13.4 | MIT | node_modules/object-inspect |
| oidc-client-ts | 3.5.0 | Apache-2.0 | node_modules/oidc-client-ts |
| on-finished | 2.4.1 | MIT | node_modules/on-finished |
| once | 1.4.0 | ISC | node_modules/once |
| openai | 6.26.0 | Apache-2.0 | node_modules/openai |
| openclaw | 2026.4.2 | MIT | node_modules/openclaw |
| openshell | 0.1.0 | MIT | node_modules/openshell; optional |
| dotenv | 16.6.1 | BSD-2-Clause | node_modules/openshell/node_modules/dotenv; optional |
| osc-progress | 0.3.0 | MIT | node_modules/openclaw/node_modules/osc-progress |
| p-retry | 4.6.2 | MIT | node_modules/p-retry |
| p-timeout | 4.1.0 | MIT | node_modules/p-timeout; optional |
| pac-proxy-agent | 7.2.0 | MIT | node_modules/pac-proxy-agent |
| pac-resolver | 7.0.1 | MIT | node_modules/pac-resolver |
| pako | 1.0.11 | (MIT AND Zlib) | node_modules/pako |
| parse5 | 5.1.1 | MIT | node_modules/parse5 |
| parse5-htmlparser2-tree-adapter | 6.0.1 | MIT | node_modules/parse5-htmlparser2-tree-adapter |
| parse5 | 6.0.1 | MIT | node_modules/parse5-htmlparser2-tree-adapter/node_modules/parse5 |
| parseurl | 1.3.3 | MIT | node_modules/parseurl |
| partial-json | 0.1.7 | MIT | node_modules/partial-json |
| path-key | 3.1.1 | MIT | node_modules/path-key |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | node_modules/path-scurry |
| path-to-regexp | 8.4.2 | MIT | node_modules/path-to-regexp |
| pdfjs-dist | 5.7.284 | Apache-2.0 | node_modules/pdfjs-dist |
| pend | 1.2.0 | MIT | node_modules/pend |
| pkce-challenge | 5.0.1 | MIT | node_modules/pkce-challenge |
| playwright-core | 1.58.2 | Apache-2.0 | node_modules/playwright-core |
| process-nextick-args | 2.0.1 | MIT | node_modules/process-nextick-args |
| proper-lockfile | 4.1.2 | MIT | node_modules/proper-lockfile |
| retry | 0.12.0 | MIT | node_modules/proper-lockfile/node_modules/retry |
| protobufjs | 7.6.6 | BSD-3-Clause | node_modules/protobufjs |
| proxy-addr | 2.0.7 | MIT | node_modules/proxy-addr |
| ipaddr.js | 1.9.1 | MIT | node_modules/proxy-addr/node_modules/ipaddr.js |
| proxy-agent | 6.5.0 | MIT | node_modules/proxy-agent |
| lru-cache | 7.18.3 | ISC | node_modules/proxy-agent/node_modules/lru-cache |
| proxy-from-env | 1.1.0 | MIT | node_modules/proxy-agent/node_modules/proxy-from-env |
| proxy-from-env | 2.1.0 | MIT | node_modules/proxy-from-env; optional |
| pump | 3.0.4 | MIT | node_modules/pump |
| punycode.js | 2.3.1 | MIT | node_modules/punycode.js |
| qrcode-terminal | 0.12.0 | Apache-2.0 | node_modules/qrcode-terminal |
| qs | 6.16.0 | BSD-3-Clause | node_modules/qs |
| range-parser | 1.3.0 | MIT | node_modules/range-parser |
| raw-body | 3.0.2 | MIT | node_modules/raw-body |
| readable-stream | 2.3.8 | MIT | node_modules/readable-stream |
| safe-buffer | 5.1.2 | MIT | node_modules/readable-stream/node_modules/safe-buffer |
| readdirp | 5.1.1 | MIT | node_modules/readdirp |
| require-directory | 2.1.1 | MIT | node_modules/require-directory |
| require-from-string | 2.0.2 | MIT | node_modules/require-from-string |
| retry | 0.13.1 | MIT | node_modules/retry |
| router | 2.2.0 | MIT | node_modules/router |
| safe-buffer | 5.2.1 | MIT | node_modules/safe-buffer |
| safe-compare | 1.1.4 | MIT | node_modules/safe-compare; optional |
| safer-buffer | 2.1.2 | MIT | node_modules/safer-buffer |
| sandwich-stream | 2.0.2 | Apache-2.0 | node_modules/sandwich-stream; optional |
| sdp-transform | 3.0.0 | MIT | node_modules/sdp-transform |
| semver | 7.8.5 | ISC | node_modules/semver |
| send | 1.2.1 | MIT | node_modules/send |
| serve-static | 2.2.1 | MIT | node_modules/serve-static |
| setimmediate | 1.0.5 | MIT | node_modules/setimmediate |
| setprototypeof | 1.2.0 | ISC | node_modules/setprototypeof |
| sharp | 0.34.5 | Apache-2.0 | node_modules/sharp |
| shebang-command | 2.0.0 | MIT | node_modules/shebang-command |
| shebang-regex | 3.0.0 | MIT | node_modules/shebang-regex |
| side-channel | 1.1.1 | MIT | node_modules/side-channel |
| side-channel-list | 1.0.1 | MIT | node_modules/side-channel-list |
| side-channel-map | 1.0.1 | MIT | node_modules/side-channel-map |
| side-channel-weakmap | 1.0.2 | MIT | node_modules/side-channel-weakmap |
| signal-exit | 3.0.7 | ISC | node_modules/signal-exit |
| sisteransi | 1.0.5 | MIT | node_modules/sisteransi |
| smart-buffer | 4.2.0 | MIT | node_modules/smart-buffer |
| socks | 2.8.9 | MIT | node_modules/socks |
| socks-proxy-agent | 8.0.5 | MIT | node_modules/socks-proxy-agent |
| source-map | 0.6.1 | BSD-3-Clause | node_modules/source-map |
| source-map-support | 0.5.21 | MIT | node_modules/source-map-support |
| sqlite-vec | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec |
| sqlite-vec-darwin-arm64 | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec-darwin-arm64; optional; os=darwin; cpu=arm64 |
| sqlite-vec-darwin-x64 | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec-darwin-x64; optional; os=darwin; cpu=x64 |
| sqlite-vec-linux-arm64 | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec-linux-arm64; optional; os=linux; cpu=arm64 |
| sqlite-vec-linux-x64 | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec-linux-x64; optional; os=linux; cpu=x64 |
| sqlite-vec-windows-x64 | 0.1.9 | MIT OR Apache | node_modules/sqlite-vec-windows-x64; optional; os=win32; cpu=x64 |
| standardwebhooks | 1.1.1 | MIT | node_modules/standardwebhooks |
| statuses | 2.0.2 | MIT | node_modules/statuses |
| std-env | 3.10.0 | MIT | node_modules/std-env |
| string_decoder | 1.1.1 | MIT | node_modules/string_decoder |
| safe-buffer | 5.1.2 | MIT | node_modules/string_decoder/node_modules/safe-buffer |
| string-width | 4.2.3 | MIT | node_modules/string-width |
| ansi-regex | 5.0.1 | MIT | node_modules/string-width/node_modules/ansi-regex |
| strip-ansi | 6.0.1 | MIT | node_modules/string-width/node_modules/strip-ansi |
| strip-ansi | 7.2.0 | MIT | node_modules/strip-ansi |
| strtok3 | 10.3.5 | MIT | node_modules/strtok3 |
| supports-color | 7.2.0 | MIT | node_modules/supports-color |
| tar | 7.5.13 | BlueOak-1.0.0 | node_modules/tar |
| telegraf | 4.16.3 | MIT | node_modules/telegraf; optional |
| node-fetch | 2.7.0 | MIT | node_modules/telegraf/node_modules/node-fetch; optional |
| thenify | 3.3.1 | MIT | node_modules/thenify |
| thenify-all | 1.6.0 | MIT | node_modules/thenify-all |
| toidentifier | 1.0.1 | MIT | node_modules/toidentifier |
| token-types | 6.1.2 | MIT | node_modules/token-types |
| tr46 | 0.0.3 | MIT | node_modules/tr46 |
| ts-algebra | 2.0.0 | MIT | node_modules/ts-algebra |
| tslib | 2.8.1 | 0BSD | node_modules/tslib |
| tslog | 4.11.0 | MIT | node_modules/tslog |
| type-is | 2.1.0 | MIT | node_modules/type-is |
| content-type | 2.1.0 | MIT | node_modules/type-is/node_modules/content-type |
| uc.micro | 2.1.0 | MIT | node_modules/uc.micro |
| uhyphen | 0.2.0 | ISC | node_modules/uhyphen |
| uint8array-extras | 1.5.0 | MIT | node_modules/uint8array-extras |
| undici | 7.29.0 | MIT | node_modules/undici |
| undici-types | 7.18.2 | MIT | node_modules/undici-types |
| unhomoglyph | 1.0.6 | MIT | node_modules/unhomoglyph |
| unpipe | 1.0.0 | MIT | node_modules/unpipe |
| util-deprecate | 1.0.2 | MIT | node_modules/util-deprecate |
| uuid | 13.0.2 | MIT | node_modules/uuid |
| vary | 1.1.2 | MIT | node_modules/vary |
| web-streams-polyfill | 3.3.3 | MIT | node_modules/web-streams-polyfill |
| webidl-conversions | 3.0.1 | BSD-2-Clause | node_modules/webidl-conversions |
| whatwg-url | 5.0.0 | MIT | node_modules/whatwg-url |
| which | 2.0.2 | ISC | node_modules/which |
| wrap-ansi | 7.0.0 | MIT | node_modules/wrap-ansi |
| ansi-regex | 5.0.1 | MIT | node_modules/wrap-ansi/node_modules/ansi-regex |
| strip-ansi | 6.0.1 | MIT | node_modules/wrap-ansi/node_modules/strip-ansi |
| wrappy | 1.0.2 | ISC | node_modules/wrappy |
| ws | 8.21.3 | MIT | node_modules/ws |
| y18n | 5.0.8 | ISC | node_modules/y18n |
| yallist | 5.0.0 | BlueOak-1.0.0 | node_modules/yallist |
| yaml | 2.9.0 | ISC | node_modules/yaml |
| yargs | 16.2.2 | MIT | node_modules/yargs |
| yargs-parser | 20.2.9 | ISC | node_modules/yargs-parser |
| yauzl | 2.10.0 | MIT | node_modules/yauzl |
| yoctocolors | 2.2.0 | MIT | node_modules/yoctocolors |
| zod | 4.5.4 | MIT | node_modules/zod |
| zod-to-json-schema | 3.25.2 | ISC | node_modules/zod-to-json-schema |

## Python locked requirements

License metadata is queried for each exact PyPI version. Apply the markers from the lockfile; all allowed SHA-256 values remain in the JSON inventory. Native credentials use macOS Keychain, Windows Credential Manager or Linux Secret Service. Backend failure does not enable a plaintext fallback.

| Package | Version | Marker | License metadata | Exact version source |
|---|---|---|---|---|
| annotated-types | 0.8.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/annotated-types/0.8.0/json) |
| anyio | 4.15.1 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/anyio/4.15.1/json) |
| attrs | 26.1.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/attrs/26.1.0/json) |
| backports-tarfile | 1.2.0 | python_full_version < '3.12' | MIT License | [PyPI](https://pypi.org/pypi/backports-tarfile/1.2.0/json) |
| boto3 | 1.43.86 | all applicable platforms | Apache-2.0 | [PyPI](https://pypi.org/pypi/boto3/1.43.86/json) |
| botocore | 1.43.108 | all applicable platforms | Apache-2.0 | [PyPI](https://pypi.org/pypi/botocore/1.43.108/json) |
| certifi | 2026.7.22 | all applicable platforms | Mozilla Public License 2.0 (MPL 2.0) | [PyPI](https://pypi.org/pypi/certifi/2026.7.22/json) |
| cffi | 2.1.1 | platform_python_implementation != 'PyPy' | MIT-0 | [PyPI](https://pypi.org/pypi/cffi/2.1.1/json) |
| click | 8.5.0 | sys_platform != 'emscripten' | BSD-3-Clause | [PyPI](https://pypi.org/pypi/click/8.5.0/json) |
| cryptography | 50.0.2 | all applicable platforms | Apache-2.0 OR BSD-3-Clause | [PyPI](https://pypi.org/pypi/cryptography/50.0.2/json) |
| exceptiongroup | 1.3.1 | python_full_version < '3.11' | MIT License | [PyPI](https://pypi.org/pypi/exceptiongroup/1.3.1/json) |
| h11 | 0.16.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/h11/0.16.0/json) |
| httpcore | 1.0.9 | all applicable platforms | BSD-3-Clause | [PyPI](https://pypi.org/pypi/httpcore/1.0.9/json) |
| httpx | 0.28.1 | all applicable platforms | BSD License | [PyPI](https://pypi.org/pypi/httpx/0.28.1/json) |
| httpx-sse | 0.4.3 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/httpx-sse/0.4.3/json) |
| idna | 3.20 | all applicable platforms | BSD-3-Clause | [PyPI](https://pypi.org/pypi/idna/3.20/json) |
| importlib-metadata | 9.0.1 | python_full_version < '3.12' | Apache-2.0 | [PyPI](https://pypi.org/pypi/importlib-metadata/9.0.1/json) |
| jaraco-classes | 3.4.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/jaraco-classes/3.4.0/json) |
| jaraco-context | 6.1.2 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/jaraco-context/6.1.2/json) |
| jaraco-functools | 4.6.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/jaraco-functools/4.6.0/json) |
| jeepney | 0.9.0 | sys_platform == 'linux' | MIT | [PyPI](https://pypi.org/pypi/jeepney/0.9.0/json) |
| jmespath | 1.1.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/jmespath/1.1.0/json) |
| jsonschema | 4.26.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/jsonschema/4.26.0/json) |
| jsonschema-specifications | 2025.9.1 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/jsonschema-specifications/2025.9.1/json) |
| keyring | 25.6.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/keyring/25.6.0/json) |
| mcp | 1.29.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/mcp/1.29.0/json) |
| more-itertools | 11.1.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/more-itertools/11.1.0/json) |
| psutil | 7.0.0 | all applicable platforms | BSD License | [PyPI](https://pypi.org/pypi/psutil/7.0.0/json) |
| pycparser | 3.0 | implementation_name != 'PyPy' and platform_python_implementation != 'PyPy' | BSD-3-Clause | [PyPI](https://pypi.org/pypi/pycparser/3.0/json) |
| pydantic | 2.13.5 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/pydantic/2.13.5/json) |
| pydantic-core | 2.46.5 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/pydantic-core/2.46.5/json) |
| pydantic-settings | 2.15.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/pydantic-settings/2.15.0/json) |
| pyjwt | 2.15.1 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/pyjwt/2.15.1/json) |
| python-dateutil | 2.9.0.post0 | all applicable platforms | Apache Software License; BSD License | [PyPI](https://pypi.org/pypi/python-dateutil/2.9.0.post0/json) |
| python-dotenv | 1.2.4 | all applicable platforms | BSD-3-Clause | [PyPI](https://pypi.org/pypi/python-dotenv/1.2.4/json) |
| python-multipart | 0.0.32 | all applicable platforms | Apache-2.0 | [PyPI](https://pypi.org/pypi/python-multipart/0.0.32/json) |
| pywin32 | 312 | sys_platform == 'win32' | Python Software Foundation License | [PyPI](https://pypi.org/pypi/pywin32/312/json) |
| pywin32-ctypes | 0.2.3 | sys_platform == 'win32' | BSD-3-Clause | [PyPI](https://pypi.org/pypi/pywin32-ctypes/0.2.3/json) |
| referencing | 0.37.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/referencing/0.37.0/json) |
| rpds-py | 0.30.0 | python_full_version < '3.11' | MIT | [PyPI](https://pypi.org/pypi/rpds-py/0.30.0/json) |
| rpds-py | 2026.9.1 | python_full_version >= '3.11' | MIT | [PyPI](https://pypi.org/pypi/rpds-py/2026.9.1/json) |
| s3transfer | 0.19.2 | all applicable platforms | Apache Software License | [PyPI](https://pypi.org/pypi/s3transfer/0.19.2/json) |
| secretstorage | 3.5.0 | sys_platform == 'linux' | BSD-3-Clause | [PyPI](https://pypi.org/pypi/secretstorage/3.5.0/json) |
| six | 1.17.0 | all applicable platforms | MIT License | [PyPI](https://pypi.org/pypi/six/1.17.0/json) |
| sse-starlette | 3.5.0 | all applicable platforms | BSD-3-Clause | [PyPI](https://pypi.org/pypi/sse-starlette/3.5.0/json) |
| starlette | 1.7.0 | all applicable platforms | BSD-3-Clause | [PyPI](https://pypi.org/pypi/starlette/1.7.0/json) |
| typing-extensions | 4.16.0 | all applicable platforms | PSF-2.0 | [PyPI](https://pypi.org/pypi/typing-extensions/4.16.0/json) |
| typing-inspection | 0.4.4 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/typing-inspection/0.4.4/json) |
| urllib3 | 2.8.0 | all applicable platforms | MIT | [PyPI](https://pypi.org/pypi/urllib3/2.8.0/json) |
| uvicorn | 0.54.0 | sys_platform != 'emscripten' | BSD-3-Clause | [PyPI](https://pypi.org/pypi/uvicorn/0.54.0/json) |
| zipp | 4.1.1 | python_full_version < '3.12' | MIT | [PyPI](https://pypi.org/pypi/zipp/4.1.1/json) |

## Reproducible inputs

- npm lock SHA-256: `15e2d7bb0a2a44bcc55b583d776b14a62154814d5637d746fc90d5bcdd1ed087`.
- Python lock SHA-256: `92294d14714190de1b3ef749678e5373f44e1551d2118d6638b572d37f81aa5f`.
- Exact PyPI metadata retrieved for 51 of 51 entries; failures are retained in the machine inventory.
- Version/source verification is not evidence of a platform installation, MCP client connection or remote file-bridge acceptance test.
