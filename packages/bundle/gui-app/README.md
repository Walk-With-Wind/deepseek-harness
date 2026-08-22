# `@deepseek-ai/dsh-gui-app`

English | [中文](README.zh.md)

The shared GUI profile layer. [`cordis.patch.yml`](cordis.patch.yml) composes transport-neutral Host capabilities, storage, the common client roster, and the per-session Agent Preset ownership rules over [`dsh-base`](../base/README.md). Product adapters apply after it: [`dsh-web-app`](../web-app/README.md) adds HTTP/WebSocket and browser resources, while the Electron app adds its private IPC and native providers.

The layer does not require WebServer or Electron. It ships the deployment-owned [`agent-presets/`](agent-presets) roster and exports `guiAppResourceOverlays()` so Web, CLI, and Desktop inject the same read-only system root without duplicating product paths. Shared GUI row ids and configuration have one owner here; a product adapter may replace a complete row only when its provider genuinely differs.

## Model Experience

Indirectly, through the composed Host and client rows. Agent Presets own each session's model-facing prompt and tool selection; this bundle adds no model-visible text itself.

#### KV Cache effect

None directly; each composed row owns its effect.

## Known Limitations and Deferred Work

- Desktop resource publication still depends on the Electron app's signed `app://` adapter and packaged-path verification.
