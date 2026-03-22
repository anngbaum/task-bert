# TODO

## Image Metadata Support

### Level 1 — Attachment Metadata (sync metadata only, no file copying)

- [ ] Add `attachment` table to PGLite schema:
  - `id` (INTEGER PRIMARY KEY — maps to ROWID)
  - `guid` (TEXT UNIQUE)
  - `filename` (TEXT — original path in `~/Library/Messages/Attachments/`)
  - `mime_type` (TEXT)
  - `uti` (TEXT — Apple's Uniform Type Identifier)
  - `total_bytes` (INTEGER)
  - `transfer_name` (TEXT — human-readable filename like `Screenshot 2026-03-13 at 17.32.10.png`)
  - `is_sticker` (BOOLEAN)
  - `transfer_state` (INTEGER — 5 = available locally, 0 = in-flight)
- [ ] Add `message_attachment_join` table (`message_id`, `attachment_id`)
- [ ] Add `extractAttachments()` and `extractMessageAttachmentJoins()` to `src/etl/extract.ts`
- [ ] Add `loadAttachments()` and `loadMessageAttachmentJoins()` to `src/etl/load.ts`
- [ ] Add `Attachment` and `MessageAttachmentJoin` interfaces to `src/types.ts`
- [ ] Wire into sync/ingest/resync commands
- [ ] Include attachment info in thread API responses (extend `ThreadMessage`)

### Level 2 — File Import (copy actual files into app data directory)

- [ ] Copy files from `~/Library/Messages/Attachments/` into `./data/attachments/` during sync
- [ ] Skip ephemeral temp-path attachments (`/var/folders/`) — they're transient transcoding intermediates
- [ ] Handle link previews: `.pluginPayloadAttachment` files are renamed JPEGs/PNGs — detect actual format and rename
- [ ] Consider HEIC → JPEG conversion for web-friendly display (imessage-exporter uses ImageMagick for this)
- [ ] Only copy attachments with `transfer_state = 5` (fully downloaded)
- [ ] Add API endpoint to serve attachment files

### Key Data Points from chat.db

- Attachment paths use hash-bucket structure: `~/Library/Messages/Attachments/<2char>/<2char>/<guid>/<filename>`
- Messages with only an image have `text = U+FFFC` (Object Replacement Character), already stripped by `transform.ts`

### Reference

- imessage-exporter's approach: https://github.com/ReagentX/imessage-exporter — offers `--copy-method` with `clone`/`basic`/`full`/`disabled` tiers and `--attachment-root` override for iOS backups
