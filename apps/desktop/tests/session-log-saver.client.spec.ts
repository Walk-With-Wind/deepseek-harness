import { describe, expect, it, vi } from 'vitest'
import { DesktopSessionLogSaver } from '../src/renderer/session-log-saver.ts'
import type { DesktopRendererApi } from '../src/shared/renderer-protocol.ts'

function createApi(invoke: DesktopRendererApi['invoke']): DesktopRendererApi {
  return {
    bootstrap: () => Promise.reject(new Error('测试不使用 bootstrap')),
    releaseDataPort: () => { throw new Error('测试不使用数据端口') },
    invoke,
    onHostState: () => () => undefined,
    onUpdateState: () => () => undefined,
  }
}

describe('DesktopSessionLogSaver', () => {
  it('把保存请求收敛为窄命令并返回保存结果', async () => {
    const invoke = vi.fn<DesktopRendererApi['invoke']>(async command => ({
      type: 'session-log/result',
      operationId: 'operationId' in command ? command.operationId : 'missing',
      outcome: 'saved',
    }))
    const saver = new DesktopSessionLogSaver(createApi(invoke), () => 'op-1')

    await expect(saver.save({
      sessionId: 'session-1' as never,
      suggestedName: 'session.zip',
      signal: new AbortController().signal,
    })).resolves.toBe('saved')
    expect(invoke).toHaveBeenCalledWith({
      type: 'session-log/save',
      operationId: 'op-1',
      sessionId: 'session-1',
      suggestedName: 'session.zip',
    })
  })

  it('取消时通知 Main 且不会把失败的取消通知覆盖原始结算', async () => {
    const abort = new AbortController()
    const invoke = vi.fn<DesktopRendererApi['invoke']>(async (command) => {
      if (command.type === 'session-log/save') {
        abort.abort()
        return { type: 'session-log/result', operationId: command.operationId, outcome: 'cancelled' }
      }
      throw new Error('取消通知失败')
    })
    const saver = new DesktopSessionLogSaver(createApi(invoke), () => 'op-2')

    await expect(saver.save({
      sessionId: 'session-2' as never,
      suggestedName: 'session.zip',
      signal: abort.signal,
    })).resolves.toBe('cancelled')
    expect(invoke).toHaveBeenCalledWith({ type: 'operation/cancel', operationId: 'op-2' })
  })

  it('将 Utility 的稳定失败转成用户可见异常', async () => {
    const saver = new DesktopSessionLogSaver(createApi(async command => ({
      type: 'session-log/result',
      operationId: 'operationId' in command ? command.operationId : 'missing',
      outcome: 'failed',
      message: '磁盘空间不足',
    })), () => 'op-3')

    await expect(saver.save({
      sessionId: 'session-3' as never,
      suggestedName: 'session.zip',
      signal: new AbortController().signal,
    })).rejects.toThrow('磁盘空间不足')
  })
})
