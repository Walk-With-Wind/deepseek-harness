/** Raster inspection: full decode at admission, header-only probe on verified reads. */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

// Utility 按请求完成完整解码，不保留 libvips 跨请求缓存，避免批量附件使原生 RSS 单调累积。
sharp.cache(false)

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

/** 从持久原图派生的界面预览及原图元数据。 */
export interface RenderedImagePreview {
  readonly source: DetectedImage
  readonly data: Uint8Array
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  return { mediaType, width: metadata.width, height: metadata.height }
}

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  try {
    return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false }))
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/**
 * Fully decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param maxPixels - decoded-pixel admission limit.
 * @returns verified format and dimensions.
 */
async function decodeImage(input: Uint8Array | string, maxPixels?: number): Promise<DetectedImage> {
  try {
    const image = sharp(input, { failOn: 'error', limitInputPixels: false })
    const detected = await imageMetadata(image)
    if (maxPixels !== undefined && detected.width * detected.height > maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    // 丢弃解码块而不是聚合完整像素缓冲区，使准入内存只随解码流水线窗口增长。
    for await (const chunk of image.raw()) void chunk
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/**
 * 完整解码内存中的图片并返回已核验元数据。
 * @param data - 完整编码图片字节。
 * @param maxPixels - 解码像素数量上限。
 * @returns 已核验的格式和尺寸。
 */
export function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  return decodeImage(data, maxPixels)
}

/**
 * 从私有暂存文件完整解码图片，不把编码字节重新读入 JavaScript 堆。
 * @param path - 由附件存储创建并持有的暂存文件路径。
 * @param maxPixels - 解码像素数量上限。
 * @returns 已核验的格式和尺寸。
 */
export function detectImageFile(path: string, maxPixels?: number): Promise<DetectedImage> {
  return decodeImage(path, maxPixels)
}

/**
 * 直接从私有内容寻址文件生成 WebP 预览，不先把原始编码正文读入 JavaScript 堆。
 * @param path - 已通过内容摘要校验的附件对象路径。
 * @param maxEdge - 输出最长边像素数。
 * @param maxPixels - 解码像素数量上限。
 * @returns 原图元数据与有界 WebP 字节。
 */
export async function renderImagePreviewFile(
  path: string,
  maxEdge: number,
  maxPixels?: number,
): Promise<RenderedImagePreview> {
  try {
    const image = sharp(path, { failOn: 'error', limitInputPixels: false })
    const source = await imageMetadata(image)
    if (maxPixels !== undefined && source.width * source.height > maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    const data = await image
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
    return { source, data: new Uint8Array(data) }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
