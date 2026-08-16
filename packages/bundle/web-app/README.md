# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The browser transport bundle over [`dsh-gui-app`](../gui-app/README.md). [`cordis.patch.yml`](cordis.patch.yml) adds only browser-specific rows: the WebServer carrier, HTTP/WebSocket bindings, browser module delivery, directory-picker selection, client HMR, and this package's `web-runtime` glue plugin (config `{printUrl, surfaceContext, trustedHosts}`). Shared storage, API gateway, Host services, client roster, persona, and per-session Agent Preset ownership remain in `dsh-gui-app`, so another GUI carrier can reuse them without loading WebServer. The runtime plugin resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend` exports, samples bind-dependent LAN trust once, provides `webRuntime` to the browser trust fence, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers Web-only prompt and shell runtime context when enabled, and prints the `dsh web:` URL only after its Loader tree settles. The ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) parses `--host`, `--port`, repeatable `--trusted-host`, and application help through [`dsh-cmdline`](../../boot/cmdline/README.md); rows that need launch values inject this service, so help never binds a port. [`dsh-headless`](../headless/README.md) remains a direct surface over base and mounts neither GUI layer.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
