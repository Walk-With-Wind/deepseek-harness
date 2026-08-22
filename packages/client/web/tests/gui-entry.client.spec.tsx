// @vitest-environment jsdom
/** Shared GUI entry: explicit Desktop inputs and the Web bootstrap adapter. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WebClientCarrier, type ClientCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/bootstrap'
import type {
  BootManifest,
  ClientBundleRegistration,
  ClientModuleCreateOptions,
  ClientModuleLoaderTarget,
  DshWindow,
} from '@deepseek-ai/dsh-client-modules/bootstrap'
import {
  AppGuiEntry,
  AppWebEntry,
  type GuiPlatformCapabilities,
  type GuiStaticPlugin,
} from '../src/boot.ts'

interface ProbeResult {
  carrier?: ClientCarrier
  platform?: GuiPlatformCapabilities
}

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow
const moduleFace = modulesClient as unknown as Record<string, unknown>

function testCarrier(): ClientCarrier {
  return {
    authority: 'local',
    baseUrl: 'http://dsh.internal',
    fetch: () => Promise.reject(new Error('test carrier does not perform Fetch')),
    async *connectDownlink() {},
    close: vi.fn(() => Promise.resolve()),
  }
}

function probeManifest(): BootManifest {
  return {
    rev: 'test',
    modules: [
      { id: MODULES_ID, url: '/modules.js', rev: 'test', external: [] },
      { id: 'probe', url: '/probe.js', rev: 'test', external: [] },
    ],
    plugins: [
      { id: MODULES_ID, inject: [], immediately: true },
      { id: 'probe', inject: [], immediately: true },
    ],
  }
}

function probeRegistration(result: ProbeResult): ClientBundleRegistration {
  return {
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
}

function rendererPlugin(): GuiStaticPlugin {
  return {
    id: '@deepseek-ai/dsh-test-renderer',
    module: {
      apply(ctx: Context) {
        ctx.reflect.provide('uiRenderer', {
          mount: (element: HTMLElement) => {
            element.textContent = 'mounted'
            return () => {}
          },
        })
      },
    },
  }
}

function installFacade(
  entries: readonly ClientBundleRegistration[],
): ClientModuleLoaderTarget {
  const pendingQueue = [...entries]
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: (options: ClientModuleCreateOptions) => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options),
  }
  win.__ModuleLoader__ = target
  return target
}

function mountPoint(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  vi.restoreAllMocks()
})

describe('AppGuiEntry', () => {
  it('provides the explicit carrier and platform capabilities to the client graph', async () => {
    const result: ProbeResult = {}
    const carrier = testCarrier()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const entry = new AppGuiEntry(mountPoint(), {
      manifest: probeManifest(),
      carrier,
      platformCapabilities: { kind: 'desktop' },
      staticPlugins: [rendererPlugin()],
      loadBundle: async (url) => {
        expect(url).toBe('/probe.js')
        win.__ModuleLoader__?.load(probeRegistration(result))
      },
    })

    await expect(entry.run()).resolves.toEqual({ outcome: 'ready' })
    expect(result).toEqual({ carrier, platform: { kind: 'desktop' } })
    expect(error).not.toHaveBeenCalled()
    await entry.dispose()
  })

  it('adds product-private providers to the same Loader lifecycle', async () => {
    let applied = false
    const entry = new AppGuiEntry(mountPoint(), {
      manifest: { rev: 'test', modules: [], plugins: [] },
      carrier: testCarrier(),
      platformCapabilities: { kind: 'desktop' },
      staticPlugins: [
        {
          id: '@deepseek-ai/dsh-desktop-platform',
          module: {
            inject: ['guiPlatform'],
            apply(ctx: Context) {
              applied = ctx.guiPlatform.kind === 'desktop'
            },
          },
        },
        rendererPlugin(),
      ],
    })

    await expect(entry.run()).resolves.toEqual({ outcome: 'ready' })
    expect(applied).toBe(true)
    await entry.dispose()
  })

  it('reports an already-installed facade instead of replacing another product boot', async () => {
    installFacade([])
    const root = mountPoint()
    const entry = new AppGuiEntry(root, {
      manifest: { rev: 'test', modules: [], plugins: [] },
      carrier: testCarrier(),
      platformCapabilities: { kind: 'desktop' },
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await entry.run()
    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') throw new Error('expected GUI boot failure')
    expect(result.message).toContain('__ModuleLoader__ is already installed')
    expect(root.textContent).toContain('__ModuleLoader__ is already installed')
    await entry.dispose()
  })
})

describe('AppWebEntry', () => {
  it('keeps the official missing-facade failure page', async () => {
    const root = mountPoint()
    const entry = new AppWebEntry(root)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await entry.run()
    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') throw new Error('expected Web boot failure')
    expect(result.message).toContain('bootstrap facade is missing')
    expect(root.textContent).toContain('bootstrap facade is missing')
    await entry.dispose()
  })

  it('adapts the Host-injected graph to the Web carrier', async () => {
    const result: ProbeResult = {}
    installFacade([probeRegistration(result), {
      id: 'renderer',
      factory: () => rendererPlugin().module,
    }])
    win.__DSH_BOOT__ = {
      rev: 'test',
      entries: [
        { id: MODULES_ID, url: '/modules.js', rev: 'test', immediately: true },
        { id: 'probe', url: '/probe.js', rev: 'test', immediately: true },
        { id: 'renderer', url: '/renderer.js', rev: 'test' },
      ],
    }
    const entry = new AppWebEntry(mountPoint())

    await expect(entry.run()).resolves.toEqual({ outcome: 'ready' })
    expect(result.carrier).toBeInstanceOf(WebClientCarrier)
    expect(result.carrier?.authority).toBe('local')
    expect(result.platform).toEqual({ kind: 'web' })
    await entry.dispose()
  })
})
