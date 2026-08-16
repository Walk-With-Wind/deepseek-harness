/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
  IMAGE_PREVIEW_MAX_EDGE,
  validateImageStreamBatch,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentPreview,
  ImageAttachmentRef,
  PreparedImageAttachmentBatch,
  SaveImageAttachment,
  StreamImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { detectImage, probeImage, renderImagePreviewFile } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

function previewPath(root: string, sha256: string): string {
  return join(root, 'previews', `${sha256}.webp`)
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  maxPixels?: number,
): Promise<Omit<ImageAttachmentRef, 'attachmentId' | 'name'>> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, maxPixels)
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return { ...detected, bytes: data.byteLength }
}

/**
 * Run the full admission policy for one image without touching storage.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns completion after the encoded raster has been fully decoded.
 */
export async function validateImageFile(input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<void> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels)
}

/**
 * Make a directory's entries durable (fsync on a read-only directory handle).
 * A synced file alone does not survive a crash when its directory entry never
 * reached storage, so the publication directory is synced before a durable
 * reference is reported.
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
    if (parent === level) return
    level = parent
  }
}

/**
 * Establish this process's proof that one DSH_HOME entry and every ancestor
 * below the filesystem root are durable. Mere existence is insufficient: a
 * concurrent process may have created the directory but not synced its parent.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

interface StagedImage {
  readonly temporary: string
  readonly previewTemporary: string
  readonly sha256: string
  readonly ref: ImageAttachmentRef
}

/** 幂等清理尚未发布的临时文件；文件已不存在视为清理完成。 */
async function unlinkTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

/** 同时清理一张图片的规范字节与派生预览暂存文件。 */
async function unlinkStaged(image: StagedImage): Promise<void> {
  await Promise.all([
    unlinkTemporary(image.temporary),
    unlinkTemporary(image.previewTemporary),
  ])
}

/** 处理短写，直至当前分片全部写入文件句柄。 */
async function writeChunk(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset))
    if (bytesWritten === 0) throw new Error('attachment staging write made no progress')
    offset += bytesWritten
  }
}

/** 以仅所有者可访问的权限创建并同步一个不可覆盖文件。 */
async function writePrivateFile(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await writeChunk(handle, data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 把一个精确长度图片源写入暂存区，并在同一次完整解码中生成预览与持久引用。 */
async function stageImage(
  staging: string,
  input: StreamImageAttachment,
  limits: ImageAttachmentLimits,
): Promise<StagedImage> {
  const temporary = join(staging, randomUUID())
  const previewTemporary = join(staging, `${randomUUID()}.webp`)
  const hash = createHash('sha256')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let received = 0
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    for await (const chunk of input.chunks) {
      if (chunk.byteLength === 0) continue
      if (chunk.byteLength > input.bytes - received) {
        throw new AttachmentError('Image stream does not match its declared byte length.', 'IMAGE_LENGTH_MISMATCH')
      }
      await writeChunk(handle, chunk)
      hash.update(chunk)
      received += chunk.byteLength
    }
    if (received !== input.bytes) {
      throw new AttachmentError('Image stream does not match its declared byte length.', 'IMAGE_LENGTH_MISMATCH')
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    // 准入的完整解码同时产出小预览，避免消息落盘后再次扫描原图。
    const preview = await renderImagePreviewFile(
      temporary,
      IMAGE_PREVIEW_MAX_EDGE,
      limits.maxImagePixels,
    )
    if (preview.source.mediaType !== input.mediaType) {
      throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
    }
    await writePrivateFile(previewTemporary, preview.data)
    const sha256 = hash.digest('hex')
    const name = displayName(input.name)
    return {
      temporary,
      previewTemporary,
      sha256,
      ref: {
        attachmentId: AttachmentId(`sha256:${sha256}`),
        ...preview.source,
        bytes: input.bytes,
        ...(name === undefined ? {} : { name }),
      },
    }
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (closeError) {
        throw new AttachmentError('Unable to close staged image attachment.', 'ATTACHMENT_WRITE_FAILED', {
          cause: new AggregateError([error, closeError]),
        })
      }
    }
    try {
      await Promise.all([unlinkTemporary(temporary), unlinkTemporary(previewTemporary)])
    } catch (cleanupError) {
      throw new AttachmentError('Unable to clean staged image attachment.', 'ATTACHMENT_WRITE_FAILED', {
        cause: new AggregateError([error, cleanupError]),
      })
    }
    throw error
  }
}

/** 流式计算文件摘要，避免为去重校验重新分配完整对象缓冲区。 */
async function digestFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

/**
 * 把一批图片顺序写入私有暂存区并完成准入，显式提交前不发布内容寻址对象。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param inputs - 带精确长度的一次性图片字节源。
 * @param limits - 当前部署解析后的图片准入限制。
 * @returns 可提交或清理的已准入批次。
 */
export async function prepareImageFiles(
  root: string,
  inputs: readonly StreamImageAttachment[],
  limits: ImageAttachmentLimits,
): Promise<PreparedImageAttachmentBatch> {
  validateImageStreamBatch(inputs, limits)
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  const objects = join(root, 'objects')
  const previews = join(root, 'previews')
  const staging = join(root, 'tmp')
  await ensureDurableDirectory(objects, boundary)
  await ensureDurableDirectory(previews, boundary)
  await ensureDurableDirectory(staging, boundary)
  const staged: StagedImage[] = []
  try {
    for (const input of inputs) staged.push(await stageImage(staging, input, limits))
  } catch (error) {
    try {
      await Promise.all(staged.map(unlinkStaged))
    } catch (cleanupError) {
      throw new AttachmentError('Unable to clean rejected image batch.', 'ATTACHMENT_WRITE_FAILED', {
        cause: new AggregateError([error, cleanupError]),
      })
    }
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to stage image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  let committed: readonly ImageAttachmentRef[] | undefined
  let disposePromise: Promise<void> | undefined
  return {
    commit: async () => {
      if (disposePromise !== undefined) {
        throw new AttachmentError('Prepared image batch is already disposed.', 'ATTACHMENT_BATCH_DISPOSED')
      }
      if (committed !== undefined) return committed
      try {
        const buckets = new Set<string>()
        for (const item of staged) {
          const bucket = join(objects, item.sha256.slice(0, 2))
          buckets.add(bucket)
          await ensureDurableDirectory(bucket, boundary)
        }
        for (const item of staged) {
          const target = objectPath(root, item.sha256)
          try {
            await link(item.temporary, target)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
            if (await digestFile(target) !== item.sha256) {
              throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
            }
          }
        }
        for (const item of staged) {
          try {
            await link(item.previewTemporary, previewPath(root, item.sha256))
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
          }
        }
        for (const bucket of buckets) await syncDirectory(bucket)
        await syncDirectory(objects)
        await syncDirectory(previews)
        committed = Object.freeze(staged.map(item => item.ref))
        return committed
      } catch (error) {
        if (error instanceof AttachmentError) throw error
        throw new AttachmentError('Unable to persist image attachment batch.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
      }
    },
    dispose: () => {
      disposePromise ??= Promise.all(staged.map(unlinkStaged)).then(() => undefined)
      return disposePromise
    },
  }
}

/**
 * Save and verify immutable image bytes below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns durable content-addressed reference.
 */
export async function saveImageFile(root: string, input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<ImageAttachmentRef> {
  if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  const metadata = await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels)
  const sha256 = digest(input.data)
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  // Establish DSH_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = objectPath(root, sha256)
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(input.data)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    // Persist the target entry and close a concurrent bucket-creation window
    // before the reference can reach a session checkpoint. The dedup path
    // repeats both syncs because it may observe another writer's link before
    // that writer reaches its own durability boundary.
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
    await unlink(temporary)
  } catch (error) {
    /* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
      () => {},
    )
    await unlink(temporary).catch(
      /* v8 ignore next -- The callback requires a second independent staging-unlink failure. */
      (cleanupError: unknown) => {
        /* v8 ignore next -- Cleanup is best-effort only for a staging file already removed by a failed operation. */
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
      },
    )
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  const name = displayName(input.name)
  return {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    ...metadata,
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}

/**
 * 优先读取准入阶段生成的有界 WebP；旧对象核验原图摘要后按需派生。
 * @param root - 绝对的 `DSH_HOME/attachments/v1` 根目录。
 * @param ref - 会话日志中的持久附件引用。
 * @param maxEdge - 输出最长边像素数。
 * @param signal - 可选的读取取消信号。
 * @returns 不产生新持久引用、只供界面使用的派生图片字节。
 */
export async function readImagePreviewFile(
  root: string,
  ref: ImageAttachmentRef,
  maxEdge: number,
  signal?: AbortSignal,
): Promise<ImageAttachmentPreview> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxEdge) || maxEdge <= 0) {
    throw new AttachmentError('Image preview edge is invalid.', 'ATTACHMENT_READ_FAILED')
  }
  const sha256 = ensureReference(ref)
  if (maxEdge === IMAGE_PREVIEW_MAX_EDGE) {
    try {
      const data = new Uint8Array(await readFile(previewPath(root, sha256), { signal }))
      const metadata = await probeImage(data)
      if (metadata.mediaType !== 'image/webp'
        || metadata.width > maxEdge || metadata.height > maxEdge) {
        throw new AttachmentError('Stored attachment preview is invalid.', 'ATTACHMENT_CORRUPT')
      }
      return { mediaType: 'image/webp', data }
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        if (error instanceof AttachmentError && error.code === 'ATTACHMENT_CORRUPT') throw error
        throw new AttachmentError('Unable to read image attachment preview.', 'ATTACHMENT_READ_FAILED', { cause: error })
      }
      // 旧对象没有派生预览时回退到一次性生成，保持已有历史可读。
    }
  }
  const path = objectPath(root, sha256)
  let actualDigest: string
  try {
    actualDigest = await digestFile(path, signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  if (actualDigest !== sha256) {
    throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
  const preview = await renderImagePreviewFile(path, maxEdge)
  signal?.throwIfAborted()
  if (preview.source.mediaType !== ref.mediaType
    || preview.source.width !== ref.width
    || preview.source.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { mediaType: 'image/webp', data: preview.data }
}
