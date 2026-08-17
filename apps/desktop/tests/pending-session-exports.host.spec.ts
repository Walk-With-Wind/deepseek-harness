import { describe, expect, it } from 'vitest'
import { PendingSessionExports } from '../src/main/pending-session-exports.ts'

describe('PendingSessionExports', () => {
  it('对话框打开前即预留操作，并拒绝重复 id', async () => {
    const exports = new PendingSessionExports()
    const first = exports.reserve('operation-1', 1, 7)

    expect(first).toBeDefined()
    expect(exports.reserve('operation-1', 1, 8)).toBeUndefined()
    expect(exports.markRunning(first!)).toBe(true)
    expect(exports.settle(first!, {
      type: 'session-log/result', operationId: 'operation-1', outcome: 'saved',
    })).toBe(true)
    await expect(first!.result).resolves.toMatchObject({ outcome: 'saved' })
  })

  it('选择路径期间取消后不能再启动导出', async () => {
    const exports = new PendingSessionExports()
    const pending = exports.reserve('operation-2', 2, 9)!

    expect(exports.cancel('operation-2', 9)).toEqual({ accepted: true, forward: false, generation: 2 })
    expect(exports.markRunning(pending)).toBe(false)
    expect(exports.settle(pending, {
      type: 'session-log/result', operationId: 'operation-2', outcome: 'cancelled',
    })).toBe(false)
    await expect(pending.result).resolves.toMatchObject({ outcome: 'cancelled' })
  })

  it('运行中的操作向 Utility 转发取消，关停会结算当前代际', async () => {
    const exports = new PendingSessionExports()
    const running = exports.reserve('operation-3', 3, 10)!
    const other = exports.reserve('operation-4', 4, 10)!

    expect(exports.markRunning(running)).toBe(true)
    expect(exports.cancel('operation-3', 11)).toEqual({
      accepted: false, forward: false, generation: undefined,
    })
    expect(exports.cancel('operation-3', 10)).toEqual({ accepted: true, forward: true, generation: 3 })
    exports.failGeneration(3)

    await expect(running.result).resolves.toMatchObject({
      outcome: 'failed', message: '本地运行时已停止，导出结果未知',
    })
    expect(exports.isCurrent(other)).toBe(true)
  })
})
