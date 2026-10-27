# Encrypted library backups

Settings offers **Create encrypted backup**, a normal browser download, and
**Validate backup** followed by **Replace library** or **Keep current library**.
No replacement occurs during validation. Cancel stops validation, including after the upload has finished. Downloads and validated restore tickets
expire after ten minutes. Passwords are used in memory and are never saved in
settings, files, URLs or logs. Keep the passphrase: the app cannot recover it.

## Encryption and payload

The maintained [Typage implementation](https://github.com/FiloSottile/typage),
published as `age-encryption`, implements the standard
[age format](https://age-encryption.org/v1). Production exports use its default
scrypt work factor of 18 and authenticated streaming encryption. Restore bounds
the header and scrypt work before running password derivation. Lower work factors
are injected only in local tests; there is no user setting that weakens exports.
The cryptographic format and algorithms are supplied by that library.

The encrypted payload is an ordinary TAR stream containing `manifest.json`,
`reader.sqlite`, and owned cached files and metadata under `media/`. The manifest
records each file's exact name, length and SHA-256 checksum. It has a 32 MiB parser
safety bound. Only those explicit names and regular files are accepted: no path
traversal, absolute paths, links, extra files or duplicate entries. TAR packaging
uses `tar-stream`; extraction writes files explicitly into a private staging
directory rather than handing uploaded paths to a filesystem extractor.

Backups include posts, observations, saved discussions, subscriptions, history
checkpoints, preferences, deletion exclusions and read states. Unfinished work
stays unfinished. Browser profiles, cookies and credentials are excluded. The destination storage cap is kept when restoring, rather than replaced by the saved quota. Restore
clears the saved account binding and access pause, so the destination browser's
visible account is verified on the next explicit collection. It starts no network
work. Media not already downloaded remains unfinished or unavailable.

## Consistency, staging and recovery

Creating a backup pauses collection and blocks concurrent writes. SQLite's
backup API creates a consistent database snapshot; owned media is streamed from
the quiesced cache. File contents are never assembled as one large memory buffer.
The browser downloads the encrypted output directly; the UI does not load the
whole backup into a JavaScript Blob. Temporary space is needed for the database
snapshot and encrypted output. The plaintext snapshot is removed once encryption
finishes; the encrypted download remains for ten minutes or until app shutdown.

Restore writes decrypted data only into a private directory. It checks the whole
age stream, including its authenticated final chunk, file checksums, database
schema and integrity, post references and media ownership before issuing a
confirmation ticket. Wrong passwords, tampering, truncation, unsafe entries and
incompatible libraries leave the current content intact. Published schema-3 backups are validated first, then upgraded only in staging to schema 4; the search index is rebuilt from accepted content. The upgraded size is checked against the current cap. The current storage cap
must fit the restored database and media; raise it before validating a larger
backup. Temporary restore space is additional to the existing library.

Confirmed replacement pauses all collection and takes a rollback database
snapshot. The previous media directory stays available until the replacement
database transaction and cache reload succeed. A durable recovery marker records
the operation; startup rolls an interrupted, unacknowledged replacement back
before opening SQLite. Successful replacement compacts the previous database allocation and removes the rollback copy. Compaction failure is reported as a warning; restored content is retained. A failed
rollback blocks library access and retains recovery material for the next
startup. This handles application interruption; it is not a filesystem-wide
power-loss atomicity guarantee. Browser profiles remain in place throughout.

Temporary plaintext staging and the live library are not encrypted at rest.
Live-library encryption remains the separate, deferred feature.
