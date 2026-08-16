import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { IpcHostBridge } from '@deepseek-ai/dsh-client-connection/ipc-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopUtilityControl } from '../src/utility/control.ts'
import { DEFAULT_DESKTOP_CONFIG, type UtilityControlFrame } from '../src/shared/control-protocol.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DesktopUtilityControl', () => {
  it('报告当前代际的 bridge、reader 和原生操作资源计数', async () => {
    const control = new DesktopUtilityControl(2, DEFAULT_DESKTOP_CONFIG, () => undefined)
    expect(control.resourceSnapshot()).toEqual({
      bridges: 0,
      inFlightRequests: 0,
      requestReaders: 0,
      responseReaders: 0,
      exports: 0,
      directoryDialogs: 0,
      nativePaths: 0,
    })
    await control.dispose()
  })

  it('数据端口物理关闭后立即移除 bridge，不延迟到 Utility 整体关停', async () => {
    const closeListeners = new Set<() => void>()
    const port = {
      on(event: string, listener: () => void) {
        if (event === 'close') closeListeners.add(listener)
        return this
      },
      off(event: string, listener: () => void) {
        if (event === 'close') closeListeners.delete(listener)
        return this
      },
      postMessage() {},
      start() {},
      close() {},
    } as unknown as Electron.MessagePortMain
    const bridgeClose = vi.spyOn(IpcHostBridge.prototype, 'close')
    const control = new DesktopUtilityControl(3, DEFAULT_DESKTOP_CONFIG, () => undefined)
    control.attachContext({ connection: { dispatch: vi.fn() } } as unknown as Context)
    control.receive({
      type: 'data/attach', generation: 3, connectionId: 'renderer-1',
    }, [port])

    for (const listener of closeListeners) listener()
    await Promise.resolve()
    await control.dispose()

    expect(bridgeClose).not.toHaveBeenCalled()
  })

  it('以一次性 operation id 请求 Main 打开路径并等待结果', async () => {
    const frames: UtilityControlFrame[] = []
    const control = new DesktopUtilityControl(7, DEFAULT_DESKTOP_CONFIG, (frame) => { frames.push(frame) })
    const opening = control.openPath('/workspace/file.txt', 'default', new AbortController().signal)
    const request = frames[0]
    expect(request).toMatchObject({
      type: 'path/open', generation: 7, path: '/workspace/file.txt', intent: 'default',
    })
    if (request?.type !== 'path/open') throw new Error('未发送 path/open')

    control.receive({
      type: 'path/result', generation: 7, operationId: request.operationId, outcome: 'opened',
    }, [])

    await expect(opening).resolves.toBeUndefined()
    await control.dispose()
  })

  it('取消路径打开会清理等待项并通知 Main', async () => {
    const frames: UtilityControlFrame[] = []
    const control = new DesktopUtilityControl(8, DEFAULT_DESKTOP_CONFIG, (frame) => { frames.push(frame) })
    const abort = new AbortController()
    const opening = control.openPath('/workspace/file.txt', 'text-editor', abort.signal)
    const request = frames[0]
    if (request?.type !== 'path/open') throw new Error('未发送 path/open')

    abort.abort(new DOMException('用户取消', 'AbortError'))

    await expect(opening).rejects.toThrow('用户取消')
    expect(frames[1]).toEqual({
      type: 'path/cancel', generation: 8, operationId: request.operationId,
    })
    control.receive({
      type: 'path/result', generation: 8, operationId: request.operationId,
      outcome: 'failed', message: '过期结果',
    }, [])
    await control.dispose()
  })

  it('关停会取消并等待在途导出完成清理后才报告 dispose 完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-control-'))
    roots.push(root)
    let markPullStarted!: () => void
    const pullStarted = new Promise<void>((resolve) => { markPullStarted = resolve })
    let finishRead!: () => void
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        markPullStarted()
        return new Promise<void>((resolve) => {
          finishRead = () => {
            controller.close()
            resolve()
          }
        })
      },
    }))
    const dispatch = vi.fn(() => Promise.resolve(response))
    const frames: UtilityControlFrame[] = []
    const control = new DesktopUtilityControl(1, DEFAULT_DESKTOP_CONFIG, (frame) => { frames.push(frame) })
    control.attachContext({ connection: { dispatch } } as unknown as Context)
    control.receive({
      type: 'export/start', generation: 1, operationId: 'export-1', sessionId: 'session-1',
      targetPath: join(root, 'session.zip'),
    }, [])
    await pullStarted

    let disposed = false
    const disposing = control.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finishRead()
    await disposing

    expect(frames).toContainEqual({
      type: 'export/result', generation: 1, operationId: 'export-1', outcome: 'cancelled',
    })
    expect(await readdir(root)).toEqual([])
  })
})
