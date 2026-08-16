/**
 * GUI 外壳启动内核。`AppGuiEntry` 显式接收启动清单、客户端载体、bundle loader
 * 与平台能力，不读取 Web origin 或 Electron 全局对象。`AppWebEntry` 只是兼容包装层：
 * 解析 `window.__DSH_BOOT__` 并提供浏览器载体。
 *
 * 创建条目前会等待全部立即加载模块完成物化，因为跨包同步依赖不能依靠 fiber 注入等待保护。
 * 单个预取失败由后续导入路径重新加载并明确报告，避免一个失败遮蔽其他模块的诊断。
 * 组合关系由 Host 图决定；外壳只静态注册自身的 app-shell 组装条目。
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRoot, type Root } from 'react-dom/client'
import { WebClientCarrier, type ClientCarrier } from '@deepseek-ai/dsh-client-connection/client'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/client'
import {
  ClientModuleSystem, parseBootManifest,
  type BootManifest, type ClientModuleSystemOptions, type DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import * as AppShell from './app-shell.ts'
import { APP_SHELL_ID } from './app-shell.ts'
import { AppRoot } from './AppRoot.tsx'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS, createLoaderStatusStore, createSignal } from './loader-status.ts'
import './base.css'

/** 模块传输钩子；jsdom 测试用它替换 `<script>` 路径。 */
export type BootSeams = Pick<ClientModuleSystemOptions, 'loadBundle'>

/** GUI 产品在启动时提供的平台能力集合。 */
export interface GuiPlatformCapabilities {
  /** 当前产品载体类型，供能力 Provider 选择实现，不供业务组件分叉。 */
  readonly kind: 'web' | 'desktop'
}

/** 产品外壳随 Renderer 一同编译、无需资源下载的私有客户端插件。 */
export interface GuiStaticPlugin {
  /** Loader entry 与模块表共用的稳定 id。 */
  readonly id: string
  /** 静态导入的插件模块。 */
  readonly module: unknown
  /** 仅用于启动图诊断的包级依赖边。 */
  readonly inject?: readonly string[]
  /** 是否加入第一阶段预取；静态模块预取是无 I/O 的 no-op。 */
  readonly immediately?: boolean
}

/** 通用 GUI 入口的显式启动参数。 */
export interface GuiBootOptions extends BootSeams {
  /** 已在所属协议边界完成校验的客户端启动清单。 */
  readonly manifest: BootManifest
  /** 产品选择的客户端载体。 */
  readonly carrier: ClientCarrier
  /** 产品提供的平台能力。 */
  readonly platformCapabilities: GuiPlatformCapabilities
  /** 产品私有、由外壳静态注册的 provider 插件。 */
  readonly staticPlugins?: readonly GuiStaticPlugin[]
}

/** 通用 GUI 启动的明确结算结果。 */
export type GuiBootResult =
  | { readonly outcome: 'ready' }
  | { readonly outcome: 'failed'; readonly message: string }

/** 模块系统自身的图条目 ID；外壳静态接管该条目，避免重复提供 `modules`。 */
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
/** 外壳自有的启动依赖 Provider。 */
const GUI_BOOTSTRAP_ID = '@deepseek-ai/dsh-client-gui-bootstrap'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 产品入口提供的 GUI 平台能力。 */
    guiPlatform: GuiPlatformCapabilities
  }
}

/** 创建捕获本次启动参数的外壳静态插件。 */
function createGuiBootstrapModule(options: GuiBootOptions): object {
  return {
    name: 'gui-bootstrap',
    apply(ctx: Context) {
      ctx.provide('clientCarrier', options.carrier)
      ctx.provide('guiPlatform', options.platformCapabilities)
      return () => options.carrier.close()
    },
  }
}

/**
 * GUI 外壳内核：把加载页挂载到 DOM，并按 Host 图执行两阶段启动。
 * 字段只保存 Cordis 启动前必须存在的清单、模块系统与加载页状态，其余能力均由插件提供。
 */
export class AppGuiEntry {
  private readonly el: HTMLElement
  private readonly options: GuiBootOptions
  private readonly status = createLoaderStatusStore()
  private readonly settled = createSignal(false)
  private readonly error = createSignal<string | undefined>(undefined)
  // `run()` 会在任何私有启动方法或稳定态回调读取前完成赋值。
  private ctx!: Context
  private modules!: ClientModuleSystem
  private readonly manifest: BootManifest
  private root: Root | undefined

  /**
   * 保存挂载点与显式启动参数；实际工作在 {@link run} 中执行。
   * @param el - 应用挂载点。
   * @param options - 启动清单、载体、bundle loader 与平台能力。
   */
  constructor(el: HTMLElement, options: GuiBootOptions) {
    this.el = el
    this.options = options
    this.manifest = withStaticPlugins(options.manifest, options.staticPlugins ?? [])
  }

  /**
   * 执行启动链直至稳定。启动链失败时保留加载页并呈现诊断；只有缺失或畸形清单会直接抛错。
   * @returns UI 稳定或失败报告呈现完成后解决。
   */
  async run(): Promise<GuiBootResult> {
    this.modules = new ClientModuleSystem({
      modules: this.manifest.modules,
      staticModules: getStaticModules(),
      ...this.options.loadBundle === undefined ? {} : { loadBundle: this.options.loadBundle },
    })
    // The app-shell assembly is the only shell-own module: every other graph
    // row is a plugin bundle arriving through fetch.
    this.modules.registerStatic(APP_SHELL_ID, AppShell)
    // Adoption handoff, supply side: register the modules
    // package's own client half under its bare package name (= graph row id
    // = entry name — a suffixed key would miss the statics branch and
    // trigger a real fetch), and put the instance on the kernel slot the
    // wrapper's apply reads to provide ctx.modules.
    this.modules.registerStatic(MODULES_ID, ModulesClient)
    this.modules.registerStatic(GUI_BOOTSTRAP_ID, createGuiBootstrapModule(this.options))
    for (const plugin of this.options.staticPlugins ?? []) {
      this.modules.registerStatic(plugin.id, plugin.module)
    }
    ;(globalThis as DshWindow).__DSH_MODULES__ = this.modules

    this.root = createRoot(this.el)
    this.root.render(
      <AppRoot
        settled={this.settled}
        status={this.status}
        error={this.error}
        renderApp={() => {
          const shell = this.ctx.get('appShell')
          // Unreachable after a clean settle (the app-shell entry is in every graph).
          if (shell === undefined) throw new Error('gui boot: appShell service missing after settled')
          return shell.renderApp()
        }}
      />,
    )

    // The immediately tier prefetches in parallel with Loader mounting;
    // runPluginBoot awaits it before creating entries (see module comment:
    // cross-package synchronous require edges need every immediately-tier
    const prefetching = this.prefetchImmediateTier()
    this.ctx = new Context()
    try {
      await this.runPluginBoot(prefetching)
      this.settled.set(true)
      return { outcome: 'ready' }
    } catch (reason) {
      // 保留加载页并呈现完整失败信息，同时向产品入口返回明确结算。
      console.error(reason)
      const message = reason instanceof Error ? reason.message : String(reason)
      this.error.set(message)
      return { outcome: 'failed', message }
    }
  }

  /** Unmount the shell (loading page or settled UI). */
  dispose(): void {
    const root = this.root
    if (root === undefined) return
    this.root = undefined
    root.unmount()
    void this.ctx.root.fiber.dispose()
  }

  /** Prefetch the immediately tier (factory registration only; failures defer to the import path). */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch(() => {
        // Import reloads and reports this loudly per entry; swallowing
        // here keeps one failing prefetch from masking the others.
      })))
  }

  /** Plugin face: mount the Loader, inject the `internal` contract, adopt modules, create the graph entries, settle, sweep. */
  private async runPluginBoot(prefetching: Promise<void>): Promise<void> {
    const ctx = this.ctx
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // Inject the module system BEFORE any entry exists: tree.import falls back
    // to a bare dynamic import when internal is undefined, which in a browser
    // is a guaranteed loud failure — correct as a tripwire, never as a path.
    loader.internal = this.modules as never

    // Status projection: AppRoot displays fiber truth. Every internal/status
    // transition under an entry re-projects that entry's row from its ROOT
    // fiber (child plugin fibers share the same entry).
    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.status.set(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    // Barrier before any entry exists: entry creation materializes bundles,
    // and materialization runs synchronous cross-package require edges that
    // need every immediately-tier factory already registered (module
    // comment). Resolves even when individual prefetches failed.
    await prefetching

    // Adoption handoff, plugin side: the modules entry is created first —
    // its wrapper apply reads the kernel slot and provides ctx.modules (the
    // provide lives on the plugin face; see MODULES_ID for why the row loop
    // must then skip it).
    const rows = [
      MODULES_ID,
      GUI_BOOTSTRAP_ID,
      ...this.manifest.plugins.map(row => row.id).filter(id => id !== MODULES_ID),
      APP_SHELL_ID,
    ]
    // Entry creation order carries no semantics (fiber inject waiting owns
    // activation order); creating concurrently lets non-prefetched bundle
    // loads parallelize. The app-shell assembly entry is appended by the
    // kernel: it is shell-own code (host graph rows are all plugin bundles),
    // and mounting the assembly is not a composition decision — it rides the
    // same entry lifecycle so the sweep and status cover it uniformly.
    await Promise.all(rows.map(async (name) => {
      this.status.set(name, 'loading')
      const id = await loader.create({ name })
      // A failed import leaves the entry fiberless (Entry._init logs and
      // returns); project it as failed — no fiber means no status event.
      if (loader.resolve(id).fiber === undefined) {
        this.status.set(name, 'failed')
      }
    }))

    await loader.await()
    this.assertEntriesActive()
  }

  /**
   * Sweep every loader entry after the tree quiesced: an entry without a
   * fiber failed its import; a fiber not ACTIVE is FAILED (apply threw) or
   * PENDING (a required service never arrived — cordis inject waiting has no
   * timeout, so this sweep is the fail-loud compensation).
   */
  private assertEntriesActive(): void {
    const ctx = this.ctx
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
        // 依赖可见性由该条目的 Fiber 上下文决定，根上下文不能代表其隔离后的服务视图。
        const missing = Object.keys(entry.fiber.inject).filter(service => entry.fiber?.ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`gui boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}

function withStaticPlugins(
  manifest: BootManifest,
  plugins: readonly GuiStaticPlugin[],
): BootManifest {
  if (plugins.length === 0) return manifest
  const ids = new Set([
    MODULES_ID,
    GUI_BOOTSTRAP_ID,
    APP_SHELL_ID,
    ...manifest.plugins.map(row => row.id),
  ])
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
    plugins: [...manifest.plugins, ...extra],
  }
}

/**
 * 当前浏览器入口的薄包装层。
 *
 * 它只把 Web 注入的启动清单和默认浏览器载体适配为 `AppGuiEntry` 参数。
 */
export class AppWebEntry {
  private readonly el: HTMLElement
  private readonly seams: BootSeams | undefined
  private entry: AppGuiEntry | undefined

  /**
   * 创建浏览器包装层。
   * @param el - 应用挂载点。
   * @param seams - 可选的 bundle loader 测试替换。
   */
  constructor(el: HTMLElement, seams?: BootSeams) {
    this.el = el
    this.seams = seams
  }

  /**
   * 解析 Web 启动清单并运行通用 GUI 入口。
   * @returns GUI 稳定或错误页完成渲染后结算。
   */
  run(): Promise<GuiBootResult> {
    const manifest = parseBootManifest((globalThis as DshWindow).__DSH_BOOT__)
    this.entry = new AppGuiEntry(this.el, {
      manifest,
      carrier: new WebClientCarrier(),
      platformCapabilities: { kind: 'web' },
      ...this.seams,
    })
    return this.entry.run()
  }

  /** 卸载当前 GUI。 */
  dispose(): void {
    this.entry?.dispose()
  }
}
