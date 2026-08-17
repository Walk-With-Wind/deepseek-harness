// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  SessionLogDownloadController, sessionLogZipFilename,
} from '../src/client/controller.ts'
import type { SessionLogSaver } from '../src/client/saver.ts'

const SID = 'session-export-controller' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionLogDownloadController', () => {
  it('通过产品 saver 保存并发布一个共享成功状态', async () => {
    const save = vi.fn<SessionLogSaver['save']>(() => Promise.resolve('saved'))
    const controller = new SessionLogDownloadController({ save })

    await controller.download(SID)

    expect(save).toHaveBeenCalledOnce()
    const request = save.mock.calls[0]?.[0]
    expect(request?.sessionId).toBe(SID)
    expect(request?.suggestedName).toBe('dsh-session-session-export-controller.zip')
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', error: null,
    })
  })

  it('collapses concurrent gestures and preserves a dismissed dialog', async () => {
    const response = Promise.withResolvers<'saved'>()
    const save = vi.fn(() => response.promise)
    const controller = new SessionLogDownloadController({ save })

    const first = controller.download(SID)
    const second = controller.download(SID)
    expect(first).toBe(second)
    controller.dismiss(SID)
    response.resolve('saved')
    await first

    expect(save).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    controller.dismiss(SID)
  })

  it('发布 saver 失败且不泄漏 rejection', async () => {
    const transport = new SessionLogDownloadController({ save: async () => { throw 'offline' } })
    await transport.download(SID)
    expect(transport.store.getSnapshot().bySession[SID]?.error).toBe('offline')

    transport.dismiss('absent' as SessionId)

    const cancelled = new SessionLogDownloadController({ save: () => Promise.resolve('cancelled') })
    await cancelled.download(SID)
    expect(cancelled.store.getSnapshot().bySession[SID]).toEqual({
      open: false, status: 'cancelled', error: null,
    })
  })

  it('aborts active fetches on disposal and rejects later requests', async () => {
    let signal: AbortSignal | undefined
    const save = vi.fn((request: Parameters<SessionLogSaver['save']>[0]) => new Promise<'saved'>((_resolve, reject) => {
      signal = request.signal
      signal?.addEventListener('abort', () => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }))
    const controller = new SessionLogDownloadController({ save })
    const pending = controller.download(SID)

    await controller.dispose()

    await expect(pending).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.download(SID)).resolves.toBeUndefined()
    await controller.dispose()
  })

  it('defaults dialog openness when state is externally cleared before settlement', async () => {
    const success = Promise.withResolvers<'saved'>()
    const successful = new SessionLogDownloadController({ save: () => success.promise })
    const successRun = successful.download(SID)
    successful.store.set({ bySession: {} })
    success.resolve('saved')
    await successRun
    expect(successful.store.getSnapshot().bySession[SID]?.open).toBe(true)

    const failure = Promise.withResolvers<'saved'>()
    const failing = new SessionLogDownloadController({ save: () => failure.promise })
    const failureRun = failing.download(SID)
    failing.store.set({ bySession: {} })
    failure.reject(new Error('failed after clear'))
    await failureRun
    expect(failing.store.getSnapshot().bySession[SID]?.open).toBe(true)
  })
})

describe('Session 导出文件名', () => {
  it('清理不安全字符', () => {
    expect(sessionLogZipFilename('a/b' as SessionId)).toBe('dsh-session-a_b.zip')
  })
})
