# @deepseek-ai/dsh-client-modules

English | [中文](README.zh.md)

Client module system with a transport-neutral Host registry, a Web resource adapter, and a lazy CJS client table. `ClientModuleRegistry` scans the Host Loader for `dsh.client` packages, validates their built `./client` exports, composes the boot graph, and exposes an immutable resource manifest for product adapters. The `/web` entry alone owns the WebServer bundle route and HTML manifest injection. Desktop transfers the strict resource manifest to Main, maps its trusted source paths into `app://` resources, and passes a product-owned bundle loader to the same client table.

The GUI shell mounts the vendored cordis Loader for entry governance (fiber lifecycle, inject waiting, update/refresh) and injects this package's `ClientModuleLoader` through its `internal` contract. The vendored side's only consumption point is `EntryTree.import`, so replacing `internal` changes exactly how plugin code arrives and nothing else.

Lazy CJS model (web2): executing a plugin bundle only REGISTERS its factory (`window.__ModuleLoader__.load({id, factory})`); every module body side effect — CSS injection included — lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`), not at script execution. A factory that requires another registered-but-unmaterialized module materializes it recursively, so load order needs no external sequencing; require cycles throw (factory-form CJS cannot deliver partial exports). `<id>/client` and the bare id resolve to the same exports (a plugin bundle IS its package's client half).

Resolution branch order (`import(specifier)`): platform seed word → shell instance; memoized record → exports; shell-owned static registry (`registerStatic`, app shell) → module; registered factory → materialize; explicit boot-manifest row → ask the product bundle loader to load it and materialize; anything else throws. This is the runtime mirror of the build-time bundle-purity gate. The synchronous `require` handed to factories walks the same order minus the asynchronous load branch and records observed edges into the module record. `prefetch` is the stage-one arrival hook (bundle load and factory registration only; concurrent calls share one in-flight task); `invalidate` drops the factory and materialized record so the next prefetch/import reloads the bundle (the HMR hook).

The Host half scans enabled Loader entries for GUI `dsh.client` packages, resolves each `exports["./client"]`, and hashes the built bundle into the boot graph. It resolves closed-runtime packages from `hostModuleBaseUrl` before the profile tree, while profile-installed plugins remain discoverable from the profile base. Missing files share one build instruction followed by a package/path list, while unrelated filesystem errors remain separate failures. The Web adapter serves the bundle and source map under `/plugins`; other products consume `resourceManifest()` and enforce their own resource protocol.

## Model Experience

None, as the module loader is GUI kernel machinery; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Flat module graph by design** — every bundle is one module node whose edges point only at table leaves; the interface (`loadCache`/`edges`/`invalidate`) already supports a general module graph, so the externalization granularity can change without an interface change.
- **No unload bookkeeping of its own** — style removal and fiber teardown ordering live with the HMR driver (`@deepseek-ai/dsh-client-hmr`); the loader only inventories owned style tag ids per record.
