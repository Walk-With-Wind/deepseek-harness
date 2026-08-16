# @deepseek-ai/dsh-client-modules

[English](README.md) | 中文

客户端模块系统由与传输无关的 Host registry、Web 资源 adapter 和惰性 CJS 客户端表组成。`ClientModuleRegistry` 扫描 Host Loader 中的 `dsh.client` 包，校验其构建后的 `./client` 导出，组合启动图，并向产品 adapter 暴露不可变资源 manifest。只有 `/web` 入口持有 WebServer bundle route 与 HTML manifest 注入。Desktop 把严格资源 manifest 转交给 Main，将其中可信源路径映射为 `app://` 资源，并把产品自有 bundle loader 传给同一客户端表。

GUI 外壳挂载 vendored cordis Loader 来治理配置项（fiber 生命周期、inject 等待、update/refresh），并通过其 `internal` 约定注入该包的 `ClientModuleLoader`。vendored 一侧唯一的消费点是 `EntryTree.import`，因此替换 `internal` 恰好只会改变插件代码如何到达，不会改变其他内容。

惰性 CJS 模型（web2）：执行插件 bundle 只会注册其 factory（`window.__ModuleLoader__.load({id, factory})`）；每个模块主体的副作用（包括 CSS 注入）都位于 factory 闭包中，在物化时运行（`factory(require)` → 导出表层，并在 `loadCache` 中记忆化），不会在脚本执行时运行。如果 factory 依赖另一个已注册但尚未物化的模块，系统会递归物化它，因此加载顺序无需外部编排；require 循环会抛出异常（factory 形式的 CJS 无法提供部分导出）。`<id>/client` 与裸 id 指向同一表层（一个插件 bundle 就是其包的客户端侧）。

解析分支顺序（`import(specifier)`）：平台种子词 → 外壳实例；记忆化记录 → 导出；外壳自有静态注册表（`registerStatic`，app shell）→ 模块；已注册 factory → 物化；显式 boot-manifest 行 → 请求产品 bundle loader 加载并物化；其他情况一律抛出异常。这是构建时 bundle 纯度门禁的运行时镜像。交给 factory 的同步 `require` 采用相同顺序，但不含异步加载分支，并把观察到的边记录到模块记录中。`prefetch` 是第一阶段到达钩子（只加载 bundle 并注册 factory；并发调用共享一个进行中的任务）；`invalidate` 会丢弃 factory 与物化记录，使下一次 prefetch/import 重新加载 bundle；它是 HMR（热模块替换）钩子。

Host 侧会扫描已启用的 Loader 配置项以发现 GUI `dsh.client` 包，解析每个 `exports["./client"]`，并把构建后的 bundle 哈希写入启动图。封闭运行时先从 `hostModuleBaseUrl` 解析宿主包，再从 profile 树发现 profile 安装的插件。缺失文件共享一条构建说明，随后以包／路径列表列出各项；无关文件系统错误仍是独立故障。Web adapter 通过 `/plugins` 提供 bundle 与 sourcemap，其他产品消费 `resourceManifest()` 并执行自己的资源协议。

## 模型体验

无。模块 loader 属于 GUI 内核机制；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用扁平模块图**：每个 bundle 是一个模块节点，其边只指向表中的叶节点；接口（`loadCache`/`edges`/`invalidate`）已经支持通用模块图，因此可以改变 externalization 粒度而不更改接口。
- **自身不维护卸载记录**：样式移除与 fiber 拆卸顺序属于 HMR 驱动器（`@deepseek-ai/dsh-client-hmr`）；loader 只在每条记录中登记其拥有的样式标签 id。
