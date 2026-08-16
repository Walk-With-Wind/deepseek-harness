# `@deepseek-ai/dsh-gui-app`

[English](README.md) | 中文

共享 GUI profile 层。[`cordis.patch.yml`](cordis.patch.yml) 在 [`dsh-base`](../base/README.md) 之上组合与传输无关的 Host 能力、存储、公共客户端 roster，以及按会话应用 Agent Preset 的归属规则。产品适配器随后叠加：[`dsh-web-app`](../web-app/README.md) 增加 HTTP/WebSocket 与浏览器资源，Electron 应用增加私有 IPC 和原生 provider。

本层不依赖 WebServer 或 Electron。它随包交付部署方拥有的 [`agent-presets/`](agent-presets) 清单，并导出 `guiAppResourceOverlays()`，使 Web、CLI 与 Desktop 注入同一只读系统根而不重复产品路径。共享 GUI 行的 id 和配置只在此处定义；只有 provider 确实不同，产品适配器才可以完整替换对应行。

## 模型体验

通过所组合的 Host 与客户端行间接产生影响。每个会话的 Agent Preset 负责面向模型的提示词与工具选择；本包自身不增加模型可见文本。

#### KV Cache 影响

无直接影响；每条组合行分别负责自身影响。

## 已知限制与暂缓事项

- Desktop 资源发布仍依赖 Electron 应用的签名 `app://` adapter 与打包路径验证。
