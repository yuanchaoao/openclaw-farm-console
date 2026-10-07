# Bridge boundary

Run under the intended unprivileged identity, bind loopback, route through configured SSH or an already verified authenticated HTTPS gateway. Keep owner-only mode0600 non-symlink token files outside exposed data.

Separate read/write/delete scopes and modes. Preserve path bounds, symlink/hardlink/nested-mount rejection, atomic mutation and old-hash checks. Separate code/state/backups from exposed data.

Strict deployment uses an isolated mount. UI shared-workspace compatibility needs explicit task authorization and must be identified accurately. Test-only root/isolation bypass flags are not a production recipe.

Verify unauthenticated rejection, capabilities and authorized file operations/cleanup. See [architecture](../../../docs/architecture.md), [files](../../../docs/files.md), [relay](../../../docs/relay.md).
