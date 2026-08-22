/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import { apply } from '../src/renderer/platform-plugin.ts'
import type { DesktopRendererApi } from '../src/shared/renderer-protocol.ts'

function createApi(): DesktopRendererApi {
  return {
    bootstrap: () => Promise.reject(new Error('测试不使用 bootstrap')),
    releaseDataPort: () => { throw new Error('测试不使用数据端口') },
    invoke: () => Promise.reject(new Error('测试不调用 Main')),
    onHostState: () => () => undefined,
    onUpdateState: () => () => undefined,
  }
}

describe('Desktop Renderer 平台插件', () => {
  it('等待 unary 与双下行流完成连接后才结算启动', async () => {
    const state: { description?: HostDescription } = {}
    const listeners = new Set<() => void>()
    const hostDescription: HostDescriptionSource = {
      getSnapshot: () => state.description,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const provide = vi.fn()
    const context = {
      connection: { hostDescription },
      provide,
    } as unknown as Context
    Object.defineProperty(window, 'dshDesktop', { configurable: true, value: createApi() })

    let settled = false
    const applying = apply(context).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(provide).toHaveBeenCalledWith('sessionLogSaver', expect.anything())

    state.description = {} as HostDescription
    for (const listener of listeners) listener()
    await applying
    expect(settled).toBe(true)
    expect(listeners).toHaveLength(0)
  })
})
