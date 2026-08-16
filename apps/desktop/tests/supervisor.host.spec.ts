import { describe, expect, it } from 'vitest'
import {
  initialSupervisorState,
  reduceSupervisor,
  type SupervisorState,
} from '../src/main/supervisor.ts'
import { DEFAULT_DESKTOP_CONFIG } from '../src/shared/control-protocol.ts'

function start(): SupervisorState {
  return reduceSupervisor(initialSupervisorState(), { type: 'start', at: 0 }).state
}

describe('Desktop Supervisor reducer', () => {
  it('Utility ready 只创建窗口，当前代际 Renderer ready 后才进入 READY', () => {
    const starting = start()
    expect(starting).toMatchObject({ phase: 'STARTING', generation: 1 })
    expect(reduceSupervisor(starting, { type: 'host-ready', generation: 0, at: 10 }).state).toBe(starting)
    const hostReady = reduceSupervisor(starting, { type: 'host-ready', generation: 1, at: 10 })
    expect(hostReady.state).toBe(starting)
    expect(hostReady.effects.map(effect => effect.type)).toEqual(['show-main-window'])
    const rendererReady = reduceSupervisor(starting, { type: 'renderer-ready', generation: 1, at: 11 })
    expect(rendererReady.state).toMatchObject({ phase: 'READY', generation: 1 })
    expect(rendererReady.effects.map(effect => effect.type)).toEqual(['cancel-boot-timeout'])
  })

  it('启动阶段的 Utility 退出立即进入可重试故障态', () => {
    const transition = reduceSupervisor(start(), { type: 'utility-exit', generation: 1, at: 1 })
    expect(transition.state.phase).toBe('FAILED')
    expect(transition.effects.map(effect => effect.type)).toEqual([
      'cancel-boot-timeout',
      'close-data-ports',
      'replace-with-recovery',
    ])
  })

  it('启动失败会关闭当前 Utility，避免重试时发生 HostLease 冲突', () => {
    const failed = reduceSupervisor(start(), {
      type: 'host-failed', generation: 1, code: 'BOOT_FAILED', at: 1,
    })
    expect(failed.effects.map(effect => effect.type)).toEqual([
      'cancel-boot-timeout',
      'close-data-ports',
      'replace-with-recovery',
    ])
    const timeout = reduceSupervisor(start(), { type: 'boot-timeout', generation: 1, at: 1 })
    expect(timeout.effects.map(effect => effect.type)).toEqual(['close-data-ports', 'replace-with-recovery'])
  })

  it('启动失败后的立即重试等待旧 Utility 退出再创建下一代', () => {
    const failed = reduceSupervisor(start(), {
      type: 'host-failed', generation: 1, code: 'BOOT_FAILED', at: 1,
    })
    const queued = reduceSupervisor(failed.state, { type: 'retry', at: 2 })
    expect(queued.state).toMatchObject({ phase: 'FAILED', cleanupPending: true, retryPending: true })
    expect(queued.effects).toEqual([])

    const restarted = reduceSupervisor(queued.state, { type: 'utility-exit', generation: 1, at: 3 })
    expect(restarted.state).toMatchObject({ phase: 'STARTING', generation: 2 })
    expect(restarted.effects.map(effect => effect.type)).toEqual(['spawn-utility', 'arm-boot-timeout'])
  })

  it('异常退出按指数退避恢复，预算耗尽后打开熔断', () => {
    let state = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const crashed = reduceSupervisor(state, { type: 'utility-exit', generation: state.generation, at: 1000 + attempt })
      expect(crashed.state.phase).toBe('RECOVERING')
      expect(crashed.effects.some(effect => effect.type === 'schedule-restart')).toBe(true)
      state = reduceSupervisor(crashed.state, { type: 'restart-due', at: 2000 + attempt }).state
      state = reduceSupervisor(state, { type: 'renderer-ready', generation: state.generation, at: 2001 + attempt }).state
    }
    const exhausted = reduceSupervisor(state, { type: 'utility-exit', generation: state.generation, at: 3000 })
    expect(exhausted.state.phase).toBe('CIRCUIT_OPEN')
    expect(exhausted.effects.map(effect => effect.type)).toContain('replace-with-recovery')
  })

  it('异常恢复延迟使用可注入且有界的随机抖动', () => {
    const ready = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    const config = {
      ...DEFAULT_DESKTOP_CONFIG,
      restartBaseDelayMs: 1_000,
      restartMaxDelayMs: 10_000,
      restartJitterMs: 250,
    }
    const lower = reduceSupervisor(ready, { type: 'utility-exit', generation: 1, at: 2 }, config, () => 0)
    const midpoint = reduceSupervisor(ready, { type: 'utility-exit', generation: 1, at: 2 }, config, () => 0.5)
    const upper = reduceSupervisor(ready, { type: 'utility-exit', generation: 1, at: 2 }, config, () => 1)

    expect(lower.effects).toContainEqual({ type: 'schedule-restart', delayMs: 750 })
    expect(midpoint.effects).toContainEqual({ type: 'schedule-restart', delayMs: 1_000 })
    expect(upper.effects).toContainEqual({ type: 'schedule-restart', delayMs: 1_250 })
  })

  it('恢复阶段同时等待退避到期与旧 Utility 退出后才启动新代际', () => {
    const ready = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    const recovering = reduceSupervisor(ready, { type: 'health-failed', generation: 1, at: 2 })
    expect(recovering.state).toMatchObject({
      phase: 'RECOVERING', cleanupPending: true, restartPending: false,
    })

    const dueFirst = reduceSupervisor(recovering.state, { type: 'restart-due', at: 3 })
    expect(dueFirst.state).toMatchObject({
      phase: 'RECOVERING', cleanupPending: true, restartPending: true,
    })
    expect(dueFirst.effects).toEqual([])
    expect(reduceSupervisor(dueFirst.state, {
      type: 'utility-exit', generation: 1, at: 4,
    }).effects.map(effect => effect.type)).toEqual(['spawn-utility', 'arm-boot-timeout'])

    const exitedFirst = reduceSupervisor(recovering.state, {
      type: 'utility-exit', generation: 1, at: 3,
    })
    expect(exitedFirst.state).toMatchObject({
      phase: 'RECOVERING', cleanupPending: false, restartPending: false,
    })
    expect(exitedFirst.effects).toEqual([])
    expect(reduceSupervisor(exitedFirst.state, {
      type: 'restart-due', at: 4,
    }).effects.map(effect => effect.type)).toEqual(['spawn-utility', 'arm-boot-timeout'])
  })

  it('Renderer 崩溃只替换窗口与数据端口，不重启健康 Utility', () => {
    const ready = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    const transition = reduceSupervisor(ready, { type: 'renderer-gone', generation: 1, at: 2 })
    expect(transition.state).toMatchObject({ phase: 'DEGRADED', degradedBy: 'renderer' })
    expect(transition.effects.map(effect => effect.type)).toEqual([
      'cancel-renderer-timeout', 'replace-renderer', 'arm-renderer-timeout',
    ])
    const restored = reduceSupervisor(transition.state, { type: 'renderer-ready', generation: 1, at: 3 })
    expect(restored.state).toMatchObject({ phase: 'READY' })
    expect(restored.effects).toEqual([{ type: 'cancel-renderer-timeout' }])
  })

  it('启动期和替换期 Renderer 再次失败都会继续恢复且带 ready 超时', () => {
    const first = reduceSupervisor(start(), { type: 'renderer-gone', generation: 1, at: 1 })
    expect(first.state).toMatchObject({ phase: 'DEGRADED', degradedBy: 'renderer' })
    expect(first.effects.map(effect => effect.type)).toEqual([
      'cancel-boot-timeout', 'replace-renderer', 'arm-renderer-timeout',
    ])
    const second = reduceSupervisor(first.state, { type: 'renderer-gone', generation: 1, at: 2 })
    expect(second.state.rendererFailures).toHaveLength(2)
    expect(second.effects.map(effect => effect.type)).toEqual([
      'cancel-renderer-timeout', 'replace-renderer', 'arm-renderer-timeout',
    ])
    const timedOut = reduceSupervisor(second.state, { type: 'renderer-timeout', generation: 1, at: 3 })
    expect(timedOut.state.rendererFailures).toHaveLength(3)
    const explicitFailure = reduceSupervisor(first.state, {
      type: 'renderer-failed', generation: 1, code: 'GUI_BOOT_FAILED', at: 4,
    })
    expect(explicitFailure.state.rendererFailures).toHaveLength(2)
    expect(explicitFailure.effects.map(effect => effect.type)).toEqual([
      'cancel-renderer-timeout', 'replace-renderer', 'arm-renderer-timeout',
    ])
  })

  it('Renderer 独立恢复超过时间窗预算后只熔断 Renderer，手动重试复用健康 Utility', () => {
    let state = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = reduceSupervisor(state, {
        type: 'renderer-gone', generation: 1, at: 100 + attempt,
      }).state
      state = reduceSupervisor(state, {
        type: 'renderer-ready', generation: 1, at: 200 + attempt,
      }).state
    }
    const exhausted = reduceSupervisor(state, { type: 'renderer-gone', generation: 1, at: 400 })
    expect(exhausted.state).toMatchObject({
      phase: 'CIRCUIT_OPEN', generation: 1, degradedBy: 'renderer', cleanupPending: false,
    })
    expect(exhausted.effects).toEqual([
      { type: 'cancel-renderer-timeout' },
      { type: 'replace-with-recovery', code: 'RENDERER_RESTART_BUDGET_EXHAUSTED' },
    ])

    const retried = reduceSupervisor(exhausted.state, { type: 'retry', at: 401 })
    expect(retried.state).toMatchObject({
      phase: 'DEGRADED', generation: 1, degradedBy: 'renderer', rendererFailures: [],
    })
    expect(retried.effects).toEqual([
      { type: 'replace-renderer', generation: 1 },
      { type: 'arm-renderer-timeout', generation: 1, delayMs: DEFAULT_DESKTOP_CONFIG.bootTimeoutMs },
    ])

    const utilityExited = reduceSupervisor(exhausted.state, {
      type: 'utility-exit', generation: 1, at: 402,
    })
    expect(utilityExited.state).toMatchObject({
      phase: 'RECOVERING', generation: 1, degradedBy: undefined, cleanupPending: false,
    })
    expect(utilityExited.effects.map(effect => effect.type)).toEqual([
      'close-data-ports', 'schedule-restart',
    ])
  })

  it('休眠恢复先降级并探测 Utility，健康回复后恢复 READY', () => {
    const ready = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    const probing = reduceSupervisor(ready, { type: 'health-check', generation: 1, at: 2 })
    expect(probing.state).toMatchObject({ phase: 'DEGRADED', degradedBy: 'health' })
    expect(probing.effects.map(effect => effect.type)).toEqual(['send-health-probe', 'arm-health-timeout'])

    const healthy = reduceSupervisor(probing.state, { type: 'health-ready', generation: 1, at: 3 })
    expect(healthy.state).toMatchObject({ phase: 'READY' })
    expect(healthy.effects).toEqual([{ type: 'cancel-health-timeout' }])

    const failed = reduceSupervisor(probing.state, { type: 'health-failed', generation: 1, at: 4 })
    expect(failed.state.phase).toBe('RECOVERING')
    expect(failed.effects.map(effect => effect.type)).toEqual([
      'cancel-health-timeout', 'close-data-ports', 'schedule-restart',
    ])
  })

  it('关停只接受首个原因，等待 Utility 真实退出并按超时升级', () => {
    const ready = reduceSupervisor(start(), { type: 'renderer-ready', generation: 1, at: 1 }).state
    const stopping = reduceSupervisor(ready, { type: 'stop', reason: 'quit', at: 2 })
    expect(stopping.state).toMatchObject({ phase: 'STOPPING', stopReason: 'quit' })
    expect(reduceSupervisor(stopping.state, { type: 'stop', reason: 'update', at: 3 }).state).toBe(stopping.state)
    expect(reduceSupervisor(stopping.state, { type: 'shutdown-timeout', at: 4 }).effects)
      .toEqual([{ type: 'terminate-utility', generation: 1 }])
    expect(reduceSupervisor(stopping.state, { type: 'host-quiescent', generation: 1, at: 4 }).effects)
      .toEqual([])
    expect(reduceSupervisor(stopping.state, { type: 'utility-exit', generation: 1, at: 5 }).effects)
      .toEqual([{ type: 'finish-stop', generation: 1 }])
  })
})
