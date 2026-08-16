# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Shared GUI shell kernel: `new AppGuiEntry(el, options).run()` mounts the client through the two-stage boot using an explicit parsed manifest, `ClientCarrier`, optional bundle loader, and platform capabilities. Stage one builds `@deepseek-ai/dsh-client-modules` over the manifest and prefetches the `immediately` tier in parallel. Stage two mounts the vendored Cordis Loader, provides the carrier and platform capabilities through a shell-owned bootstrap entry, creates one loader entry per graph row plus the app-shell assembly entry, and gates AppRoot on full activation. Composition remains entirely in the Host manifest. `AppWebEntry` is a thin compatibility adapter that parses `window.__DSH_BOOT__`, constructs `WebClientCarrier`, and delegates to `AppGuiEntry`.

Shell self-sufficiency remains a hard rule for the generic kernel: loading state and signals live here (`loader-status.ts`), so the loading page works while plugins fail. The module-system adoption wrapper, GUI bootstrap Provider, and app-shell assembly are shell-owned static entries; every product/client row still arrives through the manifest. The Web wrapper imports only its browser carrier adapter.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shared modules: seed-table keys, tsdown client externals, and the Vite alias set are its projections.

`GuiBootOptions.loadBundle` forwards the module system's bundle transport override for desktop `app://` loading and tests. The Web wrapper retains the optional `BootSeams` argument for existing callers whose external `<script>` execution cannot reach the page context.

The shell owns browser-title projection. With a selected session carrying a durable title, it renders `<session title> — <existing HTML title>` and reacts to later title revisions; no selection or a selected untitled session preserves the existing title, and shell unmount restores it. The existing HTML title remains the configurable product suffix.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for the boot settle; a single entry failure keeps the loading page with a loud per-entry report, no partial availability (progressive rendering returns with its own project).
- **Narrow-window shell behavior lacks an assembled walkthrough** — ui-layout implements the concession chain, but this package has no shell-level narrow-viewport acceptance case.
