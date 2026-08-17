/** 二进制 Prompt 上传的浏览器安全编码与 Host 解码。 */
import { z } from 'zod'
import type {
  PromptStreamContentPart,
  PromptStreamPayload,
  PromptUploadContentPart,
  PromptUploadPayload,
} from '../api/sessions.ts'
import { imageMediaTypeSchema, sessionIdSchema } from '../api/sessions.schema.ts'
import type { RpcId, RpcRequest } from '../api/rpc.ts'
import { rpcIdSchema } from '../api/rpc.schema.ts'

/** 二进制 Prompt 的固定 Fetch 路径。 */
export const PROMPT_UPLOAD_PATH = '/api/session.prompt-upload'

/** 非简单请求媒体类型；Web 跨源调用必须先通过预检。 */
export const PROMPT_UPLOAD_CONTENT_TYPE = 'application/vnd.deepseek-harness.prompt-upload'

/** Manifest 的协议版本。 */
export const PROMPT_UPLOAD_VERSION = 1

/** Manifest 固定安全上限；正文与文件名不得借元数据绕过请求体背压。 */
export const PROMPT_UPLOAD_MAX_MANIFEST_BYTES = 64 * 1024

/** Manifest 长度使用的无符号 32 位大端前缀。 */
export const PROMPT_UPLOAD_LENGTH_PREFIX_BYTES = 4

/** 不含原始图片的二进制 Prompt 请求体最大固定开销。 */
export const PROMPT_UPLOAD_MAX_OVERHEAD_BYTES
  = PROMPT_UPLOAD_LENGTH_PREFIX_BYTES + PROMPT_UPLOAD_MAX_MANIFEST_BYTES

interface PromptUploadManifest {
  readonly version: typeof PROMPT_UPLOAD_VERSION
  readonly rpcId: RpcId
  readonly payload: {
    readonly sessionId: PromptUploadPayload['sessionId']
    readonly mode: PromptUploadPayload['mode']
    readonly content: readonly PromptUploadManifestPart[]
    readonly clientTimeZone?: string
  }
}

type PromptUploadManifestPart =
  | Extract<PromptUploadContentPart, { type: 'text' }>
  | {
    readonly type: 'image'
    readonly mediaType: Extract<PromptUploadContentPart, { type: 'image' }>['source']['mediaType']
    readonly bytes: number
    readonly name?: string
  }

const manifestPartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({
    type: z.literal('image'),
    mediaType: imageMediaTypeSchema,
    bytes: z.number().int().positive(),
    name: z.string().optional(),
  }),
])

const manifestSchema = z.strictObject({
  version: z.literal(PROMPT_UPLOAD_VERSION),
  rpcId: rpcIdSchema,
  payload: z.strictObject({
    sessionId: sessionIdSchema,
    mode: z.union([z.literal('queue'), z.literal('steer')]),
    content: z.array(manifestPartSchema),
    clientTimeZone: z.string().optional(),
  }),
}) as unknown as z.ZodType<PromptUploadManifest>

/** 二进制 Prompt 请求体的编码结果。 */
export interface EncodedPromptUpload {
  /** Manifest 长度前缀、Manifest 与原始图片组成的拉取式正文。 */
  readonly body: ReadableStream<Uint8Array>
  /** 可用于受信载体声明长度的精确正文大小。 */
  readonly byteLength: number
}

function manifestOf(rpcId: RpcId, payload: PromptUploadPayload): PromptUploadManifest {
  return {
    version: PROMPT_UPLOAD_VERSION,
    rpcId,
    payload: {
      sessionId: payload.sessionId,
      mode: payload.mode,
      content: payload.content.map((part): PromptUploadManifestPart => part.type === 'text'
        ? part
        : {
          type: 'image',
          mediaType: part.source.mediaType,
          bytes: part.source.bytes,
          ...part.source.name === undefined ? {} : { name: part.source.name },
        }),
      ...payload.clientTimeZone === undefined ? {} : { clientTimeZone: payload.clientTimeZone },
    },
  }
}

function checkedBodyLength(manifestBytes: number, content: readonly PromptUploadContentPart[]): number {
  let total = PROMPT_UPLOAD_LENGTH_PREFIX_BYTES + manifestBytes
  for (const part of content) {
    if (part.type === 'text') continue
    if (!Number.isSafeInteger(part.source.bytes) || part.source.bytes <= 0) {
      throw new Error('prompt upload: 图片声明字节数必须是正安全整数')
    }
    total += part.source.bytes
    if (!Number.isSafeInteger(total)) throw new Error('prompt upload: 请求体长度超出安全整数范围')
  }
  return total
}

/**
 * 把图片源编码为小型 JSON Manifest 加连续原始字节，不累计完整请求体。
 * @param rpcId - 本次 Prompt 的关联标识。
 * @param payload - 文本、图片源与投递元数据。
 * @returns 拉取式正文及其精确总长度。
 */
export function encodePromptUpload(rpcId: RpcId, payload: PromptUploadPayload): EncodedPromptUpload {
  const encoder = new TextEncoder()
  const manifest = encoder.encode(JSON.stringify(manifestOf(rpcId, payload)))
  if (manifest.byteLength > PROMPT_UPLOAD_MAX_MANIFEST_BYTES) {
    throw new Error('prompt upload: Manifest 超过 64 KiB 上限')
  }
  const prefix = new Uint8Array(PROMPT_UPLOAD_LENGTH_PREFIX_BYTES)
  new DataView(prefix.buffer).setUint32(0, manifest.byteLength)
  const preface = [prefix, manifest]
  const imageParts = payload.content.filter(
    (part): part is Extract<PromptUploadContentPart, { type: 'image' }> => part.type === 'image',
  )
  const byteLength = checkedBodyLength(manifest.byteLength, payload.content)
  let prefaceIndex = 0
  let imageIndex = 0
  let imageRemaining = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const header = preface[prefaceIndex]
        if (header !== undefined) {
          prefaceIndex += 1
          controller.enqueue(header)
          return
        }
        const image = imageParts[imageIndex]
        if (image === undefined) {
          controller.close()
          return
        }
        if (reader === undefined) {
          reader = image.source.stream().getReader()
          imageRemaining = image.source.bytes
        }
        const item = await reader.read()
        if (item.done) {
          if (imageRemaining !== 0) throw new Error('prompt upload: 图片流早于声明长度结束')
          reader.releaseLock()
          reader = undefined
          imageIndex += 1
          continue
        }
        if (item.value.byteLength === 0) continue
        if (item.value.byteLength > imageRemaining) {
          throw new Error('prompt upload: 图片流超过声明长度')
        }
        imageRemaining -= item.value.byteLength
        controller.enqueue(item.value)
        return
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return { body, byteLength }
}

/** 二进制请求体不是合法 Manifest、长度不符或存在尾随字节。 */
export class PromptUploadDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptUploadDecodeError'
  }
}

class PromptUploadReader {
  private remainder: Uint8Array | undefined
  private nextImageIndex = 0
  private activeImageIndex: number | undefined
  private ended = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** 读取确切长度；只为当前图片分配一次目标缓冲区。 */
  async exact(bytes: number): Promise<Uint8Array> {
    const target = new Uint8Array(bytes)
    let offset = 0
    while (offset < bytes) {
      const chunk = await this.availableChunk()
      const take = Math.min(chunk.byteLength, bytes - offset)
      target.set(chunk.subarray(0, take), offset)
      offset += take
      this.remainder = take === chunk.byteLength ? undefined : chunk.subarray(take)
    }
    return target
  }

  /** 取得当前剩余或下一段非空正文，尚不移动消费位置。 */
  private async availableChunk(): Promise<Uint8Array> {
    while (this.remainder === undefined) {
      const item = await this.reader.read()
      if (item.done) throw new PromptUploadDecodeError('prompt upload: 请求体提前结束')
      if (item.value.byteLength > 0) this.remainder = item.value
    }
    return this.remainder
  }

  private async chunk(maxBytes: number): Promise<Uint8Array> {
    const chunk = await this.availableChunk()
    const take = Math.min(chunk.byteLength, maxBytes)
    this.remainder = take === chunk.byteLength ? undefined : chunk.subarray(take)
    return chunk.subarray(0, take)
  }

  /** 为一个 Manifest 图片建立严格顺序、一次性消费的字节源。 */
  image(bytes: number, index: number): AsyncIterable<Uint8Array> {
    let opened = false
    return {
      [Symbol.asyncIterator]: () => {
        if (opened) throw new PromptUploadDecodeError('prompt upload: 图片字节源不能重复消费')
        if (this.ended || this.disposePromise !== undefined
          || this.activeImageIndex !== undefined || this.nextImageIndex !== index) {
          throw new PromptUploadDecodeError('prompt upload: 图片字节源消费顺序非法')
        }
        opened = true
        this.activeImageIndex = index
        let remaining = bytes
        let done = false
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            if (done) return { done: true, value: undefined }
            if (remaining === 0) {
              done = true
              this.activeImageIndex = undefined
              this.nextImageIndex += 1
              return { done: true, value: undefined }
            }
            const value = await this.chunk(remaining)
            remaining -= value.byteLength
            return { done: false, value }
          },
          return: async (): Promise<IteratorResult<Uint8Array>> => {
            done = true
            await this.dispose(new PromptUploadDecodeError('prompt upload: 图片字节源未完整消费'))
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  /** 证明最后一个声明图片之后不存在未声明字节。 */
  async end(imageCount: number): Promise<void> {
    if (this.activeImageIndex !== undefined || this.nextImageIndex !== imageCount) {
      throw new PromptUploadDecodeError('prompt upload: 图片字节源尚未完整消费')
    }
    if (this.remainder !== undefined && this.remainder.byteLength > 0) {
      throw new PromptUploadDecodeError('prompt upload: 请求体包含尾随字节')
    }
    while (true) {
      const item = await this.reader.read()
      if (item.done) {
        this.ended = true
        return
      }
      if (item.value.byteLength > 0) throw new PromptUploadDecodeError('prompt upload: 请求体包含尾随字节')
    }
  }

  /** 取消未消费正文并释放 reader 锁；正常结束与重复调用均安全。 */
  dispose(reason?: unknown): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        if (!this.ended) await this.reader.cancel(reason)
      } finally {
        this.reader.releaseLock()
      }
    })()
    return this.disposePromise
  }
}

/**
 * 解码 Manifest 和连续图片字节；正文始终由 Request 的 reader 按需读取。
 * @param body - 二进制 Prompt 请求体。
 * @returns 可直接交给 SessionsApi 的关联请求。
 */
export async function decodePromptUpload(body: ReadableStream<Uint8Array>): Promise<RpcRequest<PromptStreamPayload>> {
  const reader = body.getReader()
  const source = new PromptUploadReader(reader)
  try {
    const prefix = await source.exact(PROMPT_UPLOAD_LENGTH_PREFIX_BYTES)
    const manifestLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0)
    if (manifestLength === 0 || manifestLength > PROMPT_UPLOAD_MAX_MANIFEST_BYTES) {
      throw new PromptUploadDecodeError('prompt upload: Manifest 长度非法')
    }
    let parsed: PromptUploadManifest
    try {
      parsed = manifestSchema.parse(JSON.parse(new TextDecoder().decode(await source.exact(manifestLength))))
    } catch (error) {
      throw new PromptUploadDecodeError(`prompt upload: Manifest 非法：${String(error)}`)
    }
    const content: PromptStreamContentPart[] = []
    let imageIndex = 0
    for (const part of parsed.payload.content) {
      if (part.type === 'text') {
        content.push(part)
        continue
      }
      content.push({
        type: 'image',
        source: {
          chunks: source.image(part.bytes, imageIndex),
          bytes: part.bytes,
          mediaType: part.mediaType,
          ...part.name === undefined ? {} : { name: part.name },
        },
      })
      imageIndex += 1
    }
    return {
      rpcId: parsed.rpcId,
      payload: {
        sessionId: parsed.payload.sessionId,
        mode: parsed.payload.mode,
        content,
        ...parsed.payload.clientTimeZone === undefined ? {} : { clientTimeZone: parsed.payload.clientTimeZone },
        completeBody: () => source.end(imageIndex),
        disposeBody: reason => source.dispose(reason),
      },
    }
  } catch (error) {
    try {
      await source.dispose(error)
    } catch {
      // Manifest 解析错误是主失败；取消 reader 的次生异常不能覆盖可诊断的 400 原因。
    }
    throw error
  }
}
