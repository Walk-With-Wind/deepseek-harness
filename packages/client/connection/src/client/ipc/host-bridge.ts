/** Utility 侧 IPC Fetch Host bridge。 */
import {
  IPC_DATA_PROTOCOL_VERSION,
  IpcTransportError,
  assertNever,
  errorFromFailure,
  type IpcDataFrame,
  type IpcFailureFrame,
  type IpcMessagePort,
} from './protocol.ts'
import {
  internalUrl,
  requestContentLength,
  requestFrameHeaders,
  requestMethod,
  responseHeaders,
} from './validation.ts'
import {
  createDeferred,
  IpcPortLifecycle,
  isolateIpcChunk,
  settleIpcPort,
  toIpcFailureFrame,
  type Deferred,
} from './shared.ts'

/** IPC Host dispatch 只信任端口建立时固定的权限来源。 */
export interface IpcHostDispatchContext {
  /** Desktop 数据端口永远代表本机调用方。 */
  readonly authority: 'local'
}

/** 标准 Request/Response Host 分发函数。 */
export type IpcHostDispatch = (
  request: Request,
  context: IpcHostDispatchContext,
) => Promise<Response>

interface HostRequestRecord {
  readonly id: string
  readonly method: 'GET' | 'HEAD' | 'POST'
  readonly abort: AbortController
  requestController: ReadableStreamDefaultController<Uint8Array> | undefined
  requestPull: Deferred<void> | undefined
  requestSequence: number
  requestBytes: number
  readonly declaredLength: number | undefined
  requestEnded: boolean
  responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  responseRemainder: Uint8Array | undefined
  responseRemainderOffset: number
  responseReading: boolean
  responseSequence: number
  responseHeadSent: boolean
}

/** Utility 侧 IPC Host bridge 配置。 */
export interface IpcHostBridgeOptions {
  /** Main 分配的数据端口代际。 */
  readonly generation: number
  /** 复用现有业务 Host handler 的标准 Fetch 分发。 */
  readonly dispatch: IpcHostDispatch
  /** 有界 request registry 容量。 */
  readonly maxInFlightRequests?: number
  /** 单请求体累计字节上限。 */
  readonly maxRequestBodyBytes?: number
}

/** Utility 诊断使用的单端口有界资源计数。 */
export interface IpcHostBridgeResourceSnapshot {
  readonly phase: 'handshake' | 'ready' | 'closed'
  readonly inFlightRequests: number
  readonly requestReaders: number
  readonly responseReaders: number
}

/** 接收 Renderer 帧、构造标准 Request，并按 pull 回传标准 Response。 */
export class IpcHostBridge {
  /** 端口关闭后的稳定错误；供端口所有者同步清理 registry。 */
  readonly closed: Promise<IpcTransportError>

  private readonly generation: number
  private readonly dispatch: IpcHostDispatch
  private readonly closedState = createDeferred<IpcTransportError>()
  private readonly requests = new Map<string, HostRequestRecord>()
  private readonly onMessage = (event: MessageEvent<unknown>): void => { this.receive(event.data) }
  private readonly onPhysicalClose = (): void => {
    this.terminate(new IpcTransportError('TRANSPORT_CLOSED', 'IPC Host 数据端口已物理关闭', {
      phase: 'close',
      retryable: true,
    }), false)
  }
  private readonly lifecycle: IpcPortLifecycle
  private unsubscribePhysicalClose: () => void = () => undefined
  private phase: 'handshake' | 'ready' | 'closed' = 'handshake'

  /**
   * 监听一个 Utility 数据端口。
   * @param port - Utility 侧最小 MessagePort。
   * @param options - 代际、标准分发函数和资源上限。
   */
  constructor(
    private readonly port: IpcMessagePort,
    options: IpcHostBridgeOptions,
  ) {
    this.generation = options.generation
    this.dispatch = options.dispatch
    this.closed = this.closedState.promise
    this.lifecycle = new IpcPortLifecycle(
      options,
      () => this.phase === 'closed',
      this.port,
      'IPC Host 数据端口发送失败',
      this.terminate.bind(this),
    )
    this.port.addEventListener('message', this.onMessage)
    this.unsubscribePhysicalClose = this.port.subscribeClose?.(this.onPhysicalClose) ?? (() => undefined)
    this.port.start?.()
  }

  /**
   * 协议化关闭端口并取消全部在途 Host 工作。
   * @param reason - 交给对端的脱敏关闭原因。
   */
  close(reason: unknown = 'Host 关闭'): Promise<void> {
    return this.lifecycle.close(reason)
  }

  /**
   * 返回当前端口的有界 registry 与 reader 计数，不暴露请求内容或标识。
   * @returns 可用于耐久门禁前后比较的资源快照。
   */
  resourceSnapshot(): IpcHostBridgeResourceSnapshot {
    let requestReaders = 0
    let responseReaders = 0
    for (const record of this.requests.values()) {
      if (!record.requestEnded && record.requestController !== undefined) requestReaders += 1
      if (record.responseReader !== undefined) responseReaders += 1
    }
    return {
      phase: this.phase,
      inFlightRequests: this.requests.size,
      requestReaders,
      responseReaders,
    }
  }

  private receive(raw: unknown): void {
    const frame = this.lifecycle.parse(raw, () => {
      this.protocolFailure('PROTOCOL_INVALID_FRAME', 'IPC Host 收到畸形帧')
    })
    if (frame === undefined) return
    if (this.phase === 'handshake') {
      if (frame.type === 'data/hello') {
        if (frame.generation !== this.generation) {
          this.protocolFailure('PROTOCOL_GENERATION', 'IPC hello 代际不匹配')
          return
        }
        this.phase = 'ready'
        this.lifecycle.post({
          type: 'data/ready',
          protocolVersion: IPC_DATA_PROTOCOL_VERSION,
          generation: this.generation,
        })
        return
      }
      if (frame.type === 'port-close') {
        this.receivePortClose(frame.generation, frame.reason)
        return
      }
      this.protocolFailure('PROTOCOL_STATE', 'IPC hello 前收到业务帧')
      return
    }
    this.receiveReadyFrame(frame)
  }

  private receiveReadyFrame(frame: IpcDataFrame): void {
    switch (frame.type) {
      case 'request':
        this.handleRequest(frame)
        return
      case 'request-chunk':
        this.handleRequestChunk(frame.id, frame.sequence, frame.chunk)
        return
      case 'request-end':
        this.handleRequestEnd(frame.id)
        return
      case 'request-cancel':
        this.handleRequestCancel(frame.generation, frame.id, frame.reason)
        return
      case 'response-pull':
        this.handleResponsePull(frame.id)
        return
      case 'response-cancel':
        this.handleResponseCancel(frame.id, frame.reason)
        return
      case 'failure':
        this.handleFailure(frame)
        return
      case 'port-close':
        this.receivePortClose(frame.generation, frame.reason)
        return
      case 'data/hello':
      case 'data/ready':
      case 'request-pull':
      case 'response-head':
      case 'response-chunk':
      case 'response-end':
        this.protocolFailure('PROTOCOL_STATE', `Utility 收到方向错误的 ${frame.type} 帧`)
        return
      default:
        assertNever(frame)
    }
  }

  private handleRequest(frame: Extract<IpcDataFrame, { type: 'request' }>): void {
    if (frame.generation !== this.generation) {
      this.protocolFailure('PROTOCOL_GENERATION', 'IPC request 代际不匹配')
      return
    }
    if (this.requests.has(frame.id)) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC request id 重复')
      return
    }
    if (this.requests.size >= this.lifecycle.maxInFlightRequests) {
      this.lifecycle.post(toIpcFailureFrame(frame.id, new IpcTransportError('LIMIT_IN_FLIGHT', 'IPC Host 在途请求数量已达上限', {
        phase: 'request',
        retryable: false,
      })))
      return
    }
    let url: URL
    let method: 'GET' | 'HEAD' | 'POST'
    let headers: [string, string][]
    let declaredLength: number | undefined
    try {
      url = internalUrl(frame.path)
      method = requestMethod(frame.method)
      headers = requestFrameHeaders(frame.headers)
      declaredLength = requestContentLength(new Headers(headers), this.lifecycle.maxRequestBodyBytes)
      if (frame.hasBody && method !== 'POST') {
        throw new IpcTransportError('PROTOCOL_METHOD', 'GET/HEAD IPC 请求不能携带 body', {
          phase: 'request',
          retryable: false,
        })
      }
      if (!frame.hasBody && declaredLength !== undefined && declaredLength !== 0) {
        throw new IpcTransportError('PROTOCOL_HEADER', '无请求体的 IPC 请求不能声明非零 Content-Length', {
          phase: 'request',
          retryable: false,
        })
      }
    } catch (error) {
      this.lifecycle.post(toIpcFailureFrame(frame.id, this.asTransportError(error, 'PROTOCOL_PATH', 'IPC 请求描述符非法')))
      return
    }

    const abort = new AbortController()
    const record: HostRequestRecord = {
      id: frame.id,
      method,
      abort,
      requestController: undefined,
      requestPull: undefined,
      requestSequence: 0,
      requestBytes: 0,
      declaredLength,
      requestEnded: !frame.hasBody,
      responseReader: undefined,
      responseRemainder: undefined,
      responseRemainderOffset: 0,
      responseReading: false,
      responseSequence: 0,
      responseHeadSent: false,
    }
    const body = this.createRequestBody(record, frame.hasBody)
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      signal: abort.signal,
      ...(body === null ? {} : { body, duplex: 'half' }),
    }
    let request: Request
    try {
      request = new Request(url, init)
    } catch (error) {
      this.lifecycle.post(toIpcFailureFrame(frame.id, this.asTransportError(error, 'PROTOCOL_HEADER', 'IPC Request 构造失败')))
      return
    }
    this.requests.set(frame.id, record)
    void this.dispatchRequest(record, request)
  }

  private createRequestBody(record: HostRequestRecord, hasBody: boolean): ReadableStream<Uint8Array> | null {
    if (!hasBody) return null
    return new ReadableStream<Uint8Array>({
      start: (controller) => { record.requestController = controller },
      pull: () => {
        if (!this.requests.has(record.id)) return
        if (record.requestPull !== undefined) return record.requestPull.promise
        record.requestPull = createDeferred<void>()
        this.lifecycle.post({ type: 'request-pull', id: record.id })
        return record.requestPull.promise
      },
      cancel: (reason) => {
        if (!record.abort.signal.aborted) record.abort.abort(reason)
      },
    }, { highWaterMark: 0 })
  }

  private handleRequestChunk(id: string, sequence: number, chunk: Uint8Array): void {
    const record = this.requests.get(id)
    if (record === undefined || record.requestController === undefined || record.requestPull === undefined
      || record.requestEnded || sequence !== record.requestSequence) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC request-chunk 状态或序号非法')
      return
    }
    record.requestBytes += chunk.byteLength
    if (record.requestBytes > this.lifecycle.maxRequestBodyBytes) {
      const error = new IpcTransportError('LIMIT_REQUEST_BODY', 'IPC 请求体超过 Host 配置上限', {
        phase: 'request',
        retryable: false,
      })
      this.lifecycle.post(toIpcFailureFrame(id, error))
      this.failRecord(record, error)
      return
    }
    if (record.declaredLength !== undefined && record.requestBytes > record.declaredLength) {
      const error = new IpcTransportError('PROTOCOL_HEADER', 'IPC 请求体超过声明的 Content-Length', {
        phase: 'request',
        retryable: false,
      })
      this.lifecycle.post(toIpcFailureFrame(id, error))
      this.failRecord(record, error)
      return
    }
    const pull = record.requestPull
    record.requestPull = undefined
    record.requestSequence += 1
    record.requestController.enqueue(chunk)
    pull.resolve(undefined)
  }

  private handleRequestEnd(id: string): void {
    const record = this.requests.get(id)
    if (record === undefined || record.requestController === undefined || record.requestPull === undefined || record.requestEnded) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC request-end 状态非法')
      return
    }
    if (record.declaredLength !== undefined && record.requestBytes !== record.declaredLength) {
      const error = new IpcTransportError('PROTOCOL_HEADER', 'IPC 请求体实际长度与 Content-Length 不一致', {
        phase: 'request',
        retryable: false,
      })
      this.lifecycle.post(toIpcFailureFrame(id, error))
      this.failRecord(record, error)
      return
    }
    const pull = record.requestPull
    record.requestPull = undefined
    record.requestEnded = true
    record.requestController.close()
    pull.resolve(undefined)
  }

  private handleRequestCancel(generation: number, id: string, reason: string): void {
    if (generation !== this.generation) {
      this.protocolFailure('PROTOCOL_GENERATION', 'IPC request-cancel 代际不匹配')
      return
    }
    const record = this.requests.get(id)
    if (record === undefined) return
    const error = new IpcTransportError('REQUEST_CANCELLED', reason, {
      phase: 'request',
      retryable: false,
    })
    this.failRecord(record, error)
  }

  private handleResponsePull(id: string): void {
    const record = this.requests.get(id)
    if (record === undefined || record.responseReader === undefined || !record.responseHeadSent || record.responseReading) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC response-pull 状态非法')
      return
    }
    record.responseReading = true
    void this.sendResponsePiece(record)
  }

  private handleResponseCancel(id: string, reason: string): void {
    const record = this.requests.get(id)
    if (record === undefined) return
    if (!record.abort.signal.aborted) record.abort.abort(reason)
    void record.responseReader?.cancel(reason).catch(() => undefined)
    this.cleanupRecord(record)
  }

  private handleFailure(frame: IpcFailureFrame): void {
    if (frame.id === undefined) {
      this.terminate(errorFromFailure(frame), true)
      return
    }
    const record = this.requests.get(frame.id)
    if (record === undefined) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC failure 指向未知 Host 请求')
      return
    }
    this.failRecord(record, errorFromFailure(frame))
  }

  private async dispatchRequest(record: HostRequestRecord, request: Request): Promise<void> {
    try {
      const response = await this.dispatch(request, { authority: 'local' })
      if (!this.requests.has(record.id) || record.abort.signal.aborted) return
      const responseBody = record.method === 'HEAD' ? null : response.body
      const hasBody = responseBody !== null
      record.responseHeadSent = true
      record.responseReader = responseBody === null ? undefined : responseBody.getReader()
      this.lifecycle.post({
        type: 'response-head',
        id: record.id,
        status: response.status,
        headers: responseHeaders(response.headers),
        hasBody,
      })
      if (!hasBody) this.cleanupRecord(record)
    } catch (error) {
      if (!this.requests.has(record.id) || record.abort.signal.aborted) return
      const failure = this.asTransportError(error, 'HOST_UNAVAILABLE', 'IPC Host handler 执行失败', {
        phase: 'response',
        retryable: true,
        outcomeUnknown: record.method === 'POST',
      })
      this.lifecycle.post(toIpcFailureFrame(record.id, failure))
      this.failRecord(record, failure)
    }
  }

  private async sendResponsePiece(record: HostRequestRecord): Promise<void> {
    const reader = record.responseReader
    if (reader === undefined) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC response-pull 的响应 reader 已释放')
      return
    }
    try {
      let chunk: Uint8Array<ArrayBuffer> | undefined
      if (record.responseRemainder !== undefined) {
        chunk = isolateIpcChunk(record.responseRemainder, record.responseRemainderOffset)
        record.responseRemainderOffset += chunk.byteLength
        if (record.responseRemainderOffset === record.responseRemainder.byteLength) {
          record.responseRemainder = undefined
          record.responseRemainderOffset = 0
        }
      } else {
        while (chunk === undefined) {
          const item = await reader.read()
          if (item.done) {
            record.responseReading = false
            this.lifecycle.post({ type: 'response-end', id: record.id })
            this.cleanupRecord(record)
            return
          }
          if (item.value.byteLength === 0) continue
          record.responseRemainder = item.value
          chunk = isolateIpcChunk(item.value)
          record.responseRemainderOffset = chunk.byteLength
          if (chunk.byteLength === item.value.byteLength) {
            record.responseRemainder = undefined
            record.responseRemainderOffset = 0
          }
        }
      }
      record.responseReading = false
      this.lifecycle.post({
        type: 'response-chunk',
        id: record.id,
        sequence: record.responseSequence++,
        chunk,
      })
    } catch (error) {
      if (!this.requests.has(record.id)) return
      const failure = this.asTransportError(error, 'HOST_UNAVAILABLE', '读取 IPC Host 响应流失败', {
        phase: 'response',
        retryable: true,
        outcomeUnknown: false,
      })
      this.lifecycle.post(toIpcFailureFrame(record.id, failure))
      this.failRecord(record, failure)
    }
  }

  private failRecord(record: HostRequestRecord, error: IpcTransportError): void {
    record.requestPull?.reject(error)
    record.requestPull = undefined
    if (!record.abort.signal.aborted) record.abort.abort(error)
    if (!record.requestEnded && record.requestController !== undefined) {
      try {
        record.requestController.error(error)
      } catch {
        // 请求消费者已经结束时再次 error 可能失败；下方仍负责统一清理。
      }
    }
    void record.responseReader?.cancel(error).catch(() => undefined)
    this.cleanupRecord(record)
  }

  private cleanupRecord(record: HostRequestRecord): void {
    this.requests.delete(record.id)
    record.responseReader = undefined
  }

  private protocolFailure(code: 'PROTOCOL_INVALID_FRAME' | 'PROTOCOL_GENERATION' | 'PROTOCOL_STATE', message: string): void {
    this.lifecycle.failProtocol(code, message)
  }

  private receivePortClose(generation: number, reason: string): void {
    this.lifecycle.receiveClosure(generation, reason, 'IPC Host port-close 代际不匹配')
  }

  private terminate(error: IpcTransportError, closePort: boolean): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.port.removeEventListener('message', this.onMessage)
    this.unsubscribePhysicalClose()
    this.unsubscribePhysicalClose = () => undefined
    settleIpcPort(
      this.port, this.requests.values(), error, closePort,
      (record, failure) => { this.failRecord(record, failure) },
      (failure) => { this.closedState.resolve(failure) },
    )
  }

  private asTransportError(
    error: unknown,
    fallbackCode: 'PROTOCOL_PATH' | 'PROTOCOL_HEADER' | 'HOST_UNAVAILABLE',
    fallbackMessage: string,
    options: IpcTransportError['options'] = { phase: 'request', retryable: false },
  ): IpcTransportError {
    return error instanceof IpcTransportError
      ? error
      : new IpcTransportError(fallbackCode, fallbackMessage, options)
  }
}
