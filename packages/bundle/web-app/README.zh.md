# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

叠加在 [`dsh-gui-app`](../gui-app/README.md) 之上的浏览器传输组合包。[`cordis.patch.yml`](cordis.patch.yml) 只增加浏览器专属行：WebServer 载体、HTTP/WebSocket 绑定、浏览器模块分发、目录选择器决策、客户端 HMR 与本包的 `web-runtime` 粘合插件（配置为 `{printUrl, surfaceContext, trustedHosts}`）。共享存储、API 网关、Host 服务、客户端 roster、persona 与按会话应用 Agent Preset 的归属规则仍由 `dsh-gui-app` 持有，因此其他 GUI 载体复用它们时无需加载 WebServer。运行时插件通过 `@deepseek-ai/dsh-web-frontend` exports 解析已构建的前端 dist，只采样一次依赖绑定地址的 LAN 信任信息并将 `webRuntime` 提供给浏览器信任栅栏，挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退席位所有者，按配置注册 Web 专属提示词与 shell 运行时上下文，并仅在 Loader 配置树结算后打印 `dsh web:` URL。普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）通过 [`dsh-cmdline`](../../boot/cmdline/README.md) 解析 `--host`、`--port`、可重复的 `--trusted-host` 与应用帮助；需要启动值的行会注入该服务，因此显示帮助时不会绑定端口。[`dsh-headless`](../headless/README.md) 仍是直接叠加在 base 之上的表层，不挂载任何 GUI 层。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。
