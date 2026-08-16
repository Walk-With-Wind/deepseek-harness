/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentError } from './error.ts'
import type {
  ImageAttachmentLimits,
  ImageAttachmentPreview,
  ImageAttachmentRef,
  PreparedImageAttachmentBatch,
  SaveImageAttachment,
  StreamImageAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId } from './brand.ts'
export { AttachmentError } from './error.ts'
/** 历史列表预览的固定最长边，按 240px 展示尺寸提供双倍像素。 */
export const IMAGE_PREVIEW_MAX_EDGE = 480
export type {
  AttachmentId as AttachmentIdType,
  ImageAttachmentLimits,
  ImageAttachmentPreview,
  ImageAttachmentRef,
  ImageMediaType,
  ImageReadPurpose,
  PreparedImageAttachmentBatch,
  SaveImageAttachment,
  StreamImageAttachment,
  StoredImageAttachment,
} from './types.ts'

/**
 * 在读取正文前校验一批图片的声明数量与字节预算。
 * @param inputs - 带精确长度的图片字节源。
 * @param limits - 当前部署解析后的图片准入限制。
 * @returns 所有声明满足批次预算时正常返回。
 */
export function validateImageStreamBatch(
  inputs: readonly StreamImageAttachment[],
  limits: ImageAttachmentLimits,
): void {
  if (inputs.length > limits.maxImagesPerMessage) {
    throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
  }
  let totalBytes = 0
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      throw new AttachmentError('Image byte length is invalid.', 'IMAGE_LENGTH_MISMATCH')
    }
    if (input.bytes > limits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }
    totalBytes += input.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxMessageImageBytes) {
      throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
  }
}

async function collectStreamImage(input: StreamImageAttachment): Promise<SaveImageAttachment> {
  const data = new Uint8Array(input.bytes)
  let offset = 0
  for await (const chunk of input.chunks) {
    if (chunk.byteLength === 0) continue
    if (chunk.byteLength > data.byteLength - offset) {
      throw new AttachmentError('Image stream does not match its declared byte length.', 'IMAGE_LENGTH_MISMATCH')
    }
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== data.byteLength) {
    throw new AttachmentError('Image stream does not match its declared byte length.', 'IMAGE_LENGTH_MISMATCH')
  }
  return {
    data,
    mediaType: input.mediaType,
    ...input.name === undefined ? {} : { name: input.name },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * 顺序读取并校验一批图片，在显式提交前不发布任何对象。
   * 默认实现为仅实现单图 API 的 Provider 提供兼容语义；本地 Provider 会覆盖为磁盘暂存实现。
   * @param inputs - 带精确声明长度的一次性图片字节源。
   * @returns 可提交或清理的已准入批次。
   */
  async prepareImages(inputs: readonly StreamImageAttachment[]): Promise<PreparedImageAttachmentBatch> {
    validateImageStreamBatch(inputs, this.imageLimits)
    const buffered: SaveImageAttachment[] = []
    for (const input of inputs) {
      const value = await collectStreamImage(input)
      await this.validateImage(value)
      buffered.push(value)
    }
    let committed: readonly ImageAttachmentRef[] | undefined
    let disposed = false
    return {
      commit: async () => {
        if (disposed) throw new AttachmentError('Prepared image batch is already disposed.', 'ATTACHMENT_BATCH_DISPOSED')
        if (committed !== undefined) return committed
        const refs: ImageAttachmentRef[] = []
        for (const input of buffered) refs.push(await this.saveImage(input))
        committed = Object.freeze(refs)
        return committed
      },
      dispose: () => {
        disposed = true
        buffered.length = 0
        return Promise.resolve()
      },
    }
  }

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * 为界面读取一份最长边受限的图片预览。
   * 默认实现返回已核验原图，具备图像处理能力的 Provider 应覆盖以减少跨进程字节量。
   * @param ref - 会话日志中的持久附件引用。
   * @param maxEdge - 预览图允许的最长边像素数。
   * @param signal - 可选的读取取消信号。
   * @returns 不产生新持久引用的派生图片字节。
   */
  async readImagePreview(
    ref: ImageAttachmentRef,
    maxEdge: number,
    signal?: AbortSignal,
  ): Promise<ImageAttachmentPreview> {
    void maxEdge
    const stored = await this.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, data: stored.data }
  }
}

export default AttachmentStore
