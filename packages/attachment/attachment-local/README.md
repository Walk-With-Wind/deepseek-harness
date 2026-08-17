# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

The private local implementation of [`@deepseek-ai/dsh-attachment`](../attachment). Objects land at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>` and are addressed by an opaque `sha256:` id. Each process proves a home durable once by syncing every ancestor entry to the filesystem root, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes then use a private staging directory, owner-only files, synced temporary files, atomic exclusive hard-link publication, and directory syncs on the publication path (POSIX; Windows relies on filesystem metadata journaling) so the reported reference survives a crash. Batch admission streams one image at a time to staging and publishes nothing until every image is fully decoded and the caller commits. The same decode produces a bounded 480px WebP derivative below `previews/`; history lists can therefore avoid transferring or decoding the canonical image. The derivative is UI-only, and `readImage` remains the canonical digest and metadata verification path. Libvips caching is disabled in this Utility-owned provider so completed attachment requests do not retain batch-sized native memory. Byte and pixel limits are write-time admission policy, so a later policy reduction does not make already-admitted history unreadable.

`DSH_HOME` resolves through the shared path policy: explicit config, `$DSH_HOME`, then `~/.dsh`. Session logs contain only the reference and verified metadata, never this host path. `readImage` forwards optional cancellation into the filesystem read, observes it around verification, and preserves it instead of wrapping it as `ATTACHMENT_READ_FAILED`. Objects created through the older single-image path have no pre-generated derivative; `readImagePreview` derives one on demand without changing the durable reference.

## Model Experience

Indirectly, through durable replay of historical user images and structured model image output after restart and fork.

#### KV Cache effect

None beyond the image block owned by the requesting adapter.

## Known Limitations and Deferred Work

- Objects are retained indefinitely; reference-aware garbage collection is deferred.
- The local backend assumes the host and provider adapter share this filesystem service.
- Animated GIF metadata is validated from the logical screen; frame-level decoding policy is provider-owned.
