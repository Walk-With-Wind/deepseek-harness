# Client 模块

[English](client-modules.md) | 中文

[dsh-client-modules](../../packages/client/modules) 中的 GUI 客户端模块 registry，以 `ctx.clientModules`（`ClientModuleRegistry`）形式提供。与传输无关的 Host half 扫描声明了 `dsh.client` 的 Loader entry，组合逻辑启动图，校验 bundle 路径，并生成严格资源 manifest。只有本包的 `/web` adapter 消费 [dsh-host-webserver](../../packages/host/webserver)，以登记 `/plugins` 并注入 `window.__DSH_BOOT__`；Desktop 通过私有 `app://` adapter 消费同一 core。客户端 half（`ctx.modules`）是请求产品 loader 交付并物化 bundle 的 lazy-CJS 表；其内核机制见[包 README](../../packages/client/modules/README.md)。

源码：[`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)、[`packages/client/modules/src/resource-manifest.ts`](../../packages/client/modules/src/resource-manifest.ts)

## wire

图是 Host 与 GUI 之间的逻辑 wire 真源。Host 从扫描到的包组合 `WebBootEntry` 行。Web 把它作为 `<head>` 中的第一个 script 注入（`window.__DSH_BOOT__`，其中 `<` 已转义，插件可控字符串因此无法逃出 script 元素）；Desktop 则通过控制协议转交等效的严格 boot 值。`AppGuiEntry` 在挂载任何东西之前接收已解析 manifest，因此没有有效图的产品无法启动。

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch; `inject` is informational graph
 * metadata (the authoritative edges live in each package's `dsh.client`
 * declaration and reach fibers through entry creation). `external` carries
 * module-graph edges: unlike `inject`, they constrain code arrival because
 * `require` is synchronous (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'. */
  url: string
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
}
```

每一行的 `rev` 是该 bundle 的内容哈希，并作为使缓存失效的查询参数附在 URL 上；图的 `rev` 对组合后的各行做哈希，因此任何一行的变化都会改变它。`immediately` 标记第一阶段预取档位（在模块面启动期间 fetch 并执行，只做登记）；惰性行在首次 import 时才拉取。

资源 manifest 是 Host 到产品的控制值，不是 Renderer 权限。Utility 生成已经解析的绝对源路径；Desktop Main 校验严格 schema，只把匹配的 id／revision 转换为 `app://` 资源，并且只向 Renderer 发送不透明图 URL。

```ts type-equiv
/** One bundle resource resolved and validated by the module-registry core. */
interface ClientResourceEntry {
  /** Package name and boot-graph entry id. */
  readonly id: string
  /** Bundle content generation. */
  readonly rev: string
  /** Opaque app/Web URL path exposed to Renderer. */
  readonly urlPath: string
  /** Trusted bundle path sent from Utility to Main. */
  readonly sourcePath: string
  /** Candidate source-map path adjacent to the bundle. */
  readonly sourceMapPath: string
}
```

```ts type-equiv
/** Immutable resource manifest for the current module graph. */
interface ClientResourceManifest {
  /** DTO format version. */
  readonly version: typeof CLIENT_RESOURCE_MANIFEST_VERSION
  /** Aggregate content generation shared with the boot graph. */
  readonly rev: string
  /** Exactly one bundle resource for each GUI client package. */
  readonly resources: readonly ClientResourceEntry[]
}
```

## 扫描

包通过在自身 package.json 中声明 `dsh.client`（`platform: 'web'`、可选 `inject` 边、可选 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle 来加入表。已安装／封闭 Host 会先从 `ctx.hostModuleBaseUrl` 解析宿主自有包，再回退到 profile 的 `ctx.baseUrl`，以发现 bundle 依赖和用户安装的插件；普通 profile 使用 `ctx.baseUrl`。没有解析锚点时，构造即抛错。

扫描是单包增量的；不存在全量重扫代码路径。fiber 构造或 dispose（资源释放）时的每次 cordis `internal/plugin` 发射都把该 fiber 的 entry 名标脏，一次微任务 flush 把每个脏名与实时 loader entry 对账。激活趟以全部当前 entry 灌入同一个脏集合并同步 flush，因此初扫与稳态共享一条实现——但失败姿态相反。激活时，已加载 entry 中的畸形声明或缺失 bundle 会聚合为一个大声的 `AggregateError`，列出每个损坏的包：该 fiber 进入 FAILED，由启动的大声失败 sweep 上报。稳态下，损坏的包只记录一条警告，且不得殃及其他包。

包元数据——包括「非 client 包」这一否定结论——按名缓存且永不过期：插件集合的变更在重启后生效。fiber 重启原样复用其行与 rev；bundle 内容变更只经 `rebuilt()` 到达图。

## 产品资源 adapter

`/web` 入口以 `no-cache` 提供 `GET`／`HEAD /plugins/<id>/client.js`（锚定一致性的是 rev 查询参数，而非 HTTP 缓存）；其他方法返回 405。未知 id 或不可读的已注册 bundle 返回 404，不让 SPA fallback 把 HTML 当作 JavaScript。其 index tap 在每次 render 时注入当前图。Desktop 不导入该 adapter：Utility 调用 `resourceManifest()`，Main 为匹配 generation 安装新的不可变资源映射，`app://` 协议独立执行 method、path、revision、文件身份与 content policy。

## 服务

`ClientModuleRegistry`（`ctx.clientModules`，定义于 [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)）暴露读取面与重建面；签名见生成的[服务目录](#ctxclientmodules--clientmoduleregistry)。`graph()` 返回当前组合图，`clientPath(id)` 返回一条已校验 bundle 路径，`resourceManifest()` 为非 Web 产品快照当前图 generation 与全部可信路径。`rebuilt(id)` 是 bundle 内容到达图的唯一入口：它重新 hash 文件，只有 rev 真正变化才重新组合图并通知。`onRebuilt` 按变化 bundle 携带新 rev 触发；`onGraphChanged` 在任何重新组合图的 flush 后触发，并采用 pull 模型。两条通知路径都隔离 listener 异常，因此一个抛错订阅者不能跳过后续订阅者或杀死触发工作。

开发环境下，[dsh-client-hmr](../../packages/client/hmr/README.md) 是注册表的监视驱动：它的 Node 半从同步取得的基线出发，对图中每一行的 bundle 做 stat 轮询，变化时调用 `rebuilt(id)`，经 `onGraphChanged` 重新同步监视集合，并通过 SSE（Server-Sent Events）把 rev 变化广播给浏览器半。生产环境的图完全不含 HMR（热模块替换）行；模块宿主自身从不监视文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The GUI client-module registry: incremental `dsh.client` scan, boot-graph composition, and trusted resource-manifest projection. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Return the current composed entry graph, stable between changes.
 * @returns The graph passed to the GUI product shell.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Project the read-only resource map sent to Desktop Main; Renderer receives only opaque URLs from {@link graph}.
 * @returns Trusted bundle paths for the current graph generation.
 */
resourceManifest(): ClientResourceManifest

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts:304`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
