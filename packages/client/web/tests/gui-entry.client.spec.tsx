// @vitest-environment jsdom
/**
 * 通用 GUI 启动入口：显式参数注入，以及 Web 包装层对旧启动清单的兼容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientCarrier } from '@deepseek-ai/dsh-client-connection/client'
import type {
  BootManifest,
  ClientPluginHandoff,
  DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import {
  AppGuiEntry,
  AppWebEntry,
  type GuiPlatformCapabilities,
} from '../src/boot.tsx'

interface ProbeResult {
  carrier?: ClientCarrier
  platform?: GuiPlatformCapabilities
}

const win = globalThis as DshWindow

function testCarrier(): ClientCarrier {
  return {
    authority: 'local',
    baseUrl: 'http://dsh.internal',
    fetch: () => Promise.reject(new Error('测试载体不执行 Fetch')),
    async *connectDownlink() {},
    close: vi.fn(() => Promise.resolve()),
  }
}

function probeManifest(): BootManifest {
  return {
    rev: 'test',
    modules: [{ id: 'probe', url: '/probe.js', rev: 'test' }],
    plugins: [{ id: 'probe', inject: [], immediately: true }],
  }
}

function probeLoader(result: ProbeResult): (url: string) => Promise<void> {
  return async (url) => {
    expect(url).toBe('/probe.js')
    const handoff: ClientPluginHandoff = {
      id: 'probe',
      factory: () => ({
        name: 'probe',
        inject: ['clientCarrier', 'guiPlatform'],
        apply(ctx: Context) {
          result.carrier = ctx.clientCarrier
          result.platform = ctx.guiPlatform
        },
      }),
    }
    win.__ModuleLoader__?.load(handoff)
  }
}

function mountPoint(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  delete win.__DSH_BOOT__
  delete win.__DSH_MODULES__
  delete win.__ModuleLoader__
  vi.restoreAllMocks()
})

describe('AppGuiEntry', () => {
  it('把显式载体与平台能力提供给客户端插件图', async () => {
    const result: ProbeResult = {}
    const carrier = testCarrier()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const entry = new AppGuiEntry(mountPoint(), {
      manifest: probeManifest(),
      carrier,
      platformCapabilities: { kind: 'desktop' },
      loadBundle: probeLoader(result),
    })

    await entry.run()
    expect(result).toEqual({ carrier, platform: { kind: 'desktop' } })
    expect(error).toHaveBeenCalled()
    entry.dispose()
  })

  it('把产品私有 provider 作为静态插件加入同一 Loader 生命周期', async () => {
    let applied = false
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const entry = new AppGuiEntry(mountPoint(), {
      manifest: { rev: 'test', modules: [], plugins: [] },
      carrier: testCarrier(),
      platformCapabilities: { kind: 'desktop' },
      staticPlugins: [{
        id: '@deepseek-ai/dsh-desktop-platform',
        module: {
          inject: ['guiPlatform'],
          apply(ctx: Context) {
            applied = ctx.guiPlatform.kind === 'desktop'
          },
        },
      }],
    })

    await entry.run()
    expect(applied).toBe(true)
    entry.dispose()
  })

  it('Web 包装层在缺少启动清单时立即失败', () => {
    expect(() => new AppWebEntry(mountPoint()).run()).toThrow(/__DSH_BOOT__ is missing/)
  })

  it('Web 包装层解析现有全局清单并提供 Web 平台能力', async () => {
    const result: ProbeResult = {}
    win.__DSH_BOOT__ = {
      rev: 'test',
      entries: [{ id: 'probe', url: '/probe.js', rev: 'test', immediately: true }],
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const entry = new AppWebEntry(mountPoint(), { loadBundle: probeLoader(result) })

    await entry.run()
    expect(result.carrier?.authority).toBe('local')
    expect(result.platform).toEqual({ kind: 'web' })
    entry.dispose()
  })
})
