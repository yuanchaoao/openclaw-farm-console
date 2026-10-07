# Transfer and sync

Use the verified bridge for workspace files. Gateway ACK/history is task control, not delivery evidence. Large/binary files use resumable transfers.

Confirm instance/destination/overwrite policy and old hash. Preserve uploadID/offset or partial download; verify final size/SHA-256. Sync requires explicit source, destination and conflict/deletion policy.

Optional fast_object_transfer.py uses the user's own S3-compatible storage through Boto3 with protected config, approved sharing, multipart integrity and cleanup. No provider credential or historical throughput guarantee is distributed.

See [files](../../../docs/files.md), [API](../../../docs/api.md).
