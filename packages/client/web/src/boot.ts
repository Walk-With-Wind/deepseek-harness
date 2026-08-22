/**
 * Shared GUI boot kernel. It owns only the module system, Cordis loader, and
 * framework-free boot page. Web supplies the HTML bootstrap facade; Desktop
 * supplies a validated manifest, explicit carrier, and product-static plugins.
 * The dynamic UI renderer receives the mount point after every client entry
 * activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { WebClientCarrier, type ClientCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/bootstrap'
import type {
  BootManifest, ClientBundleRegistration, ClientModuleCreateOptions,
  ClientModuleLoaderTarget, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/bootstrap'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** GUI product capabilities made available to platform-specific providers. */
export interface GuiPlatformCapabilities {
  /** Product carrier kind; business components must consume capabilities instead of branching on it. */
  readonly kind: 'web' | 'desktop'
}

/** Product-private client plugin linked into the GUI executable. */
export interface GuiStaticPlugin {
  /** Stable Loader entry and module-table id. */
  readonly id: string
  /** Statically imported plugin module. */
  readonly module: Record<string, unknown>
  /** Package-level dependencies retained in the diagnostic manifest. */
  readonly inject?: readonly string[]
  /** Static plugins need no transport prefetch; this flag is retained for graph diagnostics. */
  readonly immediately?: boolean
}

/** Explicit inputs for the carrier-independent GUI entry. */
export interface GuiBootOptions extends BootSeams {
  /** Manifest validated by the product protocol boundary. */
  readonly manifest: BootManifest
  /** Product-selected client carrier. */
  readonly carrier: ClientCarrier
  /** Product capabilities supplied to client providers. */
  readonly platformCapabilities: GuiPlatformCapabilities
  /** Product-private providers linked into the executable. */
  readonly staticPlugins?: readonly GuiStaticPlugin[]
}

/** Explicit settlement result returned to the product lifecycle. */
export type GuiBootResult =
  | { readonly outcome: 'ready' }
  | { readonly outcome: 'failed'; readonly message: string }

interface ModuleBoot {
  readonly modules: ClientModuleSystem
  readonly manifest: BootManifest
  readonly prefetchIds: readonly string[]
  readonly ownedTarget?: ClientModuleLoaderTarget
}

/** Statically adopted package that constructs and then provides the client module system. */
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
/** Product bootstrap entry that provides the carrier and GUI capabilities. */
const GUI_BOOTSTRAP_ID = '@deepseek-ai/dsh-client-gui-bootstrap'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product entry's GUI capabilities. */
    guiPlatform: GuiPlatformCapabilities
  }
}

/** Shared loader lifecycle over a product-specific module-system constructor. */
class AppBootKernel {
  private readonly container: HTMLElement
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules: ClientModuleSystem | undefined
  private manifest: BootManifest | undefined
  private ownedTarget: ClientModuleLoaderTarget | undefined

  /**
   * Draw the boot page immediately.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.container = container
    this.page = new BootPage(container)
  }

  /**
   * Construct the module system, activate the graph, and mount the UI renderer.
   * @param create - Product-specific module-system constructor.
   * @returns Explicit ready or failure settlement.
   */
  async run(create: () => ModuleBoot): Promise<GuiBootResult> {
    try {
      const boot = create()
      this.modules = boot.modules
      this.manifest = boot.manifest
      this.ownedTarget = boot.ownedTarget

      const prefetching = this.prefetchImmediateTier(boot.prefetchIds)
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
      return { outcome: 'ready' }
    } catch (reason) {
      console.error(reason)
      const message = reason instanceof Error ? reason.message : String(reason)
      this.page.fail(message)
      return { outcome: 'failed', message }
    }
  }

  /** Dispose the client plugin tree, boot page, and a Desktop-owned registration facade. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
    const target = this.ownedTarget
    this.ownedTarget = undefined
    const win = globalThis as DshWindow
    if (target !== undefined && win.__ModuleLoader__ === target) delete win.__ModuleLoader__
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'gui boot: application mount')
    })
    await mounted
  }

  /** Prefetch transport-backed immediate entries; static product plugins need no arrival step. */
  private async prefetchImmediateTier(ids: readonly string[]): Promise<void> {
    const modules = this.requireModules()
    await Promise.all(ids.map(id => modules.prefetch(id).catch((_prefetchError: unknown) => {
      // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
    })))
  }

  /** Mount the Loader, create every graph entry, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    const modules = this.requireModules()
    const manifest = this.requireManifest()
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = manifest.plugins.map(row => row.id)
    this.page.setTotal(rows.length)
    await prefetching
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject)
          .filter(service => entry.fiber?.ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`gui boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }

  /** Return the constructed module system or report an internal lifecycle violation. */
  private requireModules(): ClientModuleSystem {
    if (this.modules === undefined) throw new Error('gui boot: module system is unavailable')
    return this.modules
  }

  /** Return the selected manifest or report an internal lifecycle violation. */
  private requireManifest(): BootManifest {
    if (this.manifest === undefined) throw new Error('gui boot: manifest is unavailable')
    return this.manifest
  }
}

/** Create the product bootstrap plugin captured by one explicit GUI launch. */
function createGuiBootstrapModule(
  options: Pick<GuiBootOptions, 'carrier' | 'platformCapabilities'>,
): Record<string, unknown> {
  return {
    name: 'gui-bootstrap',
    apply(ctx: Context) {
      ctx.provide('clientCarrier', options.carrier)
      ctx.provide('guiPlatform', options.platformCapabilities)
      return () => options.carrier.close('GUI plugin tree disposed')
    },
  }
}

/** Add the shell-owned bootstrap row to an otherwise valid Web boot graph. */
function withWebBootstrap(wire: unknown): unknown {
  if (typeof wire !== 'object' || wire === null) return wire
  const graph = wire as Record<string, unknown>
  if (typeof graph.rev !== 'string' || !Array.isArray(graph.entries)) return wire
  const entries: unknown[] = graph.entries
  if (entries.some(entry =>
    typeof entry === 'object' && entry !== null
    && (entry as Record<string, unknown>).id === GUI_BOOTSTRAP_ID)) {
    throw new Error(`web boot: reserved entry id ${JSON.stringify(GUI_BOOTSTRAP_ID)} is already present`)
  }
  return {
    ...graph,
    entries: [
      ...entries,
      {
        id: GUI_BOOTSTRAP_ID,
        url: 'dsh-static:gui-bootstrap',
        rev: graph.rev,
      },
    ],
  }
}

/** Append product-static entries while rejecting collisions with the Host graph. */
function withStaticPlugins(
  manifest: BootManifest,
  plugins: readonly GuiStaticPlugin[],
): BootManifest {
  const ids = new Set([MODULES_ID, GUI_BOOTSTRAP_ID, ...manifest.plugins.map(row => row.id)])
  const extra = plugins.map((plugin) => {
    if (plugin.id === '' || ids.has(plugin.id)) {
      throw new Error(`gui boot: duplicate or reserved static plugin id ${JSON.stringify(plugin.id)}`)
    }
    ids.add(plugin.id)
    return {
      id: plugin.id,
      inject: [...plugin.inject ?? []],
      immediately: plugin.immediately === true,
    }
  })
  return {
    rev: manifest.rev,
    modules: manifest.modules,
    plugins: [
      ...manifest.plugins,
      { id: GUI_BOOTSTRAP_ID, inject: [], immediately: false },
      ...extra,
    ],
  }
}

/** Create a queue-mode facade seeded with statically linked plugin factories. */
function createDesktopTarget(
  registrations: readonly ClientBundleRegistration[],
): ClientModuleLoaderTarget {
  const pendingQueue = [...registrations]
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: () => {
      throw new Error('gui boot: Desktop registration facade cannot create a second module system')
    },
  }
  return target
}

/** Browser entry consumed by `apps/web`; it preserves the official HTML bootstrap protocol. */
export class AppWebEntry {
  private readonly seams: BootSeams | undefined
  private readonly kernel: AppBootKernel

  /**
   * Draw the boot page; {@link run} claims the Host-installed Web facade.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.seams = seams
    this.kernel = new AppBootKernel(container)
  }

  /**
   * Load and activate the Web graph.
   * @returns Explicit ready or failure settlement.
   */
  run(): Promise<GuiBootResult> {
    return this.kernel.run(() => {
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      const bootstrap = {
        carrier: new WebClientCarrier(),
        platformCapabilities: { kind: 'web' as const },
      }
      moduleLoader.load({
        id: GUI_BOOTSTRAP_ID,
        factory: () => createGuiBootstrapModule(bootstrap),
      })
      const modules = moduleLoader.create({
        boot: withWebBootstrap(win.__DSH_BOOT__),
        staticModules: getStaticModules(),
        ...this.seams,
      })
      const manifest = modules.manifest
      return {
        modules,
        manifest,
        prefetchIds: manifest.plugins.filter(row => row.immediately).map(row => row.id),
      }
    })
  }

  /** Dispose the client plugin tree and boot page. */
  dispose(): Promise<void> {
    return this.kernel.dispose()
  }
}

/** Carrier-independent GUI entry consumed by the Desktop renderer. */
export class AppGuiEntry {
  private readonly options: GuiBootOptions
  private readonly kernel: AppBootKernel

  /**
   * Draw the boot page and retain explicit product inputs.
   * @param container - Application mount point.
   * @param options - Validated manifest, carrier, platform capabilities, and static providers.
   */
  constructor(container: HTMLElement, options: GuiBootOptions) {
    this.options = options
    this.kernel = new AppBootKernel(container)
  }

  /**
   * Load and activate the explicit GUI graph.
   * @returns Explicit ready or failure settlement.
   */
  run(): Promise<GuiBootResult> {
    return this.kernel.run(() => {
      const win = globalThis as DshWindow
      if (win.__ModuleLoader__ !== undefined) {
        throw new Error('gui boot: window.__ModuleLoader__ is already installed')
      }
      const staticPlugins = this.options.staticPlugins ?? []
      const manifest = withStaticPlugins(this.options.manifest, staticPlugins)
      const registrations: ClientBundleRegistration[] = [
        { id: GUI_BOOTSTRAP_ID, factory: () => createGuiBootstrapModule(this.options) },
        ...staticPlugins.map(plugin => ({ id: plugin.id, factory: () => plugin.module })),
      ]
      const target = createDesktopTarget(registrations)
      win.__ModuleLoader__ = target
      try {
        const modules = ModulesClient.createClientModuleSystemFromManifest(target, {
          id: MODULES_ID,
          exports: ModulesClient,
        }, {
          manifest,
          staticModules: getStaticModules(),
          ...this.options.loadBundle === undefined ? {} : { loadBundle: this.options.loadBundle },
        })
        return {
          modules,
          manifest,
          prefetchIds: this.options.manifest.plugins
            .filter(row => row.immediately)
            .map(row => row.id),
          ownedTarget: target,
        }
      } catch (error) {
        if (win.__ModuleLoader__ === target) delete win.__ModuleLoader__
        throw error
      }
    })
  }

  /** Dispose the client plugin tree, carrier, boot page, and Desktop facade. */
  dispose(): Promise<void> {
    return this.kernel.dispose()
  }
}
