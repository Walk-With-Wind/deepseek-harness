/** IPC Renderer 与 Host 状态机共用的小型协议构造器。 */
import { ipcReasonText } from './validation.ts'
import {
  IPC_MAX_CHUNK_BYTES,
  IPC_DEFAULT_MAX_IN_FLIGHT_REQUESTS,
  IPC_DEFAULT_MAX_REQUEST_BODY_BYTES,
  IpcTransportError,
  ipcDataFrameSchema,
  type IpcDataFrame,
  type IpcFailureCode,
  type IpcFailureFrame,
  type IpcMessagePort,
} from './protocol.ts'

/**
 * 截取一个只拥有当前 IPC 块的字节数组，避免结构化克隆连同大块底层 ArrayBuffer 一起复制。
 * @param data - 上游 Reader 返回的字节视图。
 * @param offset - 当前块在视图中的起点。
 * @returns 长度不超过协议上限且底层缓冲区等长的独立块。
 */
export function isolateIpcChunk(data: Uint8Array, offset = 0): Uint8Array<ArrayBuffer> {
  const view = data.subarray(offset, offset + IPC_MAX_CHUNK_BYTES)
  if (view.buffer instanceof ArrayBuffer
    && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view as Uint8Array<ArrayBuffer>
  }
  return Uint8Array.from(view)
}

/** 可由协议状态机显式解决或拒绝的一次性结果。 */
export interface Deferred<T> {
  /** 交给等待方的 Promise。 */
  readonly promise: Promise<T>
  /** 以领域值解决等待方。 */
  resolve(value: T): void
  /** 以原始失败原因拒绝等待方。 */
  reject(reason: unknown): void
}

/**
 * 创建只暴露单次解决能力的 Promise。
 * @returns Promise 及其解决、拒绝入口。
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/**
 * 把本地传输错误映射为唯一的 wire 失败帧。
 * @param id - 可选的请求关联 id。
 * @param error - 已分类并脱敏的传输错误。
 * @returns 可通过结构化克隆发送的失败帧。
 */
export function toIpcFailureFrame(
  id: string | undefined,
  error: IpcTransportError,
): IpcFailureFrame {
  return {
    type: 'failure',
    ...(id === undefined ? {} : { id }),
    code: error.code,
    phase: error.options.phase,
    retryable: error.options.retryable,
    ...(error.options.outcomeUnknown === undefined ? {} : { outcomeUnknown: error.options.outcomeUnknown }),
    message: error.message,
  }
}

/**
 * 通过数据端口发送已校验帧，并把同步发送失败统一映射为关闭错误。
 * @param port - 当前代际拥有的数据端口。
 * @param frame - 已通过本地协议类型约束的帧。
 * @param failureMessage - 标识 Renderer 或 Host 侧的脱敏诊断。
 * @param onFailure - 所属状态机的端口关闭入口。
 */
function postIpcFrame(
  port: IpcMessagePort,
  frame: IpcDataFrame,
  failureMessage: string,
  onFailure: (error: IpcTransportError) => void,
): void {
  try {
    port.postMessage(frame)
  } catch {
    onFailure(new IpcTransportError('TRANSPORT_CLOSED', failureMessage, {
      phase: 'close',
      retryable: true,
    }))
  }
}

/**
 * 以同一关闭错误结算一个数据端口的全部在途记录和关闭观察者。
 * @param port - 当前代际拥有的数据端口。
 * @param records - 关闭前仍在 registry 中的记录。
 * @param error - 结算每条记录和端口观察者的稳定错误。
 * @param closePort - 是否同时关闭底层物理端口。
 * @param failRecord - 所属状态机对单条记录的清理入口。
 * @param settleClosed - 所属状态机对 closed Promise 的解决入口。
 */
export function settleIpcPort<T>(
  port: IpcMessagePort,
  records: Iterable<T>,
  error: IpcTransportError,
  closePort: boolean,
  failRecord: (record: T, error: IpcTransportError) => void,
  settleClosed: (error: IpcTransportError) => void,
): void {
  // failRecord 会从原 registry 删除元素，因此先固定本次关闭需要结算的记录集合。
  for (const record of [...records]) failRecord(record, error)
  if (closePort) port.close?.()
  settleClosed(error)
}

/** 端口关闭帧与本地错误必须使用完全相同的脱敏原因。 */
interface IpcPortClosure {
  /** 发送给对端的关闭帧。 */
  readonly frame: Extract<IpcDataFrame, { type: 'port-close' }>
  /** 结算本地在途工作使用的关闭错误。 */
  readonly error: IpcTransportError
}

/**
 * 为主动关闭同时创建 wire 帧和本地结算错误。
 * @param generation - 当前数据端口代际。
 * @param reason - 本进程收到的关闭原因。
 * @returns 使用同一短文本的关闭帧与本地错误。
 */
function createIpcPortClosure(generation: number, reason: unknown): IpcPortClosure {
  const message = ipcReasonText(reason)
  return {
    frame: { type: 'port-close', generation, reason: message },
    error: new IpcTransportError('TRANSPORT_CLOSED', message, {
      phase: 'close',
      retryable: true,
    }),
  }
}

/**
 * 发送主动关闭帧并用同一原因结算本地端口。
 * @param generation - 当前数据端口代际。
 * @param reason - 本进程收到的关闭原因。
 * @param post - 状态机拥有的发送入口。
 * @param terminate - 状态机拥有的本地结算入口。
 */
function initiateIpcPortClosure(
  generation: number,
  reason: unknown,
  post: (frame: IpcPortClosure['frame']) => void,
  terminate: (error: IpcTransportError) => void,
): void {
  const closure = createIpcPortClosure(generation, reason)
  post(closure.frame)
  terminate(closure.error)
}

/**
 * 主动关闭一个可能已结束的数据端口。
 * @param closed - 当前状态机是否已经关闭。
 * @param generation - 当前数据端口代际。
 * @param reason - 本进程收到的关闭原因。
 * @param post - 状态机拥有的发送入口。
 * @param terminate - 状态机拥有的本地结算入口。
 * @returns 所有本地结算同步完成后的 Promise。
 */
function closeIpcPort(
  closed: boolean,
  generation: number,
  reason: unknown,
  post: (frame: IpcPortClosure['frame']) => void,
  terminate: (error: IpcTransportError) => void,
): Promise<void> {
  if (!closed) initiateIpcPortClosure(generation, reason, post, terminate)
  return Promise.resolve()
}

/**
 * 校验一个结构化克隆值，并把畸形值交给所属状态机关闭。
 * @param closed - 当前状态机是否已经关闭。
 * @param raw - MessagePort 收到的未知值。
 * @param onInvalid - 畸形帧的 fail-closed 回调。
 * @returns 已校验帧；失败时返回 undefined。
 */
function parseIpcPortFrame(
  closed: boolean,
  raw: unknown,
  onInvalid: () => void,
): IpcDataFrame | undefined {
  if (closed) return undefined
  const parsed = ipcDataFrameSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  onInvalid()
  return undefined
}

/**
 * 创建会关闭整个数据端口的协议失败。
 * @param code - 协议层稳定错误码。
 * @param message - 已脱敏的本端诊断。
 * @returns 不可重试的协议错误。
 */
function ipcProtocolError(
  code: Extract<IpcFailureCode, 'PROTOCOL_INVALID_FRAME' | 'PROTOCOL_GENERATION' | 'PROTOCOL_STATE'>,
  message: string,
): IpcTransportError {
  return new IpcTransportError(code, message, { phase: 'protocol', retryable: false })
}

/**
 * 把对端关闭原因恢复为本地可重试传输错误。
 * @param reason - 已通过 wire schema 校验的短文本。
 * @returns 用于结算全部在途工作的关闭错误。
 */
function ipcRemoteClosureError(reason: string): IpcTransportError {
  return new IpcTransportError('TRANSPORT_CLOSED', reason, {
    phase: 'close',
    retryable: true,
  })
}

/**
 * 发送协议失败帧并关闭所属数据端口。
 * @param code - 协议层稳定错误码。
 * @param message - 已脱敏的本端诊断。
 * @param post - 状态机拥有的发送入口。
 * @param terminate - 状态机拥有的关闭入口。
 */
function failIpcPortProtocol(
  code: Extract<IpcFailureCode, 'PROTOCOL_INVALID_FRAME' | 'PROTOCOL_GENERATION' | 'PROTOCOL_STATE'>,
  message: string,
  post: (frame: IpcFailureFrame) => void,
  terminate: (error: IpcTransportError) => void,
): void {
  const error = ipcProtocolError(code, message)
  post(toIpcFailureFrame(undefined, error))
  terminate(error)
}

/**
 * 校验对端关闭帧代际并结算所属数据端口。
 * @param generation - 关闭帧携带的数据端口代际。
 * @param expectedGeneration - 本端当前数据端口代际。
 * @param reason - 已通过 wire schema 校验的关闭原因。
 * @param mismatchMessage - 代际不一致时的本端诊断。
 * @param onMismatch - 状态机拥有的协议失败入口。
 * @param terminate - 状态机拥有的关闭入口。
 */
function receiveIpcPortClosure(
  generation: number,
  expectedGeneration: number,
  reason: string,
  mismatchMessage: string,
  onMismatch: (code: 'PROTOCOL_GENERATION', message: string) => void,
  terminate: (error: IpcTransportError) => void,
): void {
  if (generation !== expectedGeneration) {
    onMismatch('PROTOCOL_GENERATION', mismatchMessage)
    return
  }
  terminate(ipcRemoteClosureError(reason))
}

/** 共用数据端口生命周期所需的状态机入口。 */
export interface IpcPortLifecycleOptions {
  /** 当前数据端口代际。 */
  readonly generation: number
  /** 有界 request registry 容量。 */
  readonly maxInFlightRequests?: number
  /** 单请求体累计字节上限。 */
  readonly maxRequestBodyBytes?: number
}

/** 集中实现 Renderer 与 Host 对称的数据端口关闭和协议失败语义。 */
export class IpcPortLifecycle {
  /** 解析后的有界 request registry 容量。 */
  readonly maxInFlightRequests: number
  /** 解析后的单请求体累计字节上限。 */
  readonly maxRequestBodyBytes: number

  /**
   * 固定数据端口配置与所属状态机入口。
   * @param options - 数据端口代际与资源上限。
   * @param isClosed - 读取所属状态机是否已关闭。
   * @param port - 当前代际拥有的数据端口。
   * @param sendFailureMessage - 同步发送失败时的本端诊断。
   * @param terminate - 结算所属状态机，并按需关闭底层端口。
   */
  constructor(
    private readonly options: IpcPortLifecycleOptions,
    private readonly isClosed: () => boolean,
    private readonly port: IpcMessagePort,
    private readonly sendFailureMessage: string,
    private readonly terminate: (error: IpcTransportError, closePort: boolean) => void,
  ) {
    this.maxInFlightRequests = options.maxInFlightRequests ?? IPC_DEFAULT_MAX_IN_FLIGHT_REQUESTS
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? IPC_DEFAULT_MAX_REQUEST_BODY_BYTES
  }

  /**
   * 主动关闭数据端口，并使用同一脱敏原因结算本地状态。
   * @param reason - 本进程收到的关闭原因。
   * @returns 所有本地结算同步完成后的 Promise。
   */
  close(reason: unknown): Promise<void> {
    return closeIpcPort(
      this.isClosed(),
      this.options.generation,
      reason,
      (frame) => { this.post(frame) },
      (error) => { this.terminate(error, false) },
    )
  }

  /**
   * 在端口仍打开时发送一个已校验帧；同步发送失败会关闭整个数据端口。
   * @param frame - 已由本地状态机创建的协议帧。
   */
  post(frame: IpcDataFrame): void {
    if (this.isClosed()) return
    postIpcFrame(this.port, frame, this.sendFailureMessage, (error) => {
      this.terminate(error, true)
    })
  }

  /**
   * 在端口仍打开时校验一个结构化克隆值。
   * @param raw - MessagePort 收到的未知值。
   * @param onInvalid - 畸形帧的 fail-closed 回调。
   * @returns 已校验帧；端口关闭或校验失败时返回 undefined。
   */
  parse(raw: unknown, onInvalid: () => void): IpcDataFrame | undefined {
    return parseIpcPortFrame(this.isClosed(), raw, onInvalid)
  }

  /**
   * 发送协议失败帧并关闭所属数据端口。
   * @param code - 协议层稳定错误码。
   * @param message - 已脱敏的本端诊断。
   */
  failProtocol(
    code: Extract<IpcFailureCode, 'PROTOCOL_INVALID_FRAME' | 'PROTOCOL_GENERATION' | 'PROTOCOL_STATE'>,
    message: string,
  ): void {
    failIpcPortProtocol(code, message, (frame) => { this.post(frame) }, (error) => {
      this.terminate(error, true)
    })
  }

  /**
   * 校验对端关闭帧代际并结算所属数据端口。
   * @param generation - 关闭帧携带的数据端口代际。
   * @param reason - 已通过 wire schema 校验的关闭原因。
   * @param mismatchMessage - 代际不一致时的本端诊断。
   */
  receiveClosure(generation: number, reason: string, mismatchMessage: string): void {
    receiveIpcPortClosure(
      generation,
      this.options.generation,
      reason,
      mismatchMessage,
      (code, message) => { this.failProtocol(code, message) },
      (error) => { this.terminate(error, true) },
    )
  }
}
