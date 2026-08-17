/** Desktop IPC 耐久验收的缩短回归测试。 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS,
  DESKTOP_UNARY_IPC_PAYLOAD_BYTES,
  measureDesktopUnaryIpcLatency,
  runDesktopIpcEndurance,
} from './desktop-ipc-endurance.ts'

describe('Desktop IPC endurance', () => {
  it('持续完成与取消分块流，并跨端口代际保持内存有界', async () => {
    const result = await runDesktopIpcEndurance({
      durationMs: 150,
      sampleIntervalMs: 10,
      responseChunkBytes: 1024,
      responseChunkCount: 4,
      portCycleRequests: 5,
      requestDelayMs: 0,
      maxRssGrowthBytes: 64 * 1024 * 1024,
    })
    expect(result.completedRequests).toBeGreaterThan(0)
    expect(result.cancelledRequests).toBeGreaterThan(0)
    expect(result.portGenerations).toBeGreaterThan(1)
    expect(result.peakRssGrowthBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('测量请求和响应各 1 KiB 的 unary IPC 额外 p95 往返开销', async () => {
    const result = await measureDesktopUnaryIpcLatency({
      warmupRequests: 5,
      sampleRequests: 20,
      maxExtraRoundTripP95Ms: 100,
    })
    expect(result.requestBytes).toBe(DESKTOP_UNARY_IPC_PAYLOAD_BYTES)
    expect(result.responseBytes).toBe(DESKTOP_UNARY_IPC_PAYLOAD_BYTES)
    expect(result.sampleRequests).toBe(20)
    expect(result.ipcRoundTripP95Ms).toBeGreaterThan(0)
    expect(result.directDispatchP95Ms).toBeGreaterThan(0)
    expect(result.extraRoundTripP95Ms).toBeGreaterThanOrEqual(0)
    expect(DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS).toBe(10)
  })

  it('拒绝不足以形成稳定 p95 的 unary IPC 样本', async () => {
    await expect(measureDesktopUnaryIpcLatency({
      warmupRequests: 0,
      sampleRequests: 19,
      maxExtraRoundTripP95Ms: 10,
    })).rejects.toThrow('参数必须是有效的有界数值')
  })
})
