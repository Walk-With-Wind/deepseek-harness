/** Desktop IPC 长流、取消和端口轮换耐久验收。 */
import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import {
  IpcClientCarrier,
  IpcHostBridge,
  type IpcMessagePort,
} from '../../packages/client/connection/src/client/ipc/index.ts'

/** Unary IPC 性能验收固定使用 1 KiB 请求和 1 KiB 响应。 */
export const DESKTOP_UNARY_IPC_PAYLOAD_BYTES = 1024

/** Unary IPC 相对同一业务分发的额外 p95 往返开销上限。 */
export const DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS = 10

/** Unary IPC 性能验收参数。 */
export interface DesktopUnaryIpcLatencyOptions {
  readonly warmupRequests: number
  readonly sampleRequests: number
  readonly maxExtraRoundTripP95Ms: number
}

/** Unary IPC 性能验收输出的可归档指标。 */
export interface DesktopUnaryIpcLatencyResult {
  readonly requestBytes: number
  readonly responseBytes: number
  readonly sampleRequests: number
  readonly directDispatchP95Ms: number
  readonly ipcRoundTripP95Ms: number
  readonly extraRoundTripP95Ms: number
}

/** IPC 耐久验收参数。 */
export interface DesktopIpcEnduranceOptions {
  readonly durationMs: number
  readonly sampleIntervalMs: number
  readonly responseChunkBytes: number
  readonly responseChunkCount: number
  readonly portCycleRequests: number
  readonly requestDelayMs: number
  readonly maxRssGrowthBytes: number
}

/** IPC 耐久验收输出的可归档指标。 */
export interface DesktopIpcEnduranceResult {
  readonly durationMs: number
  readonly completedRequests: number
  readonly cancelledRequests: number
  readonly portGenerations: number
  readonly peakRssGrowthBytes: number
  readonly tailRssGrowthBytes: number
}

/**
 * 比较同一 unary handler 的直连和 IPC 路径，验证 1 KiB 额外往返开销。
 * @param options - 预热次数、样本数和额外 p95 门槛。
 * @returns 直连、IPC 和两者差值的 p95 指标。
 */
export async function measureDesktopUnaryIpcLatency(
  options: DesktopUnaryIpcLatencyOptions,
): Promise<DesktopUnaryIpcLatencyResult> {
  validateLatencyOptions(options)
  const payload = new Uint8Array(DESKTOP_UNARY_IPC_PAYLOAD_BYTES)
  payload.fill(0x5a)
  const dispatch = async (request: Request): Promise<Response> => {
    const requestBody = new Uint8Array(await request.arrayBuffer())
    if (requestBody.byteLength !== DESKTOP_UNARY_IPC_PAYLOAD_BYTES) {
      throw new Error(`desktop-ipc-endurance: unary 请求体不是 ${String(DESKTOP_UNARY_IPC_PAYLOAD_BYTES)} 字节`)
    }
    return new Response(requestBody, {
      headers: { 'content-type': 'application/octet-stream' },
    })
  }
  const channel = new MessageChannel()
  const host = new IpcHostBridge(adaptPort(channel.port1), { generation: 1, dispatch })
  const carrier = new IpcClientCarrier(adaptPort(channel.port2), { generation: 1 })
  try {
    await carrier.ready()
    for (let index = 0; index < options.warmupRequests; index += 1) {
      await readUnaryResponse(await carrier.fetch(new URL('/api/latency', carrier.baseUrl), {
        method: 'POST',
        body: payload,
      }))
    }
    const directDurations: number[] = []
    const ipcDurations: number[] = []
    for (let index = 0; index < options.sampleRequests; index += 1) {
      const directStartedAt = performance.now()
      await readUnaryResponse(await dispatch(new Request('http://dsh.internal/api/latency', {
        method: 'POST',
        body: payload,
      })))
      directDurations.push(performance.now() - directStartedAt)

      const ipcStartedAt = performance.now()
      await readUnaryResponse(await carrier.fetch(new URL('/api/latency', carrier.baseUrl), {
        method: 'POST',
        body: payload,
      }))
      ipcDurations.push(performance.now() - ipcStartedAt)
    }
    const directDispatchP95Ms = percentile95(directDurations)
    const ipcRoundTripP95Ms = percentile95(ipcDurations)
    const extraRoundTripP95Ms = Math.max(0, ipcRoundTripP95Ms - directDispatchP95Ms)
    if (extraRoundTripP95Ms > options.maxExtraRoundTripP95Ms) {
      throw new Error(
        `desktop-ipc-endurance: 1 KiB unary IPC 额外 p95 往返开销超限，`
        + `actual=${extraRoundTripP95Ms.toFixed(3)}ms limit=${options.maxExtraRoundTripP95Ms.toFixed(3)}ms`,
      )
    }
    return {
      requestBytes: DESKTOP_UNARY_IPC_PAYLOAD_BYTES,
      responseBytes: DESKTOP_UNARY_IPC_PAYLOAD_BYTES,
      sampleRequests: options.sampleRequests,
      directDispatchP95Ms,
      ipcRoundTripP95Ms,
      extraRoundTripP95Ms,
    }
  } finally {
    await carrier.close('unary IPC 性能验收完成')
    await host.close('unary IPC 性能验收完成')
  }
}

/**
 * 持续传输分块响应并轮换端口，验证取消可结算且 RSS 不持续增长。
 * @param options - 时长、流分块、端口轮换和内存门槛。
 * @returns 请求、取消、代际和 RSS 指标。
 */
export async function runDesktopIpcEndurance(
  options: DesktopIpcEnduranceOptions,
): Promise<DesktopIpcEnduranceResult> {
  validateOptions(options)
  const deadline = Date.now() + options.durationMs
  const samples: number[] = []
  let nextSampleAt = Date.now()
  let completedRequests = 0
  let cancelledRequests = 0
  let portGenerations = 0
  let generation = 0

  while (Date.now() < deadline) {
    generation += 1
    portGenerations += 1
    const channel = new MessageChannel()
    const host = new IpcHostBridge(adaptPort(channel.port1), {
      generation,
      dispatch: async request => new Response(createResponseBody(request.signal, options), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    })
    const carrier = new IpcClientCarrier(adaptPort(channel.port2), { generation })
    try {
      for (let index = 0; index < options.portCycleRequests && Date.now() < deadline; index += 1) {
        const response = await carrier.fetch(new URL('/api/endurance.stream', carrier.baseUrl))
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error('desktop-ipc-endurance: 流式响应缺少 body')
        if ((completedRequests + cancelledRequests + 1) % 5 === 0) {
          await reader.read()
          await reader.cancel('耐久验收主动取消')
          cancelledRequests += 1
        } else {
          while (!(await reader.read()).done) { /* 拉取到流结束即完成一次请求。 */ }
          completedRequests += 1
        }
        if (Date.now() >= nextSampleAt) {
          samples.push(process.memoryUsage().rss)
          nextSampleAt = Date.now() + options.sampleIntervalMs
        }
        if (options.requestDelayMs > 0) await delay(options.requestDelayMs)
      }
    } finally {
      await carrier.close('耐久代际轮换')
      await host.close('耐久代际轮换')
    }
  }

  samples.push(process.memoryUsage().rss)
  if (completedRequests === 0 || cancelledRequests === 0 || portGenerations < 2) {
    throw new Error('desktop-ipc-endurance: 未覆盖完成、取消和端口代际轮换')
  }
  const baselineRss = samples[0]!
  const peakRssGrowthBytes = Math.max(0, ...samples.map(value => value - baselineRss))
  const windowSize = Math.max(1, Math.min(5, Math.floor(samples.length / 2)))
  const head = median(samples.slice(0, windowSize))
  const tail = median(samples.slice(-windowSize))
  const tailRssGrowthBytes = Math.max(0, tail - head)
  if (peakRssGrowthBytes > options.maxRssGrowthBytes
    || tailRssGrowthBytes > options.maxRssGrowthBytes / 2) {
    throw new Error(
      `desktop-ipc-endurance: RSS 增长超限，peak=${String(peakRssGrowthBytes)} tail=${String(tailRssGrowthBytes)}`,
    )
  }
  return {
    durationMs: options.durationMs,
    completedRequests,
    cancelledRequests,
    portGenerations,
    peakRssGrowthBytes,
    tailRssGrowthBytes,
  }
}

function adaptPort(port: NodeMessagePort): IpcMessagePort {
  const listeners = new Map<(event: MessageEvent<unknown>) => void, (data: unknown) => void>()
  return {
    postMessage(message) { port.postMessage(message) },
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
    start: port.start.bind(port),
    close: port.close.bind(port),
  }
}

function createResponseBody(
  signal: AbortSignal,
  options: DesktopIpcEnduranceOptions,
): ReadableStream<Uint8Array> {
  let chunks = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || chunks === options.responseChunkCount) {
        controller.close()
        return
      }
      if (options.requestDelayMs > 0) await delay(options.requestDelayMs)
      chunks += 1
      controller.enqueue(new Uint8Array(options.responseChunkBytes))
    },
  }, { highWaterMark: 0 })
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!
}

async function readUnaryResponse(response: Response): Promise<void> {
  const responseBytes = (await response.arrayBuffer()).byteLength
  if (responseBytes !== DESKTOP_UNARY_IPC_PAYLOAD_BYTES) {
    throw new Error(`desktop-ipc-endurance: unary 响应体不是 ${String(DESKTOP_UNARY_IPC_PAYLOAD_BYTES)} 字节`)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

function validateOptions(options: DesktopIpcEnduranceOptions): void {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 50
    || !Number.isSafeInteger(options.sampleIntervalMs) || options.sampleIntervalMs <= 0
    || !Number.isSafeInteger(options.responseChunkBytes) || options.responseChunkBytes <= 0
    || !Number.isSafeInteger(options.responseChunkCount) || options.responseChunkCount <= 1
    || !Number.isSafeInteger(options.portCycleRequests) || options.portCycleRequests < 2
    || !Number.isSafeInteger(options.requestDelayMs) || options.requestDelayMs < 0
    || !Number.isSafeInteger(options.maxRssGrowthBytes) || options.maxRssGrowthBytes <= 0) {
    throw new Error('desktop-ipc-endurance: 参数必须是有效的有界整数')
  }
}

function validateLatencyOptions(options: DesktopUnaryIpcLatencyOptions): void {
  if (!Number.isSafeInteger(options.warmupRequests) || options.warmupRequests < 0
    || !Number.isSafeInteger(options.sampleRequests) || options.sampleRequests < 20
    || !Number.isFinite(options.maxExtraRoundTripP95Ms) || options.maxExtraRoundTripP95Ms <= 0) {
    throw new Error('desktop-ipc-endurance: 参数必须是有效的有界数值')
  }
}
