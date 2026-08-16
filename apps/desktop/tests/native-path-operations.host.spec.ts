import { describe, expect, it, vi } from 'vitest'
import { DesktopNativePathOperations } from '../src/main/native-path-operations.ts'

describe('DesktopNativePathOperations', () => {
  it('按 intent 执行一次原生打开并返回当前代际结果', async () => {
    const openDefault = vi.fn(() => Promise.resolve())
    const openTextFile = vi.fn(() => Promise.resolve())
    const results: unknown[] = []
    const operations = new DesktopNativePathOperations({ openDefault, openTextFile })

    await operations.open({
      generation: 2, operationId: 'path-1', path: '/workspace/file.txt', intent: 'text-editor',
    }, (frame) => { results.push(frame) })

    expect(openDefault).not.toHaveBeenCalled()
    expect(openTextFile).toHaveBeenCalledWith('/workspace/file.txt', expect.any(AbortSignal))
    expect(results).toEqual([{
      type: 'path/result', generation: 2, operationId: 'path-1', outcome: 'opened',
    }])
  })

  it('取消和代际失效会终止原生操作且不回送过期结果', async () => {
    const signals: AbortSignal[] = []
    const openDefault = vi.fn((_path: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signals.push(signal)
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('路径打开已取消'))
      }, { once: true })
    }))
    const results: unknown[] = []
    const operations = new DesktopNativePathOperations({
      openDefault,
      openTextFile: () => Promise.resolve(),
    })
    const cancelled = operations.open({
      generation: 4, operationId: 'path-cancel', path: '/workspace/a.txt', intent: 'default',
    }, (frame) => { results.push(frame) })
    operations.cancel(4, 'path-cancel')
    await cancelled

    const invalidated = operations.open({
      generation: 4, operationId: 'path-stale', path: '/workspace/b.txt', intent: 'default',
    }, (frame) => { results.push(frame) })
    operations.failGeneration(4)
    await invalidated

    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(results).toEqual([])
  })

  it('拒绝重复 operation id 并把原生错误收敛为稳定结果', async () => {
    const first = Promise.withResolvers<undefined>()
    const operations = new DesktopNativePathOperations({
      openDefault: () => first.promise,
      openTextFile: async () => { throw new Error('/secret/path: application failed') },
    })
    const results: unknown[] = []
    const opening = operations.open({
      generation: 5, operationId: 'same', path: '/workspace/a.txt', intent: 'default',
    }, (frame) => { results.push(frame) })

    await expect(operations.open({
      generation: 5, operationId: 'same', path: '/workspace/b.txt', intent: 'default',
    }, (frame) => { results.push(frame) })).resolves.toBeUndefined()
    await operations.open({
      generation: 5, operationId: 'failed', path: '/workspace/c.txt', intent: 'text-editor',
    }, (frame) => { results.push(frame) })
    first.resolve(undefined)
    await opening

    expect(results).toContainEqual({
      type: 'path/result', generation: 5, operationId: 'same',
      outcome: 'failed', message: '路径操作 id 重复',
    })
    expect(results).toContainEqual({
      type: 'path/result', generation: 5, operationId: 'failed',
      outcome: 'failed', message: '无法使用系统应用打开该路径',
    })
  })
})
