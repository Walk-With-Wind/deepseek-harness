/** 在受保护 release runner 上执行 60 分钟 Desktop IPC 耐久门禁。 */
import {
  DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS,
  measureDesktopUnaryIpcLatency,
  runDesktopIpcEndurance,
} from './lib/desktop-ipc-endurance.ts'

if (process.env.CI !== 'true') {
  throw new Error('desktop-ipc-endurance: 只允许在一次性 CI runner 上执行 60 分钟验收')
}

const unaryLatency = await measureDesktopUnaryIpcLatency({
  warmupRequests: 20,
  sampleRequests: 100,
  maxExtraRoundTripP95Ms: DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS,
})
const result = await runDesktopIpcEndurance({
  durationMs: 60 * 60 * 1000,
  sampleIntervalMs: 60 * 1000,
  responseChunkBytes: 4 * 1024,
  responseChunkCount: 16,
  portCycleRequests: 100,
  requestDelayMs: 25,
  maxRssGrowthBytes: 128 * 1024 * 1024,
})
console.log(JSON.stringify({ outcome: 'passed', unaryLatency, ...result }, null, 2))
