# Agent Note: 共享 GUI 组合与显式客户端载体

Status: implemented

[English](2026-08-16-shared-gui-composition-and-explicit-carrier.md) | 中文

## 问题

浏览器组合包同时持有两类无关职责：可复用的 GUI Host／客户端组合，以及 HTTP/WebSocket 产品传输。若通过复制该 patch 增加桌面载体，存储、API 网关、客户端配置行、Agent Preset 规则及其默认值都会出现两个所有者。浏览器外壳还直接读取 `window.__DSH_BOOT__`，连接插件则自行创建 Web 传输，因此共享 React/Cordis 启动路径无法在不检测运行环境的前提下接收 IPC 清单或载体。

## 决策

GUI profile 使用三个有序的所有权层。`dsh-base` 持有与模式无关的 Harness 能力。`dsh-gui-app` 持有与传输无关的 GUI Host 服务、存储、共享客户端 roster、GUI 默认值，以及按会话应用 Agent Preset 的组合。产品层随后只持有自身载体与平台资源：`dsh-web-app` 提供 Web 启动、WebServer、HTTP/WebSocket 绑定、浏览器模块分发、目录选择器决策和客户端 HMR；桌面应用提供私有 IPC 与原生 Provider。因此正式 Web 模板为 `dsh-base + dsh-gui-app + dsh-web-app`。

`AppGuiEntry` 是共享 GUI 内核。其构造函数接收已解析的启动清单、`ClientCarrier`、可选 bundle loader 与平台能力。外壳自有的启动配置项会在产品客户端行激活前通过 Cordis 提供载体和平台能力。`AppWebEntry` 保留为薄兼容适配器，只负责解析 `window.__DSH_BOOT__`、创建 `WebClientCarrier`，再委托给 `AppGuiEntry`。

客户端连接插件注入 `clientCarrier`；它不检测浏览器环境，也不自行创建 Web 传输。`CarrierApiClient` 保留共享 API 信封与 schema 行为，同时把 Fetch 和下行字节委托给载体。`createConnectionRpc` 同样接收显式 Fetch 实现和逻辑基址。浏览器适配器在创建载体时固定权限来源与基址，因此之后修改页面全局对象也不能重定向已建立的客户端。

Host API 路由采用相同拆分。与传输无关的 dispatcher 持有请求解析、handler 调用、响应信封、stream pull／cancel 行为与 registry 清理；Web 和 IPC adapter 只翻译各自的外层 carrier frame。`ClientModuleRegistry` 持有包发现、图 hash 与严格资源 manifest；其 `/web` 入口持有 WebServer route 和 HTML 注入，Desktop 则通过 `app://` 映射同一可信 manifest。封闭宿主提供 `hostModuleBaseUrl`，让宿主自有 adapter 先从已安装应用解析，再从 profile 依赖树发现 profile 安装的插件。

## 考虑过的替代方案

| 弃案 | 理由 |
|---|---|
| 把 Web patch 复制成桌面 patch | 共享行、默认值和 Agent Preset 规则会立即出现两个所有者，并独立漂移。 |
| 保留 `AppWebEntry` 作为共享内核，再按 Electron 全局对象分支 | 共享代码会依赖产品运行时，浏览器全局检测也会成为传输约定的一部分。 |
| 让连接插件继续创建 `WebApiClient` | 桌面入口即使能传清单，也无法在没有另一项隐藏全局状态或产品分支时选择物理传输。 |
| 把共享 GUI 行移进 `dsh-base` | Headless 会获得其有意省略的 Host／客户端能力。 |

## 后果

- Web 组合现在包含三个正式组合包层；安装所有的旧精确层列表会规范化到新模板。
- 第二个 GUI 产品复用同一份 roster 和默认值，只实现自己的载体、资源分发与原生 Provider。
- 未提供载体会让连接配置行保持 pending，既有的全配置项激活审计会显式报告缺失服务。
- GUI 内核继续位于 `packages/client/web`，避免创建重复 UI 包；包名属于历史命名，`AppGuiEntry` 本身与产品无关。
- 模块发现与资源身份只有一个与传输无关的所有者；Web route／HTML 注入和 Desktop `app://` 映射是分离的 adapter。
- Desktop 通过自身的[四进程、安全、生命周期与发行决策](2026-08-16-electron-desktop-process-security-and-release.md)应用这些 seam；共享包不导入 Electron。
