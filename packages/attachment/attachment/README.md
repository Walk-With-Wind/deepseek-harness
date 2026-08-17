# @deepseek-ai/dsh-attachment

English | [中文](README.zh.md)

The durable attachment seam. `ctx.attachments` validates and atomically commits immutable image bytes, then returns a serializable `ImageAttachmentRef`; consumers never persist browser paths, object URLs, provider URLs, or base64 in session events.

Unsent composer images remain browser-owned temporary drafts. `prepareImages` consumes exact-length sources in order, validates the complete batch before publication, and returns an explicit commit/dispose handle; the default implementation preserves compatibility for providers that only implement the single-image methods, while storage providers can stage directly to disk. `saveImage` remains the single-image entry. Both paths commit accepted bytes before any model-visible session event is published. `readImage` verifies canonical bytes against the logged reference, while `readImagePreview` returns a UI-only derivative without minting another durable attachment. Callers may cancel reads; implementations preserve cancellation instead of translating it into a storage failure.

## Model Experience

Indirectly, through the role-neutral core `ImageBlock` and provider adapters that resolve its durable reference.

#### KV Cache effect

Adding an image changes the provider request and therefore invalidates the affected request suffix.

## Known Limitations and Deferred Work

- Version one accepts PNG, JPEG, WebP, and GIF only.
- Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects.
- Generic files, audio, video, and persistent unsent drafts require separate lifecycle and provider contracts.
