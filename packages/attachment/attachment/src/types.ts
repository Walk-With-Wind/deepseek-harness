/** Durable attachment vocabulary. @module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 会话授权读取的图片用途。 */
export type ImageReadPurpose = 'thumbnail' | 'original'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** 一张由 Host 顺序消费、但尚未持久化的图片字节源。 */
export interface StreamImageAttachment {
  /** 按需产生编码图片字节；实现只能消费一次。 */
  readonly chunks: AsyncIterable<Uint8Array>
  /** 字节源必须精确产生的编码长度。 */
  readonly bytes: number
  /** 调用方声明并由存储实现核验的图片媒体类型。 */
  readonly mediaType: ImageMediaType
  /** 可选展示名称；不得解释为本机路径。 */
  readonly name?: string
}

/** 已完成准入但尚未发布内容寻址对象的一批图片。 */
export interface PreparedImageAttachmentBatch {
  /**
   * 按输入顺序发布所有已校验图片。
   * @returns 可写入同一条会话消息的持久引用。
   */
  commit(): Promise<readonly ImageAttachmentRef[]>

  /**
   * 清除仍由本批次持有的暂存资源；允许重复调用。
   * @returns 清理完成后的 Promise。
   */
  dispose(): Promise<void>
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/** 为界面派生的图片字节；它不产生新的持久附件引用。 */
export interface ImageAttachmentPreview {
  /** 派生图片实际编码格式。 */
  readonly mediaType: ImageMediaType
  /** 可直接发送给受信客户端的编码字节。 */
  readonly data: Uint8Array
}
