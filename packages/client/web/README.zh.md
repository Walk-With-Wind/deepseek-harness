# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

共享 GUI 外壳内核：`new AppGuiEntry(el, options).run()` 使用显式的已解析清单、`ClientCarrier`、可选 bundle loader 与平台能力，通过两阶段启动挂载客户端。第一阶段以清单为基础构建 `@deepseek-ai/dsh-client-modules`，并行预取 `immediately` 层级。第二阶段挂载仓库内置的 Cordis Loader，通过外壳自有的启动配置项提供载体与平台能力，为清单中的每条配置行及 app-shell 组装创建 loader 配置项，并以全部配置项完成激活作为 AppRoot 门禁。组合仍完全归 Host 清单所有。`AppWebEntry` 是薄兼容适配器，只解析 `window.__DSH_BOOT__`、创建 `WebClientCarrier`，再委托给 `AppGuiEntry`。

通用内核仍遵守外壳自给自足的硬性规则：启动状态与信号位于本包（`loader-status.ts`），因此插件失败时加载页面仍能工作。模块系统收编包装层、GUI 启动 Provider 与 app-shell 组装是外壳自有的静态配置项；每条产品／客户端配置行仍通过清单到达。Web 包装层只导入其浏览器载体适配器。

`PLATFORM_MODULES`（src/platform.ts）是共享模块接口的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

`GuiBootOptions.loadBundle` 为桌面 `app://` 加载与测试转发模块系统的 bundle 传输覆盖。Web 包装层继续为外部 `<script>` 执行无法到达页面上下文的现有调用方保留可选 `BootSeams` 参数。

外壳拥有浏览器标题投影。选中带有持久标题的会话时，它会渲染 `<session title> — <existing HTML title>` 并响应后续标题修订；未选择会话或选中无标题会话时，会保留现有标题；外壳卸载时恢复标题。现有 HTML 标题仍是可配置的产品后缀。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用一次性渲染**：UI 等待启动 settle；只要一个配置项失败，加载页面就会保留并逐项显示醒目的报告，不提供部分可用性（渐进式渲染将作为独立项目恢复）。
- **窄窗口外壳行为缺少组装后演练**：ui-layout 已实现让步链，但该包没有外壳级窄视口验收用例。
