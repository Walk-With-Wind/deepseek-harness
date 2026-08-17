/**
 * GUI 模块注册 core：扫描 Host Loader 中声明 `dsh.client` 的包，组合启动图，
 * 解析并校验 bundle 真实路径，并提供 HMR 注册/通知接口。HTTP route、HTML 注入和
 * Desktop `app://` 映射由产品 adapter 独立实现。
 *
 * 稳态扫描按 package 增量执行：每次 Cordis `internal/plugin` 通知都会把对应条目标记为待处理，
 * microtask 随后按实时 Loader 状态完成协调。首次对外读取快照时会再枚举一次 Loader，覆盖
 * 模块注册器先激活、其他同级条目后激活但增量通知尚未到达的启动窗口；此后不再全量扫描。
 * package 元数据（包括“不是客户端包”的否定结果）按名称缓存，插件集合变更在重启后生效；
 * bundle 内容变化仅通过 {@link ClientModuleRegistry.rebuilt} 进入启动图。
 * @module @deepseek-ai/dsh-client-modules
 */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'
import {
  CLIENT_RESOURCE_MANIFEST_VERSION,
  type ClientResourceManifest,
} from './resource-manifest.ts'

export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'
export {
  CLIENT_RESOURCE_MANIFEST_VERSION,
  clientResourceManifestSchema,
  parseClientResourceManifest,
  type ClientResourceEntry,
  type ClientResourceManifest,
} from './resource-manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web plugin table (provided by the client-modules node half). */
    clientModules: ClientModuleRegistry
  }
}

/** package.json `dsh.client` declaration fields, validated one by one after reading the file. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
}

/** Resolved package metadata for one `dsh.client` package (cached per name, never expires). */
interface PkgMeta {
  clientPath: string
  packageRoot: string
  inject?: string[]
  immediately: boolean
}

/** Recovery instruction shared by grouped startup and steady-state bundle diagnostics. */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** Missing built client export, retained as structured data for activation-error grouping. */
class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

/** Activation failures grouped by actionable package-build errors and unrelated failures. */
class ClientPackageCompositionError extends AggregateError {
  constructor(failures: Error[]) {
    const missingBundles = failures.filter((error): error is MissingClientBundleError => error instanceof MissingClientBundleError)
    const otherFailures = failures.filter(error => !(error instanceof MissingClientBundleError))
    const packageNoun = failures.length === 1 ? 'package' : 'packages'
    const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`]
    if (missingBundles.length > 0) {
      lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`)
      for (const error of missingBundles) {
        lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`)
      }
    }
    if (otherFailures.length > 0) {
      lines.push('  other failures:', ...otherFailures.map(error => `    - ${error.message}`))
    }
    super(failures, lines.join('\n'))
  }
}

/** 一个已组合条目：启动图行、校验后的 bundle 真实路径与所属包根。 */
interface WebPluginRecord {
  entry: WebBootEntry
  clientPath: string
  packageRoot: string
}

/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`client-modules: ${pkgName} dsh.client.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(decl.inject !== undefined ? { inject: decl.inject as string[] } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Graph row for one bundle rev (url carries the rev as its cache-busting query). */
function graphRow(id: string, rev: string, injectEdges: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `/plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(injectEdges !== undefined ? { inject: injectEdges } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}

/**
 * GUI 模块表服务：增量扫描 `dsh.client` 并组合启动图。构造阶段同步执行首次扫描，
 * synchronously — a malformed declaration or missing bundle among the
 * already-loaded entries aggregates into one loud throw (FAILED fiber; the
 * boot activation audit reports it).
 */
export class ClientModuleRegistry extends Service {
  static inject = ['loader']

  private readonly table = new Map<string, WebPluginRecord>()
  // Negative verdicts (unresolvable specifier — builtins like cordis:include,
  // subpath rows — or a package without a web `dsh.client` declaration) are
  // cached as null and never expire: plugin-set changes take effect on restart.
  private readonly pkgMeta = new Map<string, PkgMeta | null>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private readonly resolvePkgJson: (spec: string) => string
  private flushQueued = false
  private firstSnapshotPending = true
  private composed: WebBootGraph

  /**
   * Build the service: subscribe, seed, and run the activation flush.
   * @param ctx - 携带 Loader 和配置树解析基址的 Host 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    if (ctx.baseUrl === undefined) {
      throw new Error('client-modules: module resolution base URL is unset')
    }
    const profileRequire = createRequire(ctx.baseUrl)
    const hostModuleBaseUrl = ctx.get('hostModuleBaseUrl') as string | undefined
    if (hostModuleBaseUrl === undefined) {
      this.resolvePkgJson = spec => profileRequire.resolve(`${spec}/package.json`)
    } else {
      const hostRequire = createRequire(hostModuleBaseUrl)
      this.resolvePkgJson = (spec) => {
        try {
          // 宿主直接依赖优先，避免 Profile 中的同名包遮蔽随应用发布的传输适配器。
          return hostRequire.resolve(`${spec}/package.json`)
        } catch (error) {
          if (!isModuleNotFound(error)) throw error
          // 组合包的传递客户端依赖由 Profile 平铺目录拥有，必须与 Loader 的回退顺序一致。
          return profileRequire.resolve(`${spec}/package.json`)
        }
      }
    }

    // Subscribe before seeding so a fiber arriving mid-activation lands in the
    // same dirty set (Set idempotence makes the overlap harmless). An entry-less
    // fiber is a child plugin or a manual mount — never a loader row; O(1) drop.
    ctx.on('internal/plugin', (fiber) => {
      const entryName = fiber.entry?.options.name
      if (entryName === undefined) return
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        this.flush((err) => { ctx.logger.warn(err) })
      })
    })

    // Activation pass: the initial scan IS the incremental path over the
    // current entries, flushed synchronously (nothing async between subscribe,
    // seed, and flush).
    for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)
    this.composed = this.compose()
    this.flushPending()

  }

  /**
   * 返回当前组合图；读取前同步结算已到达但尚未运行的增量扫描。
   * @returns 提供给 GUI 外壳的启动图。
   */
  graph(): WebBootGraph {
    this.settleSnapshot()
    return this.composed
  }

  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined {
    return this.table.get(id)?.clientPath
  }

  /**
   * 生成交给 Desktop Main 的只读资源映射；Renderer 只接收 {@link graph} 中的不透明 URL。
   * @returns 当前图代际对应的可信 bundle 真实路径清单。
   */
  resourceManifest(): ClientResourceManifest {
    this.settleSnapshot()
    return Object.freeze({
      version: CLIENT_RESOURCE_MANIFEST_VERSION,
      rev: this.composed.rev,
      resources: Object.freeze([...this.table.entries()].map(([id, record]) => Object.freeze({
        id,
        rev: record.entry.rev,
        urlPath: `/plugins/${id}/client.js`,
        sourcePath: record.clientPath,
        sourceMapPath: `${record.clientPath}.map`,
      }))),
    })
  }

  /**
   * Re-hash one bundle (the HMR watch's registration hook — the only entry
   * point through which bundle content changes reach the graph).
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const rev = shortHash(readFileSync(record.clientPath))
    if (rev === record.entry.rev) return rev
    record.entry = graphRow(id, rev, record.entry.inject, record.entry.immediately === true)
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      // Containment: rebuilt() runs inside the HMR watch callback — a
      // throwing subscriber must not kill the poll or skip later subscribers.
      try {
        notify(id, rev)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    this.notifyGraphChanged()
    return rev
  }

  /**
   * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
   * @param listener - receives the entry id and its new bundle rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  /**
   * Fires after any flush that recomposed the graph (row added/removed, or a
   * rebuilt rev change). Pull model: listeners re-read {@link graph}.
   * @param listener - notified with no payload.
   * @returns the unsubscriber.
   */
  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  private compose(): WebBootGraph {
    const entries = [...this.table.values()].map(record => record.entry)
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  private notifyGraphChanged(): void {
    for (const listener of this.graphListeners) {
      // A throwing subscriber must not skip later subscribers (or escape into
      // whatever triggered the flush — possibly an fs.watchFile callback).
      try {
        listener()
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  private resolveMeta(pkgName: string): PkgMeta | null {
    const cached = this.pkgMeta.get(pkgName)
    if (cached !== undefined) return cached
    let pkgPath: string
    try {
      pkgPath = this.resolvePkgJson(pkgName)
    } catch {
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries (…/gateway) land here — permanently not a client row.
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      pkgName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
    if (!clientRel.startsWith('./')) {
      throw new Error(`client-modules: ${pkgName} exports["./client"] must be package-relative`)
    }
    const packageRoot = realpathSync(dirname(pkgPath))
    const clientPath = resolve(packageRoot, clientRel)
    assertOwnedPath(pkgName, packageRoot, clientPath)
    const meta: PkgMeta = {
      clientPath,
      packageRoot,
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      immediately: decl.immediately === true,
    }
    this.pkgMeta.set(pkgName, meta)
    return meta
  }

  /**
   * Read the activation-time bundle revision.
   * @param pkgName - package that declares the client bundle.
   * @param clientPath - absolute path of the built client artifact.
   * @returns the bundle content's short hash for use as its revision.
   * @throws {MissingClientBundleError} when the read fails with `ENOENT`; other filesystem errors are rethrown unchanged.
   */
  private initialBundle(
    pkgName: string,
    packageRoot: string,
    clientPath: string,
  ): { readonly path: string; readonly rev: string } {
    try {
      const path = realpathSync(clientPath)
      assertOwnedPath(pkgName, packageRoot, path)
      return { path, rev: shortHash(readFileSync(path)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(pkgName, clientPath, error)
    }
  }

  /** Reconcile one entry name against the live loader entries. @returns whether the table changed. */
  private processOne(entryName: string): boolean {
    let qualifies = false
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled) {
        qualifies = true
        break
      }
    }
    if (!qualifies) return this.table.delete(entryName)
    if (this.table.has(entryName)) return false
    const meta = this.resolveMeta(entryName)
    if (meta === null) return false
    // The rev rides the row from here on: a fiber restart reuses the row (and
    // its rev) untouched; only rebuilt() re-reads the bundle.
    const bundle = this.initialBundle(entryName, meta.packageRoot, meta.clientPath)
    this.table.set(entryName, {
      entry: graphRow(entryName, bundle.rev, meta.inject, meta.immediately),
      clientPath: bundle.path,
      packageRoot: meta.packageRoot,
    })
    return true
  }

  private flush(onError: (err: Error) => void): void {
    let changed = false
    for (const entryName of [...this.dirty]) {
      this.dirty.delete(entryName)
      try {
        if (this.processOne(entryName)) changed = true
      } catch (error) {
        // Steady state: one broken package must not poison the others; the
        // activation pass aggregates these into a loud throw instead.
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (changed) {
      this.composed = this.compose()
      this.notifyGraphChanged()
    }
  }

  /** 同步结算待处理条目；产品首次读取图时，组合错误仍属于启动失败。 */
  private flushPending(): void {
    if (this.dirty.size === 0) return
    const failures: Error[] = []
    this.flush(error => failures.push(error))
    if (failures.length > 0) throw new ClientPackageCompositionError(failures)
  }

  /** 首次对外读取前补扫已安定的 Loader，之后只处理增量标记。 */
  private settleSnapshot(): void {
    if (this.firstSnapshotPending) {
      this.firstSnapshotPending = false
      for (const entry of this.ctx.loader.entries()) this.dirty.add(entry.options.name)
      // 同步纳入表中旧键，使首次读取也能删除已退出的条目。
      for (const name of this.table.keys()) this.dirty.add(name)
    }
    this.flushPending()
  }

}

function assertOwnedPath(packageName: string, packageRoot: string, candidate: string): void {
  const child = relative(packageRoot, candidate)
  if (child === '' || (!child.startsWith(`..${pathSeparator()}`) && child !== '..' && !isAbsolute(child))) return
  throw new Error(`client-modules: ${packageName} client bundle resolves outside its package root`)
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/** 判断 Node 裸包解析是否仅因当前基址找不到模块而失败。 */
function isModuleNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND'
}

export default ClientModuleRegistry
