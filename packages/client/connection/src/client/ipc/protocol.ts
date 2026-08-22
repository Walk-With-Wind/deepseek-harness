/**
 * Electron 数据端口的进程中立协议。该文件只描述结构化克隆帧与固定安全上限，
 * 不导入 Electron，也不承载业务 RPC schema。
 */
import { z } from 'zod'

/** 首版桌面数据端口协议。 */
export const IPC_DATA_PROTOCOL_VERSION = 1

/** 单个结构化克隆字节块的固定上限。 */
export const IPC_MAX_CHUNK_BYTES = 1024 * 1024

/** 请求体默认上限，与现有产品上传能力保持一致。 */
export const IPC_DEFAULT_MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

/** 默认并发请求上限，防止端口 registry 形成无界队列。 */
export const IPC_DEFAULT_MAX_IN_FLIGHT_REQUESTS = 64

/** 请求和响应 header 的默认累计 UTF-8 字节上限。 */
export const IPC_MAX_HEADER_BYTES = 64 * 1024

const generationSchema = z.number().int().nonnegative()
const idSchema = z.string().min(1).max(128)
const reasonSchema = z.string().max(512)
const headerSchema = z.tuple([z.string(), z.string()])
const headersSchema = z.array(headerSchema).max(128)

/** 跨 Renderer/Utility Realm 核验独占的普通 Uint8Array，拒绝共享或带外缓冲区。 */
function isIpcChunk(value: unknown): value is Uint8Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') return false
  const chunk = value as Uint8Array
  return Object.prototype.toString.call(chunk.buffer) === '[object ArrayBuffer]'
    && chunk.byteLength > 0
    && chunk.byteLength <= IPC_MAX_CHUNK_BYTES
    && chunk.byteOffset === 0
    && chunk.buffer.byteLength === chunk.byteLength
}

const chunkSchema = z.custom<Uint8Array<ArrayBuffer>>(
  isIpcChunk,
  `chunk 必须介于 1 与 ${String(IPC_MAX_CHUNK_BYTES)} 字节之间且独占等长 ArrayBuffer`,
)

/** 传输层稳定错误码；业务 HTTP 错误不进入此枚举。 */
export const ipcFailureCodeSchema = z.enum([
  'PROTOCOL_INVALID_FRAME',
  'PROTOCOL_VERSION',
  'PROTOCOL_GENERATION',
  'PROTOCOL_STATE',
  'PROTOCOL_PATH',
  'PROTOCOL_METHOD',
  'PROTOCOL_HEADER',
  'LIMIT_CHUNK',
  'LIMIT_HEADERS',
  'LIMIT_REQUEST_BODY',
  'LIMIT_IN_FLIGHT',
  'HOST_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'TRANSPORT_CLOSED',
])

/** 传输层稳定错误码。 */
export type IpcFailureCode = z.infer<typeof ipcFailureCodeSchema>

const failurePhaseSchema = z.enum(['handshake', 'request', 'response', 'protocol', 'close'])

const failureFields = {
  id: idSchema.optional(),
  code: ipcFailureCodeSchema,
  phase: failurePhaseSchema,
  retryable: z.boolean(),
  outcomeUnknown: z.boolean().optional(),
  message: z.string().min(1).max(512),
}

/** Renderer 与 Utility 之间的闭合数据帧联合。 */
export const ipcDataFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('data/hello'), protocolVersion: z.literal(IPC_DATA_PROTOCOL_VERSION), generation: generationSchema }),
  z.strictObject({ type: z.literal('data/ready'), protocolVersion: z.literal(IPC_DATA_PROTOCOL_VERSION), generation: generationSchema }),
  z.strictObject({
    type: z.literal('request'),
    generation: generationSchema,
    id: idSchema,
    method: z.enum(['GET', 'HEAD', 'POST']),
    path: z.string().min(1).max(8192),
    headers: headersSchema,
    hasBody: z.boolean(),
  }),
  z.strictObject({ type: z.literal('request-pull'), id: idSchema }),
  z.strictObject({ type: z.literal('request-chunk'), id: idSchema, sequence: z.number().int().nonnegative(), chunk: chunkSchema }),
  z.strictObject({ type: z.literal('request-end'), id: idSchema }),
  z.strictObject({ type: z.literal('request-cancel'), generation: generationSchema, id: idSchema, reason: reasonSchema }),
  z.strictObject({
    type: z.literal('response-head'),
    id: idSchema,
    status: z.number().int().min(100).max(599),
    headers: headersSchema,
    hasBody: z.boolean(),
  }),
  z.strictObject({ type: z.literal('response-pull'), id: idSchema }),
  z.strictObject({ type: z.literal('response-chunk'), id: idSchema, sequence: z.number().int().nonnegative(), chunk: chunkSchema }),
  z.strictObject({ type: z.literal('response-end'), id: idSchema }),
  z.strictObject({ type: z.literal('response-cancel'), id: idSchema, reason: reasonSchema }),
  z.strictObject({ type: z.literal('failure'), ...failureFields }),
  z.strictObject({ type: z.literal('port-close'), generation: generationSchema, reason: reasonSchema }),
])

/** 数据端口帧。 */
export type IpcDataFrame = z.infer<typeof ipcDataFrameSchema>

/** `failure` 帧的结构。 */
export type IpcFailureFrame = Extract<IpcDataFrame, { type: 'failure' }>

/** 最小 MessagePort 接口；Renderer 与 Utility 的 Electron 适配器只需提供这些成员。 */
export interface IpcMessagePort {
  /** 发送一个结构化克隆值。 */
  postMessage(message: unknown): void
  /** 订阅消息。 */
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  /** 取消消息订阅。 */
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  /** 开始投递已排队消息。 */
  start?(): void
  /** 订阅对端进程消失等物理关闭，并返回取消订阅函数。 */
  subscribeClose?(listener: () => void): () => void
  /** 关闭物理端口。 */
  close?(): void
}

/** IPC 传输错误，字段可安全跨 UI 层呈现或分类。 */
export class IpcTransportError extends Error {
  /**
   * @param code - 稳定传输错误码。
   * @param message - 已脱敏的诊断文本。
   * @param options - 重试、阶段与副作用结算状态。
   */
  constructor(
    readonly code: IpcFailureCode,
    message: string,
    readonly options: {
      readonly phase: IpcFailureFrame['phase']
      readonly retryable: boolean
      readonly outcomeUnknown?: boolean
    },
  ) {
    super(message)
    this.name = 'IpcTransportError'
  }
}

/**
 * 把失败帧恢复为本进程错误。
 * @param frame - 已通过 schema 校验的失败帧。
 * @returns 保留稳定分类和结算状态的传输错误。
 */
export function errorFromFailure(frame: IpcFailureFrame): IpcTransportError {
  return new IpcTransportError(frame.code, frame.message, {
    phase: frame.phase,
    retryable: frame.retryable,
    ...(frame.outcomeUnknown === undefined ? {} : { outcomeUnknown: frame.outcomeUnknown }),
  })
}

/**
 * 闭合联合的编译期穷尽检查。
 * @param value - 类型系统已经收窄为空集的值。
 * @returns 始终抛出协议实现错误。
 */
export function assertNever(value: never): never {
  throw new Error(`ipc carrier: 未处理的协议帧 ${JSON.stringify(value)}`)
}
