# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件注入产品选定的 `ctx.clientCarrier`，并挂载 `ctx.connection`（共享 API 客户端 + 载体权限来源 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）。`ClientCarrier` 暴露逻辑基址、Fetch 语义、两条按完整信封分片的字节下行、权限来源与异步关闭，且不导入 Web 或 Electron 类型。浏览器安全的 `./carrier` 导出让静态 Web 与 Desktop 外壳取得载体接口及适配器，同时不会把 `./client` Loader registration bundle 当作 ESM 入口执行。`CarrierApiClient` 保留共享 API 信封／schema 行为；`createConnectionRpc` 接收载体的显式 Fetch 实现。`WebClientCarrier` 是浏览器适配器，使用 HTTP POST，并为 `events.mux` 与 `events.host` 各建立一条只下行 WebSocket；其权限来源与基址在创建时固定。每次就绪握手都会在 `onConnected` 前发布完整 `host.describe`，generation 失效或停止时清空。Host half 继续持有 `/api` 路由、Fetch bridge、Web 信任栅栏与 WebSocket upgrade；已注册的 Typert interceptor 会在 API Proxy 回退前认领自己的 Remote endpoint。特权方法信任策略与 [WebSocket 下行决策](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)保持不变。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## Desktop IPC 载体

`IpcClientCarrier` 与 `IpcHostBridge` 在一条绑定 generation 的 `MessagePort` 上运行同一套 Fetch 形态协议，不打开网络 listener。闭合 frame 联合承载请求／响应元数据及 pull 驱动的正文分片；每个方向只允许一个未完成 pull 和至多一个 1 MiB 在途分片，双向传播取消与物理端口关闭，并拒绝旧 generation 流量。Renderer 载体会在结构化克隆前把上游小分片合并为 1 MiB frame，既限制驻留数据，也避免每个浏览器常见的 64 KiB 分片都产生一次跨进程复制。

`IpcHostBridge.resourceSnapshot()` 只报告生命周期阶段和请求／reader 聚合计数。Desktop Utility 把这些值与 bridge 及原生操作计数聚合，供发行耐久门禁使用；两个 API 都不暴露请求 id、路由、路径或正文。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **Web `/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，可容纳默认 100 MiB 原始图片总量与有界上传 Manifest）因此同时是单请求的驻留内存上界。Desktop IPC 不具有该整体缓冲行为；若要进一步降低 Web 驻留内存，需要流式 `node:http` bridge。
