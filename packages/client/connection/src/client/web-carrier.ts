/** 浏览器 HTTP/WebSocket 载体。 */
import { isLoopbackHostname } from '../loopback-hostname.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'
import type { ClientCarrier, ClientCarrierAuthority, DownlinkKind } from './carrier.ts'

type SocketItem = { kind: 'frame'; bytes: Uint8Array } | { kind: 'end' }

/** 浏览器载体的可替换边界，主要供测试和嵌入式 Web 外壳使用。 */
export interface WebClientCarrierOptions {
  /** 显式逻辑基址；默认取当前页面 origin。 */
  readonly baseUrl?: string
  /** 显式权限来源；默认根据当前页面 hostname 判定。 */
  readonly authority?: ClientCarrierAuthority
  /** 显式 Fetch 实现。 */
  readonly fetch?: typeof globalThis.fetch
  /** 显式 WebSocket 构造器。 */
  readonly WebSocket?: typeof globalThis.WebSocket
}

/** 使用 HTTP 上行与 WebSocket 下行的浏览器载体。 */
export class WebClientCarrier implements ClientCarrier {
  readonly authority: ClientCarrierAuthority
  readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly Socket: typeof globalThis.WebSocket
  private readonly sockets = new Set<WebSocket>()
  private closed = false

  /**
   * 创建浏览器载体。
   * @param options - 可替换的浏览器平台依赖。
   */
  constructor(options: WebClientCarrierOptions = {}) {
    const page = (globalThis as { location?: { hostname?: string; origin?: string } }).location
    this.baseUrl = options.baseUrl
      ?? (page?.origin !== undefined && page.origin !== 'null' ? page.origin : 'http://dsh.internal')
    this.authority = options.authority
      ?? (page?.hostname === undefined || isLoopbackHostname(page.hostname) ? 'local' : 'remote-untrusted')
    // 默认包装器在每次调用时解析全局 Fetch，保留测试替换和嵌入环境的既有语义。
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.Socket = options.WebSocket ?? globalThis.WebSocket
  }

  /** @inheritdoc */
  fetch(input: URL | Request, init?: RequestInit): Promise<Response> {
    if (this.closed) return Promise.reject(new Error('web carrier: 已关闭'))
    return this.fetcher(input, init)
  }

  /** @inheritdoc */
  async *connectDownlink(
    kind: DownlinkKind,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<Uint8Array> {
    if (this.closed) throw new Error('web carrier: 已关闭')
    const path = kind === 'mux' ? MUX_EVENTS_PATH : HOST_EVENTS_PATH
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new this.Socket(url)
    this.sockets.add(socket)
    const inbox: SocketItem[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      const bytes = typeof event.data === 'string'
        ? new TextEncoder().encode(event.data)
        : new Uint8Array()
      enqueue({ kind: 'frame', bytes })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const closeSocket = (): void => {
      if (socket.readyState === this.Socket.CONNECTING || socket.readyState === this.Socket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', closeSocket, { once: true })
    if (signal.aborted) closeSocket()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem
          if (item.kind === 'end') return
          yield item.bytes
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', closeSocket)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      closeSocket()
      this.sockets.delete(socket)
    }
  }

  /** @inheritdoc */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    for (const socket of [...this.sockets]) socket.close()
    this.sockets.clear()
    return Promise.resolve()
  }
}
