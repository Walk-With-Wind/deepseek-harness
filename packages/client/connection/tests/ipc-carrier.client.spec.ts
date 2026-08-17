import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import {
  IPC_MAX_CHUNK_BYTES,
  IPC_MAX_HEADER_BYTES,
  IpcClientCarrier,
  IpcHostBridge,
  ipcDataFrameSchema,
  type IpcDataFrame,
  type IpcMessagePort,
} from '../src/client/ipc/index.ts'

function trackedPort(
  port: NodeMessagePort,
  sent: IpcDataFrame[],
): IpcMessagePort {
  const listeners = new Map<(event: MessageEvent<unknown>) => void, (data: unknown) => void>()
  const closeListeners = new Map<() => void, () => void>()
  return {
    postMessage(message: unknown) {
      sent.push(structuredClone(message) as IpcDataFrame)
      port.postMessage(message)
    },
    addEventListener(_type, listener) {
      const wrapped = (data: unknown): void => { listener({ data } as MessageEvent<unknown>) }
      listeners.set(listener, wrapped)
      port.on('message', wrapped)
    },
    removeEventListener(_type, listener) {
      const wrapped = listeners.get(listener)
      if (wrapped === undefined) return
      listeners.delete(listener)
      port.off('message', wrapped)
    },
    subscribeClose(listener) {
      const wrapped = (): void => { listener() }
      closeListeners.set(listener, wrapped)
      port.on('close', wrapped)
      return () => {
        const current = closeListeners.get(listener)
        if (current === undefined) return
        closeListeners.delete(listener)
        port.off('close', current)
      }
    },
    start: port.start.bind(port),
    close: port.close.bind(port),
  }
}

function adaptedPort(port: NodeMessagePort): IpcMessagePort {
  return trackedPort(port, [])
}

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index % 251)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0
}

describe('IPC ClientCarrier', () => {
  it('接受跨 Realm 克隆后仍为独占 ArrayBuffer 的 Uint8Array 块', () => {
    const chunk = runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array

    expect(chunk instanceof Uint8Array).toBe(false)
    expect(ipcDataFrameSchema.safeParse({
      type: 'request-chunk',
      id: 'cross-realm',
      sequence: 0,
      chunk,
    }).success).toBe(true)
  })

  it('把任意分片的 SSE 下行转换为完整 JSON 信封并忽略注释', async () => {
    const channel = new MessageChannel()
    const encoder = new TextEncoder()
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 3,
      dispatch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': connec'))
          controller.enqueue(encoder.encode('ted\n\ndata: {"type":"server-'))
          controller.enqueue(encoder.encode('request","rpcId":"one"}\n\n'))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), { generation: 3 })

    const abort = new AbortController()
    const frames: string[] = []
    for await (const frame of carrier.connectDownlink('mux', abort.signal)) {
      frames.push(new TextDecoder().decode(frame))
    }
    expect(frames).toEqual(['{"type":"server-request","rpcId":"one"}'])

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('空闲 SSE 等待下一帧时保持背压，并允许并发一元调用', async () => {
    const channel = new MessageChannel()
    const encoder = new TextEncoder()
    let closeEvents!: () => void
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 5,
      dispatch: async request => request.url.endsWith('/api/events.mux')
        ? new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'))
            closeEvents = () => { controller.close() }
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ ok: true }),
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), { generation: 5 })
    const abort = new AbortController()
    const stream = carrier.connectDownlink('mux', abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()

    const response = await carrier.fetch(new URL('/api/test.echo', carrier.baseUrl))
    await expect(response.json()).resolves.toEqual({ ok: true })
    await expect(Promise.race([
      carrier.closed.then(error => error.code),
      new Promise<'open'>((resolve) => { setTimeout(() => { resolve('open') }, 20) }),
    ])).resolves.toBe('open')

    closeEvents()
    await expect(next).resolves.toEqual({ value: undefined, done: true })
    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('通过对称拉取协议等价传递请求和响应体', async () => {
    const channel = new MessageChannel()
    const rendererFrames: IpcDataFrame[] = []
    const utilityFrames: IpcDataFrame[] = []
    const requestBytes = bytes(IPC_MAX_CHUNK_BYTES * 2 + 17)
    let authority: string | undefined
    const host = new IpcHostBridge(trackedPort(channel.port1, utilityFrames), {
      generation: 4,
      dispatch: async (request, context) => {
        authority = context.authority
        expect(request.headers.get('content-type')).toBe('application/octet-stream')
        expect(sameBytes(new Uint8Array(await request.arrayBuffer()), requestBytes)).toBe(true)
        return new Response(new Uint8Array(requestBytes).buffer, {
          status: 201,
          headers: { 'content-type': 'application/octet-stream', etag: 'test-rev' },
        })
      },
    })
    const carrier = new IpcClientCarrier(trackedPort(channel.port2, rendererFrames), {
      generation: 4,
    })

    const response = await carrier.fetch(new URL('/api/test.echo', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(requestBytes).buffer,
    })
    expect(host.resourceSnapshot()).toEqual({
      phase: 'ready', inFlightRequests: 1, requestReaders: 0, responseReaders: 1,
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('etag')).toBe('test-rev')
    expect(sameBytes(new Uint8Array(await response.arrayBuffer()), requestBytes)).toBe(true)
    expect(authority).toBe('local')

    const requestChunks = rendererFrames.filter(frame => frame.type === 'request-chunk')
    const responseChunks = utilityFrames.filter(frame => frame.type === 'response-chunk')
    const requestPulls = utilityFrames.filter(frame => frame.type === 'request-pull')
    const responsePulls = rendererFrames.filter(frame => frame.type === 'response-pull')
    expect(requestChunks.length).toBeGreaterThan(2)
    expect(responseChunks.length).toBeGreaterThan(2)
    expect(requestPulls).toHaveLength(requestChunks.length + 1)
    expect(responsePulls).toHaveLength(responseChunks.length + 1)
    expect(requestChunks.every(frame => frame.type !== 'request-chunk' || frame.chunk.byteLength <= IPC_MAX_CHUNK_BYTES)).toBe(true)
    expect(responseChunks.every(frame => frame.type !== 'response-chunk' || frame.chunk.byteLength <= IPC_MAX_CHUNK_BYTES)).toBe(true)
    expect(requestChunks.every(frame => frame.type !== 'request-chunk'
      || frame.chunk.buffer.byteLength === frame.chunk.byteLength)).toBe(true)
    expect(responseChunks.every(frame => frame.type !== 'response-chunk'
      || frame.chunk.buffer.byteLength === frame.chunk.byteLength)).toBe(true)
    expect(host.resourceSnapshot()).toEqual({
      phase: 'ready', inFlightRequests: 0, requestReaders: 0, responseReaders: 0,
    })

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('把上游小分片合并为 1 MiB 请求块，减少跨进程复制次数', async () => {
    const channel = new MessageChannel()
    const rendererFrames: IpcDataFrame[] = []
    const totalBytes = IPC_MAX_CHUNK_BYTES * 2 + 17
    const sourceChunkBytes = 64 * 1024
    let offset = 0
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 16,
      dispatch: async (request) => {
        expect((await request.arrayBuffer()).byteLength).toBe(totalBytes)
        return new Response(null, { status: 204 })
      },
    })
    const carrier = new IpcClientCarrier(trackedPort(channel.port2, rendererFrames), { generation: 16 })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === totalBytes) {
          controller.close()
          return
        }
        const length = Math.min(sourceChunkBytes, totalBytes - offset)
        controller.enqueue(new Uint8Array(length))
        offset += length
      },
    }, { highWaterMark: 1 })

    const response = await carrier.fetch(new URL('/api/test.coalesced-upload', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-length': String(totalBytes) },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(response.status).toBe(204)
    expect(rendererFrames.flatMap(frame => frame.type === 'request-chunk' ? [frame.chunk.byteLength] : []))
      .toEqual([IPC_MAX_CHUNK_BYTES, IPC_MAX_CHUNK_BYTES, 17])

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('以 1 MiB 拉取块流式传输 100 MiB 请求且生产端不累计完整 body', async () => {
    const channel = new MessageChannel()
    const chunkCount = 100
    let produced = 0
    let consumed = 0
    let maxLead = 0
    let receivedBytes = 0
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 6,
      maxRequestBodyBytes: 160 * 1024 * 1024,
      dispatch: async (request) => {
        const reader = request.body?.getReader()
        if (reader === undefined) throw new Error('测试请求必须携带 body')
        while (true) {
          const item = await reader.read()
          if (item.done) break
          receivedBytes += item.value.byteLength
          consumed += 1
        }
        return new Response(null, { status: 204 })
      },
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), {
      generation: 6,
      maxRequestBodyBytes: 160 * 1024 * 1024,
    })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === chunkCount) {
          controller.close()
          return
        }
        produced += 1
        maxLead = Math.max(maxLead, produced - consumed)
        controller.enqueue(new Uint8Array(IPC_MAX_CHUNK_BYTES))
      },
    }, { highWaterMark: 1 })

    const response = await carrier.fetch(new URL('/api/test.large-upload', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-length': String(chunkCount * IPC_MAX_CHUNK_BYTES) },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(response.status).toBe(204)
    expect(receivedBytes).toBe(chunkCount * IPC_MAX_CHUNK_BYTES)
    expect(maxLead).toBeLessThanOrEqual(2)

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('物理端口关闭会结算 Host 在途请求并公开 bridge 关闭状态', async () => {
    const channel = new MessageChannel()
    let markDispatchStarted!: () => void
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve })
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve })
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 7,
      dispatch: async (request) => {
        markDispatchStarted()
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            observedAbort()
            resolve()
          }, { once: true })
        })
        throw request.signal.reason
      },
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), { generation: 7 })
    const pending = carrier.fetch(new URL('/api/test.wait', carrier.baseUrl))
    void pending.catch(() => undefined)
    await dispatchStarted

    channel.port2.close()

    await expect(host.closed).resolves.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await aborted
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
  })

  it('把 AbortSignal 映射为 Host 取消且只结算一次', async () => {
    const channel = new MessageChannel()
    let dispatchStarted!: () => void
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve })
    let hostObservedAbort!: () => void
    const aborted = new Promise<void>((resolve) => { hostObservedAbort = resolve })
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 8,
      dispatch: async (request) => {
        dispatchStarted()
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            hostObservedAbort()
            resolve()
          }, { once: true })
        })
        throw request.signal.reason
      },
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), { generation: 8 })
    const abort = new AbortController()
    const pending = carrier.fetch(new URL('/api/test.wait', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: abort.signal,
    })

    await started
    abort.abort('用户取消')
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await aborted

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('达到在途上限时立即拒绝新请求，不建立隐式队列', async () => {
    const channel = new MessageChannel()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 9,
      dispatch: async () => {
        await blocked
        return Response.json({ ok: true })
      },
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), {
      generation: 9,
      maxInFlightRequests: 1,
    })
    const first = carrier.fetch(new URL('/api/test.first', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    await expect(carrier.fetch(new URL('/api/test.second', carrier.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).rejects.toMatchObject({ code: 'LIMIT_IN_FLIGHT' })
    release()
    await expect((await first).json()).resolves.toEqual({ ok: true })

    await carrier.close('测试完成')
    await host.close('测试完成')
  })

  it('畸形或未知请求帧会关闭协议代际并清空 registry', async () => {
    const channel = new MessageChannel()
    const host = new IpcHostBridge(adaptedPort(channel.port1), {
      generation: 11,
      dispatch: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    })
    const carrier = new IpcClientCarrier(adaptedPort(channel.port2), { generation: 11 })
    await carrier.ready()

    channel.port1.postMessage({
      type: 'response-chunk',
      id: 'unknown',
      sequence: 0,
      chunk: new Uint8Array([1]),
    })
    await expect(carrier.closed).resolves.toMatchObject({ code: 'PROTOCOL_STATE' })
    await expect(carrier.fetch(new URL('/api/test.after-close', carrier.baseUrl), {
      method: 'GET',
    })).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })

    await host.close('测试完成')
  })

  it('Host 对原始 Renderer 帧重新校验 header 白名单、累计大小和声明长度', async () => {
    const channel = new MessageChannel()
    const dispatch = vi.fn(async (request: Request) => {
      await request.arrayBuffer()
      return new Response(null, { status: 204 })
    })
    const host = new IpcHostBridge(adaptedPort(channel.port1), { generation: 12, dispatch })
    channel.port2.postMessage({ type: 'data/hello', protocolVersion: 1, generation: 12 })
    await once(channel.port2, 'message')

    channel.port2.postMessage({
      type: 'request', generation: 12, id: 'forbidden-header', method: 'GET', path: '/api/test',
      headers: [['authorization', 'Bearer renderer-controlled']], hasBody: false,
    })
    await expect(once(channel.port2, 'message')).resolves.toEqual([
      expect.objectContaining({ type: 'failure', id: 'forbidden-header', code: 'PROTOCOL_HEADER' }),
    ])

    channel.port2.postMessage({
      type: 'request', generation: 12, id: 'oversized-header', method: 'GET', path: '/api/test',
      headers: [['x-dsh-test', 'x'.repeat(IPC_MAX_HEADER_BYTES)]], hasBody: false,
    })
    await expect(once(channel.port2, 'message')).resolves.toEqual([
      expect.objectContaining({ type: 'failure', id: 'oversized-header', code: 'LIMIT_HEADERS' }),
    ])

    channel.port2.postMessage({
      type: 'request', generation: 12, id: 'length-mismatch', method: 'POST', path: '/api/test',
      headers: [['content-length', '2']], hasBody: true,
    })
    await expect(once(channel.port2, 'message')).resolves.toEqual([
      expect.objectContaining({ type: 'request-pull', id: 'length-mismatch' }),
    ])
    channel.port2.postMessage({
      type: 'request-chunk', id: 'length-mismatch', sequence: 0, chunk: new Uint8Array([1]),
    })
    await expect(once(channel.port2, 'message')).resolves.toEqual([
      expect.objectContaining({ type: 'request-pull', id: 'length-mismatch' }),
    ])
    channel.port2.postMessage({ type: 'request-end', id: 'length-mismatch' })
    await expect(once(channel.port2, 'message')).resolves.toEqual([
      expect.objectContaining({ type: 'failure', id: 'length-mismatch', code: 'PROTOCOL_HEADER' }),
    ])

    expect(dispatch).toHaveBeenCalledOnce()
    await host.close('测试完成')
    channel.port2.close()
  })
})
