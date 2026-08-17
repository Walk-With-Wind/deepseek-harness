/** 验证 1 KiB Desktop unary IPC 的额外 p95 往返开销。 */
import {
  DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS,
  measureDesktopUnaryIpcLatency,
} from './lib/desktop-ipc-endurance.ts'

const result = await measureDesktopUnaryIpcLatency({
  warmupRequests: 20,
  sampleRequests: 100,
  maxExtraRoundTripP95Ms: DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS,
})
console.log(JSON.stringify({ outcome: 'passed', ...result }, null, 2))
