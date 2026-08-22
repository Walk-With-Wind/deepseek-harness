/** Renderer 侧 IPC Fetch 载体。 */
import { randomUuid } from '../random-uuid.ts'
import type { ClientCarrier, ClientCarrierAuthority, DownlinkKind } from '../carrier.ts'
import {
  IPC_DATA_PROTOCOL_VERSION,
  IPC_MAX_CHUNK_BYTES,
  IpcTransportError,
  assertNever,
  errorFromFailure,
  type IpcDataFrame,
  type IpcFailureFrame,
  type IpcMessagePort,
} from './protocol.ts'
import {
  IPC_INTERNAL_BASE_URL,
  ipcReasonText,
  requestContentLength,
  requestHeaders,
  requestMethod,
  requestPath,
} from './validation.ts'
import {
  createDeferred,
  IpcPortLifecycle,
  isolateIpcChunk,
  settleIpcPort,
  toIpcFailureFrame,
  type Deferred,
} from './shared.ts'

interface ClientRequestRecord {
  readonly id: string
  readonly method: 'GET' | 'HEAD' | 'POST'
  readonly result: Deferred<Response>
  readonly signal: AbortSignal
  readonly abortListener: () => void
  requestReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  requestRemainder: Uint8Array | undefined
  requestRemainderOffset: number
  requestSequence: number
  requestBytes: number
  requestReading: boolean
  declaredLength: number | undefined
  responseController: ReadableStreamDefaultController<Uint8Array> | undefined
  responsePull: Deferred<void> | undefined
  responseSequence: number
  responseHeadReceived: boolean
}

/** IPC 客户端载体配置。 */
export interface IpcClientCarrierOptions {
  /** Main 分配的数据端口代际。 */
  readonly generation: number
  /** 有界 request registry 容量。 */
  readonly maxInFlightRequests?: number
  /** 单请求体累计字节上限。 */
  readonly maxRequestBodyBytes?: number
  /** 数据端口握手超时。 */
  readonly handshakeTimeoutMs?: number
}

/** 通过拉取式 MessagePort 协议实现 Fetch 与双事件下行的桌面载体。 */
export class IpcClientCarrier implements ClientCarrier {
  readonly authority: ClientCarrierAuthority = 'local'
  readonly baseUrl = IPC_INTERNAL_BASE_URL
  /** 端口关闭后的稳定错误；用于产品外壳监督载体生命周期。 */
  readonly closed: Promise<IpcTransportError>

  private readonly generation: number
  private readonly readyState = createDeferred<void>()
  private readonly closedState = createDeferred<IpcTransportError>()
  private readonly requests = new Map<string, ClientRequestRecord>()
  private readonly onMessage = (event: MessageEvent<unknown>): void => { this.receive(event.data) }
  private readonly onPhysicalClose = (): void => {
    this.terminate(new IpcTransportError('TRANSPORT_CLOSED', 'IPC 数据端口已物理关闭', {
      phase: 'close',
      retryable: true,
    }), false)
  }
  private readonly handshakeTimer: ReturnType<typeof setTimeout>
  private readonly lifecycle: IpcPortLifecycle
  private unsubscribePhysicalClose: () => void = () => undefined
  private phase: 'handshake' | 'ready' | 'closed' = 'handshake'

  /**
   * 建立 Renderer 数据端口并立即发起协议握手。
   * @param port - 预加载层转交的最小 MessagePort。
   * @param options - 代际与有界资源配置。
   */
  constructor(
    private readonly port: IpcMessagePort,
    options: IpcClientCarrierOptions,
  ) {
    this.generation = options.generation
    this.lifecycle = new IpcPortLifecycle(
      options,
      () => this.phase === 'closed',
      this.port,
      'IPC 数据端口发送失败',
      this.terminate.bind(this),
    )
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.closed = this.closedState.promise
    // 构造阶段无人等待 ready 时也必须观察拒绝，避免端口关闭产生未处理 Promise。
    void this.readyState.promise.catch(() => undefined)
    this.port.addEventListener('message', this.onMessage)
    this.unsubscribePhysicalClose = this.port.subscribeClose?.(this.onPhysicalClose) ?? (() => undefined)
    this.port.start?.()
    this.handshakeTimer = setTimeout(() => {
      this.terminate(new IpcTransportError('HOST_UNAVAILABLE', 'IPC 数据端口握手超时', {
        phase: 'handshake',
        retryable: true,
      }), true)
    }, handshakeTimeoutMs)
    this.lifecycle.post({
      type: 'data/hello',
      protocolVersion: IPC_DATA_PROTOCOL_VERSION,
      generation: this.generation,
    })
  }

  /**
   * 等待 Utility 确认当前代际和协议版本。
   * @returns 当前数据端口可接收业务请求时解决的 Promise。
   */
  ready(): Promise<void> {
    return this.readyState.promise
  }

  /** @inheritdoc */
  async fetch(input: URL | Request, init?: RequestInit): Promise<Response> {
    await this.ready()
    this.assertOpen()
    if (this.requests.size >= this.lifecycle.maxInFlightRequests) {
      throw new IpcTransportError('LIMIT_IN_FLIGHT', 'IPC 在途请求数量已达上限', {
        phase: 'request',
        retryable: false,
      })
    }
    const request = new Request(input, init)
    const method = requestMethod(request.method)
    const path = requestPath(new URL(request.url))
    const headers = requestHeaders(request.headers)
    const declaredLength = requestContentLength(request.headers, this.lifecycle.maxRequestBodyBytes)
    if (request.signal.aborted) throw this.cancelledError()

    const id = randomUuid()
    const result = createDeferred<Response>()
    const abortListener = (): void => { this.cancel(id, request.signal.reason) }
    const record: ClientRequestRecord = {
      id,
      method,
      result,
      signal: request.signal,
      abortListener,
      requestReader: request.body?.getReader(),
      requestRemainder: undefined,
      requestRemainderOffset: 0,
      requestSequence: 0,
      requestBytes: 0,
      requestReading: false,
      declaredLength,
      responseController: undefined,
      responsePull: undefined,
      responseSequence: 0,
      responseHeadReceived: false,
    }
    request.signal.addEventListener('abort', abortListener, { once: true })
    this.requests.set(id, record)
    this.lifecycle.post({
      type: 'request',
      generation: this.generation,
      id,
      method,
      path,
      headers,
      hasBody: record.requestReader !== undefined,
    })
    return result.promise
  }

  /** 事件流仍使用同一个 Fetch 桥，不建立第二套 IPC 业务路由。 */
  async *connectDownlink(
    kind: DownlinkKind,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<Uint8Array> {
    const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
    const response = await this.fetch(new URL(path, this.baseUrl), { method: 'GET', signal })
    if (!response.ok || response.body === null) {
      throw new IpcTransportError('HOST_UNAVAILABLE', `IPC ${kind} 下行建立失败：HTTP ${String(response.status)}`, {
        phase: 'response',
        retryable: true,
      })
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new IpcTransportError('HOST_UNAVAILABLE', `IPC ${kind} 下行未返回事件流`, {
        phase: 'response',
        retryable: true,
      })
    }
    onOpen?.()
    yield* decodeSseData(response.body)
  }

  /** @inheritdoc */
  close(reason: unknown = '客户端关闭'): Promise<void> {
    return this.lifecycle.close(reason)
  }

  private receive(raw: unknown): void {
    const frame = this.lifecycle.parse(raw, () => {
      this.protocolFailure('PROTOCOL_INVALID_FRAME', 'IPC 数据端口收到畸形帧')
    })
    if (frame === undefined) return
    if (this.phase === 'handshake') {
      if (frame.type === 'data/ready') {
        if (frame.generation !== this.generation) {
          this.protocolFailure('PROTOCOL_GENERATION', 'IPC ready 代际不匹配')
          return
        }
        clearTimeout(this.handshakeTimer)
        this.phase = 'ready'
        this.readyState.resolve(undefined)
        return
      }
      if (frame.type === 'failure') {
        this.terminate(errorFromFailure(frame), true)
        return
      }
      if (frame.type === 'port-close') {
        this.receivePortClose(frame.generation, frame.reason)
        return
      }
      this.protocolFailure('PROTOCOL_STATE', 'IPC ready 前收到业务帧')
      return
    }
    this.receiveReadyFrame(frame)
  }

  private receiveReadyFrame(frame: IpcDataFrame): void {
    switch (frame.type) {
      case 'request-pull':
        this.handleRequestPull(frame.id)
        return
      case 'response-head':
        this.handleResponseHead(frame)
        return
      case 'response-chunk':
        this.handleResponseChunk(frame.id, frame.sequence, frame.chunk)
        return
      case 'response-end':
        this.handleResponseEnd(frame.id)
        return
      case 'failure':
        this.handleFailure(frame)
        return
      case 'port-close':
        this.receivePortClose(frame.generation, frame.reason)
        return
      case 'data/hello':
      case 'data/ready':
      case 'request':
      case 'request-chunk':
      case 'request-end':
      case 'request-cancel':
      case 'response-pull':
      case 'response-cancel':
        this.protocolFailure('PROTOCOL_STATE', `Renderer 收到方向错误的 ${frame.type} 帧`)
        return
      default:
        assertNever(frame)
    }
  }

  private handleRequestPull(id: string): void {
    const record = this.requests.get(id)
    if (record === undefined || record.requestReader === undefined || record.requestReading) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC request-pull 指向未知、无 body 或正在读取的请求')
      return
    }
    record.requestReading = true
    void this.sendRequestPiece(record)
  }

  private async sendRequestPiece(record: ClientRequestRecord): Promise<void> {
    const reader = record.requestReader
    if (reader === undefined) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC request-pull 的请求体 reader 已释放')
      return
    }
    try {
      const chunk = await this.readRequestChunk(record, reader)
      if (chunk === undefined) {
        this.assertDeclaredLength(record)
        record.requestReading = false
        this.lifecycle.post({ type: 'request-end', id: record.id })
        record.requestReader = undefined
        return
      }
      record.requestBytes += chunk.byteLength
      if (record.requestBytes > this.lifecycle.maxRequestBodyBytes) {
        throw new IpcTransportError('LIMIT_REQUEST_BODY', 'IPC 请求体超过配置上限', {
          phase: 'request',
          retryable: false,
        })
      }
      record.requestReading = false
      this.lifecycle.post({
        type: 'request-chunk',
        id: record.id,
        sequence: record.requestSequence++,
        chunk,
      })
    } catch (error) {
      const failure = error instanceof IpcTransportError
        ? error
        : new IpcTransportError('HOST_UNAVAILABLE', '读取 IPC 请求体失败', { phase: 'request', retryable: false })
      this.lifecycle.post(toIpcFailureFrame(record.id, failure))
      this.failRecord(record, failure)
    }
  }

  /**
   * 读取一个协议上限大小的请求块；浏览器常见的 64 KiB 小分片会在 Renderer 内合并，
   * 从而减少 MessagePort 结构化克隆次数，同时仍只保留一个 1 MiB 聚合缓冲区。
   * @param record - 当前请求的读取游标与未消费余量。
   * @param reader - 请求正文的唯一读取器。
   * @returns 一个独占等长 ArrayBuffer 的协议块；流结束且没有剩余字节时返回 undefined。
   */
  private async readRequestChunk(
    record: ClientRequestRecord,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<Uint8Array<ArrayBuffer> | undefined> {
    let aggregate: Uint8Array<ArrayBuffer> | undefined
    let aggregateBytes = 0
    while (aggregateBytes < IPC_MAX_CHUNK_BYTES) {
      if (record.requestRemainder === undefined) {
        const item = await reader.read()
        if (item.done) {
          if (aggregateBytes === 0) return undefined
          if (aggregate === undefined) throw new Error('IPC 请求聚合缓冲区状态不一致。')
          return Uint8Array.from(aggregate.subarray(0, aggregateBytes))
        }
        if (item.value.byteLength === 0) continue
        record.requestRemainder = item.value
        record.requestRemainderOffset = 0
      }

      const remainder = record.requestRemainder
      if (aggregateBytes === 0
        && remainder.byteLength - record.requestRemainderOffset >= IPC_MAX_CHUNK_BYTES) {
        const chunk = isolateIpcChunk(remainder, record.requestRemainderOffset)
        record.requestRemainderOffset += chunk.byteLength
        if (record.requestRemainderOffset === remainder.byteLength) {
          record.requestRemainder = undefined
          record.requestRemainderOffset = 0
        }
        return chunk
      }

      aggregate ??= new Uint8Array(IPC_MAX_CHUNK_BYTES)
      const copiedBytes = Math.min(
        IPC_MAX_CHUNK_BYTES - aggregateBytes,
        remainder.byteLength - record.requestRemainderOffset,
      )
      aggregate.set(
        remainder.subarray(record.requestRemainderOffset, record.requestRemainderOffset + copiedBytes),
        aggregateBytes,
      )
      aggregateBytes += copiedBytes
      record.requestRemainderOffset += copiedBytes
      if (record.requestRemainderOffset === remainder.byteLength) {
        record.requestRemainder = undefined
        record.requestRemainderOffset = 0
      }
    }
    return aggregate
  }

  private handleResponseHead(frame: Extract<IpcDataFrame, { type: 'response-head' }>): void {
    const record = this.requests.get(frame.id)
    if (record === undefined || record.responseHeadReceived) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC response-head 指向未知或已响应的请求')
      return
    }
    record.responseHeadReceived = true
    void record.requestReader?.cancel('Host 已返回响应').catch(() => undefined)
    record.requestReader = undefined
    if (!frame.hasBody) {
      record.result.resolve(new Response(null, { status: frame.status, headers: frame.headers }))
      this.cleanupRecord(record)
      return
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { record.responseController = controller },
      pull: () => {
        if (!this.requests.has(record.id)) return
        if (record.responsePull !== undefined) return record.responsePull.promise
        record.responsePull = createDeferred<void>()
        this.lifecycle.post({ type: 'response-pull', id: record.id })
        return record.responsePull.promise
      },
      cancel: (reason) => {
        if (!this.requests.has(record.id)) return
        this.lifecycle.post({ type: 'response-cancel', id: record.id, reason: ipcReasonText(reason) })
        this.cleanupRecord(record)
      },
    }, { highWaterMark: 0 })
    record.result.resolve(new Response(stream, { status: frame.status, headers: frame.headers }))
  }

  private handleResponseChunk(id: string, sequence: number, chunk: Uint8Array): void {
    const record = this.requests.get(id)
    if (record === undefined || record.responseController === undefined || record.responsePull === undefined
      || sequence !== record.responseSequence) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC response-chunk 状态或序号非法')
      return
    }
    const pull = record.responsePull
    record.responsePull = undefined
    record.responseSequence += 1
    record.responseController.enqueue(chunk)
    pull.resolve(undefined)
  }

  private handleResponseEnd(id: string): void {
    const record = this.requests.get(id)
    if (record === undefined || record.responseController === undefined || record.responsePull === undefined) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC response-end 状态非法')
      return
    }
    const pull = record.responsePull
    record.responsePull = undefined
    record.responseController.close()
    pull.resolve(undefined)
    this.cleanupRecord(record)
  }

  private handleFailure(frame: IpcFailureFrame): void {
    const error = errorFromFailure(frame)
    if (frame.id === undefined) {
      this.terminate(error, true)
      return
    }
    const record = this.requests.get(frame.id)
    if (record === undefined) {
      this.protocolFailure('PROTOCOL_STATE', 'IPC failure 指向未知请求')
      return
    }
    this.failRecord(record, error)
  }

  private cancel(id: string, reason: unknown): void {
    const record = this.requests.get(id)
    if (record === undefined) return
    const message = ipcReasonText(reason)
    this.lifecycle.post({ type: 'request-cancel', generation: this.generation, id, reason: message })
    if (record.responseHeadReceived) this.lifecycle.post({ type: 'response-cancel', id, reason: message })
    this.failRecord(record, this.cancelledError())
  }

  private assertDeclaredLength(record: ClientRequestRecord): void {
    if (record.declaredLength !== undefined && record.declaredLength !== record.requestBytes) {
      throw new IpcTransportError('PROTOCOL_HEADER', 'IPC 请求体实际长度与 Content-Length 不一致', {
        phase: 'request',
        retryable: false,
      })
    }
  }

  private failRecord(record: ClientRequestRecord, error: IpcTransportError): void {
    record.responsePull?.reject(error)
    record.responsePull = undefined
    if (record.responseController === undefined) record.result.reject(error)
    else {
      try {
        record.responseController.error(error)
      } catch {
        // 已由消费者取消的响应流可能拒绝再次 error；registry 清理仍必须继续。
      }
    }
    this.cleanupRecord(record)
  }

  private cleanupRecord(record: ClientRequestRecord): void {
    if (!this.requests.delete(record.id)) return
    record.signal.removeEventListener('abort', record.abortListener)
    void record.requestReader?.cancel().catch(() => undefined)
    record.requestReader = undefined
  }

  private protocolFailure(code: 'PROTOCOL_INVALID_FRAME' | 'PROTOCOL_GENERATION' | 'PROTOCOL_STATE', message: string): void {
    this.lifecycle.failProtocol(code, message)
  }

  private receivePortClose(generation: number, reason: string): void {
    this.lifecycle.receiveClosure(generation, reason, 'IPC port-close 代际不匹配')
  }

  private terminate(error: IpcTransportError, closePort: boolean): void {
    if (this.phase === 'closed') return
    clearTimeout(this.handshakeTimer)
    const wasHandshake = this.phase === 'handshake'
    this.phase = 'closed'
    this.port.removeEventListener('message', this.onMessage)
    this.unsubscribePhysicalClose()
    this.unsubscribePhysicalClose = () => undefined
    if (wasHandshake) this.readyState.reject(error)
    settleIpcPort(
      this.port, this.requests.values(), error, closePort,
      (record, failure) => { this.failRecord(record, failure) },
      (failure) => { this.closedState.resolve(failure) },
    )
  }

  private assertOpen(): void {
    if (this.phase !== 'ready') {
      throw new IpcTransportError('TRANSPORT_CLOSED', 'IPC 数据端口已关闭', {
        phase: 'close',
        retryable: true,
      })
    }
  }

  private cancelledError(): IpcTransportError {
    return new IpcTransportError('REQUEST_CANCELLED', 'IPC 请求已取消', {
      phase: 'request',
      retryable: false,
    })
  }
}

/** 把任意字节分片的 SSE 流还原为逐事件 data 内容。 */
async function* decodeSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      buffered += decoder.decode(item.value, { stream: true })
      while (true) {
        const boundary = findSseBoundary(buffered)
        if (boundary === undefined) break
        const event = buffered.slice(0, boundary.index)
        buffered = buffered.slice(boundary.index + boundary.length)
        const data = sseEventData(event)
        if (data !== undefined) yield encoder.encode(data)
      }
    }
    buffered += decoder.decode()
    const tail = sseEventData(buffered)
    if (tail !== undefined) yield encoder.encode(tail)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function findSseBoundary(value: string): { index: number; length: number } | undefined {
  let result: { index: number; length: number } | undefined
  for (const marker of ['\r\n\r\n', '\n\n', '\r\r']) {
    const index = value.indexOf(marker)
    if (index >= 0 && (result === undefined || index < result.index)) {
      result = { index, length: marker.length }
    }
  }
  return result
}

function sseEventData(event: string): string | undefined {
  const data: string[] = []
  for (const line of event.split(/\r\n|\r|\n/u)) {
    if (line === 'data') data.push('')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
  }
  return data.length === 0 ? undefined : data.join('\n')
}
