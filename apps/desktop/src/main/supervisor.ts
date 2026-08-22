/** Desktop Main 的纯监督状态机。实际 Electron 副作用由外层驱动执行。 */
import { DEFAULT_DESKTOP_CONFIG, type DesktopConfig } from '../shared/control-protocol.ts'

/** Main Supervisor 生命周期状态。 */
type SupervisorPhase =
  | 'COLD' | 'STARTING' | 'READY' | 'DEGRADED' | 'RECOVERING'
  | 'FAILED' | 'CIRCUIT_OPEN' | 'STOPPING' | 'STOPPED'

/** 可序列化、可快照的监督状态。 */
export interface SupervisorState {
  readonly phase: SupervisorPhase
  readonly generation: number
  readonly failures: readonly number[]
  readonly rendererFailures: readonly number[]
  readonly degradedBy?: 'health' | 'renderer' | undefined
  readonly stopReason?: string
  readonly cleanupPending?: boolean
  readonly retryPending?: boolean
  readonly restartPending?: boolean
}

/** 驱动状态机的闭合事件。 */
export type SupervisorEvent =
  | { readonly type: 'start'; readonly at: number }
  | { readonly type: 'host-ready'; readonly generation: number; readonly at: number }
  | { readonly type: 'renderer-ready'; readonly generation: number; readonly at: number }
  | { readonly type: 'renderer-failed'; readonly generation: number; readonly code: string; readonly at: number }
  | { readonly type: 'host-failed'; readonly generation: number; readonly code: string; readonly at: number }
  | { readonly type: 'boot-timeout'; readonly generation: number; readonly at: number }
  | { readonly type: 'utility-exit'; readonly generation: number; readonly at: number }
  | { readonly type: 'renderer-gone'; readonly generation: number; readonly at: number }
  | { readonly type: 'renderer-timeout'; readonly generation: number; readonly at: number }
  | { readonly type: 'health-check'; readonly generation: number; readonly at: number }
  | { readonly type: 'health-ready'; readonly generation: number; readonly at: number }
  | { readonly type: 'health-failed'; readonly generation: number; readonly at: number }
  | { readonly type: 'healthy-window'; readonly generation: number; readonly at: number }
  | { readonly type: 'restart-due'; readonly at: number }
  | { readonly type: 'retry'; readonly at: number }
  | { readonly type: 'stop'; readonly reason: string; readonly at: number }
  | { readonly type: 'host-quiescent'; readonly generation: number; readonly at: number }
  | { readonly type: 'shutdown-timeout'; readonly at: number }
  | { readonly type: 'terminate-timeout'; readonly at: number }
  | { readonly type: 'stopped'; readonly at: number }

/** 状态转换交给 Electron 外层执行的命令。 */
export type SupervisorEffect =
  | { readonly type: 'spawn-utility'; readonly generation: number }
  | { readonly type: 'arm-boot-timeout'; readonly generation: number; readonly delayMs: number }
  | { readonly type: 'cancel-boot-timeout' }
  | { readonly type: 'show-main-window' }
  | { readonly type: 'replace-with-recovery'; readonly code: string }
  | { readonly type: 'close-data-ports'; readonly generation: number }
  | { readonly type: 'schedule-restart'; readonly delayMs: number }
  | { readonly type: 'replace-renderer'; readonly generation: number }
  | { readonly type: 'arm-renderer-timeout'; readonly generation: number; readonly delayMs: number }
  | { readonly type: 'cancel-renderer-timeout' }
  | { readonly type: 'send-health-probe'; readonly generation: number }
  | { readonly type: 'arm-health-timeout'; readonly generation: number; readonly delayMs: number }
  | { readonly type: 'cancel-health-timeout' }
  | { readonly type: 'begin-shutdown'; readonly generation: number; readonly reason: string; readonly delayMs: number }
  | { readonly type: 'terminate-utility'; readonly generation: number }
  | { readonly type: 'kill-utility'; readonly generation: number }
  | { readonly type: 'finish-stop'; readonly generation: number }

/** 一个纯状态转换及其有序副作用。 */
export interface SupervisorTransition {
  readonly state: SupervisorState
  readonly effects: readonly SupervisorEffect[]
}

/** 创建尚未启动的 Supervisor 状态。 */
export function initialSupervisorState(): SupervisorState {
  return { phase: 'COLD', generation: 0, failures: [], rendererFailures: [] }
}

/**
 * 根据事件推进监督状态；旧代际事件是无副作用 no-op。
 * @param state - 当前监督状态。
 * @param event - 待处理的生命周期事件。
 * @param config - 已校验的 Desktop 配置。
 * @param random - 返回 0 到 1 的随机源；测试可注入确定值。
 * @returns 新状态及需要由 Electron 外层执行的副作用。
 */
export function reduceSupervisor(
  state: SupervisorState,
  event: SupervisorEvent,
  config: DesktopConfig = DEFAULT_DESKTOP_CONFIG,
  random: () => number = Math.random,
): SupervisorTransition {
  switch (event.type) {
    case 'start':
      if (state.phase !== 'COLD') return unchanged(state)
      return startGeneration(state, state.failures, config)
    case 'host-ready':
      if (state.phase !== 'STARTING' || event.generation !== state.generation) return unchanged(state)
      return { state, effects: [{ type: 'show-main-window' }] }
    case 'renderer-ready':
      if (event.generation !== state.generation) return unchanged(state)
      if (state.phase === 'STARTING') {
        return {
          state: { ...state, phase: 'READY', degradedBy: undefined },
          effects: [{ type: 'cancel-boot-timeout' }],
        }
      }
      if (state.phase === 'DEGRADED' && state.degradedBy === 'renderer') {
        return {
          state: { ...state, phase: 'READY', degradedBy: undefined },
          effects: [{ type: 'cancel-renderer-timeout' }],
        }
      }
      return unchanged(state)
    case 'host-failed':
      if (state.phase !== 'STARTING' || event.generation !== state.generation) return unchanged(state)
      return {
        state: { ...state, phase: 'FAILED', cleanupPending: true, retryPending: false },
        effects: [
          { type: 'cancel-boot-timeout' },
          { type: 'close-data-ports', generation: state.generation },
          { type: 'replace-with-recovery', code: event.code },
        ],
      }
    case 'renderer-failed':
      if (event.generation !== state.generation) return unchanged(state)
      if (state.phase === 'STARTING') {
        return prependEffect(recoverRenderer(state, event.at, config), { type: 'cancel-boot-timeout' })
      }
      if (state.phase === 'DEGRADED' && state.degradedBy === 'renderer') {
        return prependEffect(recoverRenderer(state, event.at, config), { type: 'cancel-renderer-timeout' })
      }
      return unchanged(state)
    case 'boot-timeout':
      if (state.phase !== 'STARTING' || event.generation !== state.generation) return unchanged(state)
      return {
        state: { ...state, phase: 'FAILED', cleanupPending: true, retryPending: false },
        effects: [
          { type: 'close-data-ports', generation: state.generation },
          { type: 'replace-with-recovery', code: 'HOST_BOOT_TIMEOUT' },
        ],
      }
    case 'utility-exit':
      if (event.generation !== state.generation) return unchanged(state)
      if (state.phase === 'STOPPING') {
        return { state, effects: [{ type: 'finish-stop', generation: state.generation }] }
      }
      if (state.phase === 'RECOVERING' && state.cleanupPending) {
        const cleaned = { ...state, cleanupPending: false }
        return state.restartPending
          ? startGeneration({ ...cleaned, restartPending: false }, cleaned.failures, config)
          : unchanged(cleaned)
      }
      if ((state.phase === 'FAILED' || state.phase === 'CIRCUIT_OPEN') && state.cleanupPending) {
        const cleaned = { ...state, cleanupPending: false }
        return state.retryPending
          ? startGeneration({ ...cleaned, retryPending: false, rendererFailures: [] }, [], config)
          : unchanged(cleaned)
      }
      if (state.phase === 'CIRCUIT_OPEN' && state.degradedBy === 'renderer') {
        // Renderer 熔断期间 Utility 仍由 Host 监督；此时真实退出应进入 Host 恢复域。
        return recoverAfterFailure({ ...state, degradedBy: undefined, rendererFailures: [] }, event.at, false, config, random)
      }
      if (state.phase === 'STARTING') {
        return {
          state: { ...state, phase: 'FAILED', cleanupPending: false, retryPending: false },
          effects: [
            { type: 'cancel-boot-timeout' },
            { type: 'close-data-ports', generation: state.generation },
            { type: 'replace-with-recovery', code: 'UTILITY_EXITED_DURING_BOOT' },
          ],
        }
      }
      if (state.phase !== 'READY' && state.phase !== 'DEGRADED') return unchanged(state)
      return recoverAfterFailure(state, event.at, false, config, random)
    case 'health-failed':
      if (event.generation !== state.generation
        || (state.phase !== 'READY' && state.degradedBy !== 'health')) {
        return unchanged(state)
      }
      return prependEffect(recoverAfterFailure(state, event.at, true, config, random), { type: 'cancel-health-timeout' })
    case 'health-check':
      if (state.phase !== 'READY' || event.generation !== state.generation) return unchanged(state)
      return {
        state: { ...state, phase: 'DEGRADED', degradedBy: 'health' },
        effects: [
          { type: 'send-health-probe', generation: state.generation },
          { type: 'arm-health-timeout', generation: state.generation, delayMs: config.resumeHealthTimeoutMs },
        ],
      }
    case 'health-ready':
      if (state.phase !== 'DEGRADED' || state.degradedBy !== 'health'
        || event.generation !== state.generation) return unchanged(state)
      return {
        state: { ...state, phase: 'READY', degradedBy: undefined },
        effects: [{ type: 'cancel-health-timeout' }],
      }
    case 'renderer-gone':
      if (event.generation !== state.generation) return unchanged(state)
      if (state.phase === 'STARTING') {
        return prependEffect(recoverRenderer(state, event.at, config), { type: 'cancel-boot-timeout' })
      }
      if (state.phase !== 'READY' && !(state.phase === 'DEGRADED' && state.degradedBy === 'renderer')) {
        return unchanged(state)
      }
      return prependEffect(recoverRenderer(state, event.at, config), { type: 'cancel-renderer-timeout' })
    case 'renderer-timeout':
      if (event.generation !== state.generation
        || state.phase !== 'DEGRADED' || state.degradedBy !== 'renderer') return unchanged(state)
      return recoverRenderer(state, event.at, config)
    case 'healthy-window':
      if (state.phase !== 'READY' || event.generation !== state.generation) return unchanged(state)
      return { state: { ...state, failures: [] }, effects: [] }
    case 'restart-due':
      if (state.phase !== 'RECOVERING') return unchanged(state)
      if (state.cleanupPending) return {
        state: { ...state, restartPending: true },
        effects: [],
      }
      return startGeneration(state, state.failures, config)
    case 'retry':
      if (state.phase !== 'FAILED' && state.phase !== 'CIRCUIT_OPEN') return unchanged(state)
      if (state.phase === 'CIRCUIT_OPEN' && state.degradedBy === 'renderer') {
        return {
          state: {
            ...state, phase: 'DEGRADED', degradedBy: 'renderer', rendererFailures: [],
            cleanupPending: false, retryPending: false,
          },
          effects: [
            { type: 'replace-renderer', generation: state.generation },
            { type: 'arm-renderer-timeout', generation: state.generation, delayMs: config.bootTimeoutMs },
          ],
        }
      }
      if (state.cleanupPending) return { state: { ...state, retryPending: true }, effects: [] }
      return startGeneration({ ...state, rendererFailures: [] }, [], config)
    case 'stop':
      if (state.phase === 'STOPPING' || state.phase === 'STOPPED') return unchanged(state)
      return {
        state: { ...state, phase: 'STOPPING', stopReason: event.reason },
        effects: [{
          type: 'begin-shutdown',
          generation: state.generation,
          reason: event.reason,
          delayMs: config.shutdownGraceMs,
        }],
      }
    case 'host-quiescent':
      if (state.phase !== 'STOPPING' || event.generation !== state.generation) return unchanged(state)
      return unchanged(state)
    case 'shutdown-timeout':
      if (state.phase !== 'STOPPING') return unchanged(state)
      return { state, effects: [{ type: 'terminate-utility', generation: state.generation }] }
    case 'terminate-timeout':
      if (state.phase !== 'STOPPING') return unchanged(state)
      return { state, effects: [{ type: 'kill-utility', generation: state.generation }] }
    case 'stopped':
      if (state.phase !== 'STOPPING') return unchanged(state)
      return { state: { ...state, phase: 'STOPPED' }, effects: [] }
    default:
      return assertNever(event)
  }
}

function startGeneration(
  state: SupervisorState,
  failures: readonly number[],
  config: DesktopConfig,
): SupervisorTransition {
  const generation = state.generation + 1
  return {
    state: {
      phase: 'STARTING', generation, failures, rendererFailures: [],
      cleanupPending: false, retryPending: false, restartPending: false,
    },
    effects: [
      { type: 'spawn-utility', generation },
      { type: 'arm-boot-timeout', generation, delayMs: config.bootTimeoutMs },
    ],
  }
}

function recoverRenderer(
  state: SupervisorState,
  at: number,
  config: DesktopConfig,
): SupervisorTransition {
  const rendererFailures = [
    ...state.rendererFailures.filter(time => at - time <= config.restartWindowMs),
    at,
  ]
  if (rendererFailures.length > config.restartMaxAttempts) {
    return {
      state: {
        ...state, phase: 'CIRCUIT_OPEN', rendererFailures, degradedBy: 'renderer',
        cleanupPending: false, retryPending: false,
      },
      effects: [
        { type: 'replace-with-recovery', code: 'RENDERER_RESTART_BUDGET_EXHAUSTED' },
      ],
    }
  }
  return {
    state: { ...state, phase: 'DEGRADED', rendererFailures, degradedBy: 'renderer' },
    effects: [
      { type: 'replace-renderer', generation: state.generation },
      { type: 'arm-renderer-timeout', generation: state.generation, delayMs: config.bootTimeoutMs },
    ],
  }
}

function prependEffect(
  transition: SupervisorTransition,
  effect: SupervisorEffect,
): SupervisorTransition {
  return { state: transition.state, effects: [effect, ...transition.effects] }
}

function recoverAfterFailure(
  state: SupervisorState,
  at: number,
  cleanupPending: boolean,
  config: DesktopConfig,
  random: () => number,
): SupervisorTransition {
  const failures = [...state.failures.filter(time => at - time <= config.restartWindowMs), at]
  const close: SupervisorEffect = { type: 'close-data-ports', generation: state.generation }
  if (failures.length > config.restartMaxAttempts) {
    return {
      state: {
        ...state, phase: 'CIRCUIT_OPEN', failures, cleanupPending,
        retryPending: false, restartPending: false,
      },
      effects: [close, { type: 'replace-with-recovery', code: 'HOST_RESTART_BUDGET_EXHAUSTED' }],
    }
  }
  const baseDelayMs = Math.min(
    config.restartBaseDelayMs * (2 ** Math.max(0, failures.length - 1)),
    config.restartMaxDelayMs,
  )
  // 对称抖动在达到上限后仍会打散重启时刻，同时不突破配置的最大延迟。
  const jitterMs = Math.round((random() - 0.5) * 2 * config.restartJitterMs)
  const delayMs = Math.max(0, Math.min(baseDelayMs + jitterMs, config.restartMaxDelayMs))
  return {
    state: {
      ...state, phase: 'RECOVERING', failures, cleanupPending,
      retryPending: false, restartPending: false,
    },
    effects: [close, { type: 'schedule-restart', delayMs }],
  }
}

function unchanged(state: SupervisorState): SupervisorTransition {
  return { state, effects: [] }
}

function assertNever(value: never): never {
  throw new Error(`desktop supervisor: 未处理事件 ${JSON.stringify(value)}`)
}
