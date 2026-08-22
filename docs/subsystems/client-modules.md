# Client Modules

English | [中文](client-modules.zh.md)

The GUI client module registry in [dsh-client-modules](../../packages/client/modules), provided as `ctx.clientModules` (`ClientModuleRegistry`). Its transport-neutral Host half scans Loader entries for packages declaring `dsh.client`, composes the logical boot graph, validates bundle paths, and produces a strict resource manifest. The package's `/web` adapter alone consumes [dsh-host-webserver](../../packages/host/webserver) to register `/plugins` and inject `window.__DSH_BOOT__`; Desktop consumes the same core through its private `app://` adapter. The client half (`ctx.modules`) is the lazy-CJS table that asks the product loader to deliver and materialize bundles; its kernel mechanics live in the [package README](../../packages/client/modules/README.md).

Sources: [`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts), [`packages/client/modules/src/resource-manifest.ts`](../../packages/client/modules/src/resource-manifest.ts)

## The wire

The graph is the logical wire source between Host and GUI. The Host composes `WebBootEntry` rows from scanned packages. Web injects it as the first script in `<head>` (`window.__DSH_BOOT__`, with `<` escaped so plugin-controlled strings cannot break out of the script element); Desktop transfers the equivalent strict boot value through its control protocol. `AppGuiEntry` receives a parsed manifest before mounting anything, so a product without a valid graph cannot boot.

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

Each row's `rev` is the bundle's content hash and rides the URL as a cache-busting query; the graph `rev` hashes the composed rows, so any row change changes it. `immediately` marks the stage-one prefetch tier (fetch and execute during module-face boot, registration only); a lazy row is fetched on first import.

The resource manifest is a Host-to-product control value, not Renderer authority. Utility produces absolute, already-resolved source paths; Desktop Main validates the strict schema, converts only matching ids/revisions into `app://` resources, and sends Renderer only opaque graph URLs.

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

## The scan

A package joins the table by declaring `dsh.client` (`platform: 'web'`, optional `inject` edges, optional `immediately`) in its package.json and exporting its built bundle at `exports["./client"]`. An installed/closed host resolves host-owned packages from `ctx.hostModuleBaseUrl` first and falls back to the profile's `ctx.baseUrl` for bundle dependencies and user-installed plugins; an ordinary profile uses `ctx.baseUrl`. Construction throws when no resolution anchor exists.

Scanning is incremental per package; there is no full-rescan code path. Every cordis `internal/plugin` emission (fiber construction or disposal) marks the fiber's entry name dirty, and a microtask flush reconciles each dirty name against the live loader entries. The activation pass seeds the same dirty set with all current entries and flushes synchronously, so first scan and steady state share one implementation — with opposite failure postures. At activation, a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud `AggregateError` listing every broken package: the fiber FAILS and the boot's fail-loud sweep reports it. In steady state, a broken package logs a warning and must not poison the others.

Package metadata — including the negative "not a client package" verdict — is cached per name and never expires: plugin-set changes take effect on restart. A fiber restart reuses its row and rev untouched; bundle content changes reach the graph only through `rebuilt()`.

## Product resource adapters

The `/web` entry serves `GET`/`HEAD /plugins/<id>/client.js` with `no-cache` (the rev query, not HTTP caching, anchors consistency); other methods are 405. An unknown id or unreadable registered bundle answers 404 instead of letting SPA fallback return HTML as JavaScript. Its index tap injects the current graph on every render. Desktop does not import that adapter: Utility calls `resourceManifest()`, Main installs a new immutable resource map for the matching generation, and the `app://` protocol independently enforces method, path, revision, file identity, and content policy.

## The service

`ClientModuleRegistry` (`ctx.clientModules`, defined in [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)) exposes reads and the rebuild face; signatures are in the generated [service catalog](#ctxclientmodules--clientmoduleregistry). `graph()` returns the current composed graph, `clientPath(id)` returns one validated bundle path, and `resourceManifest()` snapshots the graph generation and all trusted paths for a non-Web product. `rebuilt(id)` is the only entry point through which bundle content reaches the graph: it re-hashes the file, and only a real rev change recomposes the graph and notifies. `onRebuilt` fires per changed bundle with the new rev; `onGraphChanged` fires after any flush that recomposed the graph and is pull-model. Both notification paths contain listener exceptions so one throwing subscriber cannot skip later subscribers or kill the triggering work.

In development, [dsh-client-hmr](../../packages/client/hmr/README.md) is the registry's watch driver: its node half stat-polls every graph row's bundle from a synchronously captured baseline, calls `rebuilt(id)` on change, resyncs its watch set through `onGraphChanged`, and broadcasts rev changes to the browser half over SSE. Production graphs omit the HMR row entirely; the module host itself never watches files.

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
