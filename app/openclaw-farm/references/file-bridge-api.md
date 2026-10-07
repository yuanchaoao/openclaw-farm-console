# File bridge V2 and MCP

Actual scripts define the interface. MCP exposes 17 tools. See [MCP](../../../docs/mcp-tools.md) and [HTTP/CLI](../../../docs/api.md).

Workspace paths are bounded. Client scoped tokens use native credentials; server secrets are owner-only outside the exposed workspace. Loopback binding and write/delete modes are separate.

Uploads create IDs, append at exact returned offsets and commit verified size/hash. Downloads resume through Range. Replacement requires current SHA-256. Do not use non-atomic legacy transfers or edit status to manufacture health.

Registry: [example](../../../examples/instances.example.json). Actual status stays unverified until current path/file acceptance.
