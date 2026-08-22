# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web boot kernel: `new AppWebEntry(el, seams?).run()` mounts the client through two stages. The module stage calls the Host-installed `window.__ModuleLoader__.create()` with `window.__DSH_BOOT__`, the shell's static modules, and any test transport override; the facade returns the constructed module system and parsed manifest after adopting parser-preloaded registrations. This package then prefetches the `immediately` tier. The plugin stage mounts the vendored Cordis Loader, injects that module system through the Loader's `internal` interface, creates every graph entry uniformly, and waits for every fiber to become ACTIVE. It then hands the marked boot DOM to the dynamic UI renderer's `ctx.uiRenderer.mount(el)` operation; the renderer hydrates that DOM before switching to the complete UI. The Host owns the graph, parser preloads, and facade; AppWebEntry does not know the bootstrap package id or parse the wire format.

The boot page uses plain DOM and local CSS, so client-bundle and plugin-activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). The modules bundle caches its own materialized exports and provides the closed-over system when its ordinary graph entry activates; Cordis service waiting makes graph-row creation order independent from that activation.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

`GuiBootOptions.loadBundle` forwards the module system's bundle transport override for desktop `app://` loading and tests. The Web wrapper retains the optional `BootSeams` argument for existing callers whose external `<script>` execution cannot reach the page context.

`AppGuiEntry` runs the same module and plugin stages for a static product shell. It installs the bootstrap facade, adds one reserved bootstrap row that provides the selected carrier and platform capabilities, and supplies any statically linked client plugins before loading dynamic graph entries. Web and Desktop therefore share activation, readiness, failure-page, and renderer behavior while retaining product-specific transports.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The application waits for the full roster** — one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported.
