/** 最终安装应用真实 Electron 数据端口的 1 KiB unary 延迟门禁。 */
import type { ClientCarrier } from '@deepseek-ai/dsh-client-connection/carrier'

/** unary 请求与响应的固定容量。 */
export const DESKTOP_INSTALLED_UNARY_BYTES = 1024

/** 真实安装态 IPC 相对同一 Utility handler 的额外 p95 上限。 */
const DESKTOP_INSTALLED_UNARY_MAX_EXTRA_P95_MS = 10

const LATENCY_PATH = '/api/desktop-installed-unary-latency'
const RESULT_PATH = '/api/desktop-installed-unary-latency/result'

/** 安装态 unary 延迟采样参数。 */
export interface InstalledUnaryLatencyOptions {
  readonly warmupRequests: number
  readonly sampleRequests: number
  readonly now?: () => number
}

/** 可归档的安装态 unary 延迟指标。 */
export interface InstalledUnaryLatencyResult {
  readonly requestBytes: number
  readonly responseBytes: number
  readonly sampleRequests: number
  readonly directDispatchP95Ms: number
  readonly ipcRoundTripP95Ms: number
  readonly extraRoundTripP95Ms: number
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] as number
}

async function sampleUnary(
  carrier: ClientCarrier,
  payload: ArrayBuffer,
  now: () => number,
): Promise<{ readonly roundTripMs: number; readonly directDispatchMs: number }> {
  const startedAt = now()
  const response = await carrier.fetch(new URL(LATENCY_PATH, carrier.baseUrl), {
    method: 'POST',
    body: payload,
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const roundTripMs = now() - startedAt
  if (!response.ok) throw new Error(`安装态 unary 延迟 handler 返回 HTTP ${String(response.status)}`)
  if (bytes.byteLength !== DESKTOP_INSTALLED_UNARY_BYTES) {
    throw new Error(`安装态 unary 响应体不是 ${String(DESKTOP_INSTALLED_UNARY_BYTES)} 字节`)
  }
  const directDispatchHeader = response.headers.get('x-dsh-acceptance-dispatch-ms')
  const directDispatchMs = Number(directDispatchHeader)
  if (directDispatchHeader === null || !Number.isFinite(directDispatchMs) || directDispatchMs < 0) {
    throw new Error('安装态 unary 响应缺少 Utility 直连耗时')
  }
  return { roundTripMs, directDispatchMs }
}

/**
 * 从 Renderer 经 Preload 转交的真实 MessagePort 测量 1 KiB unary p95。
 * @param carrier - 当前 Renderer 已完成握手的 IPC carrier。
 * @param options - 预热、样本数量和可测试时钟。
 * @returns 相同 Utility handler 的直连、跨进程往返与额外 p95。
 */
export async function measureInstalledUnaryLatency(
  carrier: ClientCarrier,
  options: InstalledUnaryLatencyOptions,
): Promise<InstalledUnaryLatencyResult> {
  if (!Number.isSafeInteger(options.warmupRequests) || options.warmupRequests < 0
    || !Number.isSafeInteger(options.sampleRequests) || options.sampleRequests <= 0) {
    throw new Error('安装态 unary 延迟采样参数无效')
  }
  const payload = new ArrayBuffer(DESKTOP_INSTALLED_UNARY_BYTES)
  new Uint8Array(payload).fill(0x5a)
  const now = options.now ?? performance.now.bind(performance)
  for (let index = 0; index < options.warmupRequests; index += 1) {
    await sampleUnary(carrier, payload, now)
  }
  const roundTrips: number[] = []
  const directDispatches: number[] = []
  for (let index = 0; index < options.sampleRequests; index += 1) {
    const sample = await sampleUnary(carrier, payload, now)
    roundTrips.push(sample.roundTripMs)
    directDispatches.push(sample.directDispatchMs)
  }
  const directDispatchP95Ms = percentile95(directDispatches)
  const ipcRoundTripP95Ms = percentile95(roundTrips)
  return {
    requestBytes: DESKTOP_INSTALLED_UNARY_BYTES,
    responseBytes: DESKTOP_INSTALLED_UNARY_BYTES,
    sampleRequests: options.sampleRequests,
    directDispatchP95Ms,
    ipcRoundTripP95Ms,
    extraRoundTripP95Ms: Math.max(0, ipcRoundTripP95Ms - directDispatchP95Ms),
  }
}

/**
 * 执行固定安装态门禁，并把成功或失败结果交回 Utility 一次性验收插件归档。
 * @param carrier - 当前 Renderer 的真实 IPC carrier。
 * @returns 结果已由 Utility 接收后解决；失败指标会在归档后抛出。
 */
export async function runInstalledUnaryLatencyAcceptance(carrier: ClientCarrier): Promise<void> {
  let payload: Record<string, unknown>
  try {
    const result = await measureInstalledUnaryLatency(carrier, {
      warmupRequests: 20,
      sampleRequests: 100,
    })
    payload = result.extraRoundTripP95Ms <= DESKTOP_INSTALLED_UNARY_MAX_EXTRA_P95_MS
      ? { outcome: 'passed', ...result }
      : {
        outcome: 'failed', ...result,
        message: `1 KiB unary IPC 额外 p95 ${result.extraRoundTripP95Ms.toFixed(3)} ms 超过 10 ms`,
      }
  } catch (error) {
    payload = { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  const response = await carrier.fetch(new URL(RESULT_PATH, carrier.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`安装态 unary 延迟结果归档失败：HTTP ${String(response.status)}`)
  if (payload.outcome === 'failed') throw new Error(String(payload.message))
}
