/** 附件原始字节读取路由的浏览器安全查询协议。 */
import type { AttachmentIdType, ImageAttachmentRef, ImageReadPurpose } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { attachmentIdSchema, sessionIdSchema } from '../api/sessions.schema.ts'
import type { RpcId } from '../api/rpc.ts'
import { rpcIdSchema } from '../api/rpc.schema.ts'

/** 经过会话引用授权的附件原始字节路径。 */
export const ATTACHMENT_BYTES_PATH = '/api/session.attachment-bytes'

/** 成功响应回显关联标识的受控响应头。 */
export const ATTACHMENT_BYTES_RPC_HEADER = 'x-dsh-rpc-id'

/** 480px WebP 预览的防御性正文上限。 */
export const ATTACHMENT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

/** 客户端已有的日志引用；用于校验响应媒体类型和精确长度。 */
export interface AttachmentBlobPayload {
  /** 附件所属会话。 */
  readonly sessionId: SessionId
  /** Host 日志投影返回的附件引用。 */
  readonly attachment: ImageAttachmentRef
  /** 列表缩略图或用户主动打开的原图。 */
  readonly purpose?: ImageReadPurpose
}

/** Renderer 可直接交给 Object URL 的附件值。 */
export interface AttachmentBlobValue {
  /** 经 Host 授权且与请求引用一致的附件描述。 */
  readonly attachment: ImageAttachmentRef
  /** 浏览器 Blob 存储中的原始内容。 */
  readonly data: Blob
}

/** Handler 读取的严格查询参数。 */
export const attachmentBytesQuerySchema = z.strictObject({
  rpcId: rpcIdSchema,
  sessionId: sessionIdSchema,
  attachmentId: attachmentIdSchema,
  purpose: z.enum(['thumbnail', 'original']),
})

/**
 * 构造只包含品牌标识的读取 URL，不把文件路径或内容放入查询。
 * @param base - 当前部署的可信服务根地址。
 * @param rpcId - 关联请求与响应的单次调用标识。
 * @param sessionId - 授权附件引用所属的会话标识。
 * @param attachmentId - 会话日志记录的不透明附件标识。
 * @param purpose - 缩略图或用户主动请求的原图读取用途。
 * @returns 可交给受控 Fetch 载体的附件读取 URL。
 */
export function attachmentBytesUrl(
  base: string,
  rpcId: RpcId,
  sessionId: SessionId,
  attachmentId: AttachmentIdType,
  purpose: ImageReadPurpose = 'original',
): URL {
  const url = new URL(ATTACHMENT_BYTES_PATH, base)
  url.searchParams.set('rpcId', rpcId)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('attachmentId', attachmentId)
  url.searchParams.set('purpose', purpose)
  return url
}
