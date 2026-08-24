# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Harness Community Build 是 fork 发行、复用上游共享 GUI 组合的 Electron 产品外壳。Main 持有原生策略、单个沙箱 BrowserWindow、`app://localhost` 协议、更新编排、对话框、诊断和 Utility supervisor；Preload 只暴露经过校验的 Renderer 协议；Utility 持有 Harness Host 与 home 级 Host 租约；Renderer 通过 IPC `ClientCarrier` 运行共享 `AppGuiEntry`，无法访问 Node 或 Electron，也不会打开本机网络监听端口。

未显式设置 `DSH_HOME` 时，Community Build 使用 `~/.deepseek-harness-community`，与上游 CLI 和 Web UI 的 home 隔离。显式设置非空 `DSH_HOME` 才会选择与 CLI 或 Web 共享设置、凭据、会话和工作区；此时 Host 租约保证同一规范化 home 只能有一个 Host 写入方。第二个 Desktop 实例会聚焦首个窗口，其他产品若未取得共享 home 的租约，会在挂载业务插件前失败。

## 开发

安装仓库依赖后，从源码启动应用：

```sh
pnpm --filter @deepseek-ai/dsh-desktop start
```

根脚本将源码检查与产物检查分开：

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm run package:desktop
pnpm run verify:desktop-artifact
pnpm run test:desktop:ipc-latency
pnpm run test:desktop:asar-tamper
pnpm run test:desktop:packaged
pnpm run test:desktop:installed-data
pnpm run make:desktop
pnpm run test:desktop:installer
pnpm run verify:desktop-materials
pnpm run desktop:community-publish -- --help
```

`package:desktop` 和 `make:desktop` 会在已忽略的 `.artifacts/desktop/` 目录中暂存物化后的生产依赖闭包，针对当前平台与架构重建原生模块，再调用 Electron Forge。`make:desktop` 还会从最终 staging 树和安装器字节派生更新元数据、SHA-256 校验和、CycloneDX SBOM、精确的第三方 notices、应用许可证和构建来源证明。许可证生成只接受依赖自带的可验证正文或版本／内容 hash 均匹配的已审计补充文件；新的缺失许可证依赖会直接阻断构建。

`test:desktop:packaged` 验证未安装 packaged application。其 Utility 持有 Host 租约期间，smoke 会启动第二份 packaged Desktop，要求它完成单实例交接后正常退出且首实例保持存活；还会让真实 headless CLI 与 Web profile 争用同一 home，要求二者都在挂载插件前以租约冲突退出，并验证全部竞争前后的会话、Workspace storage、附件、设置与凭据字节均未变化。`test:desktop:installer` 只允许在一次性 CI runner 上运行，会安装真实 `.dmg` 或 Squirrel 产物，检查离线启动、最终进程树、无监听端口、沙箱 Renderer 启动、Utility／Renderer 恢复、Utility 连续失败后打开熔断、强制终止 Main 后使用同一 home 恢复、quiescent 关停和原生模块实际加载。随后它卸载并验证应用已移除，重装同一 maker 产物，再次执行 packaged 启动 smoke，最后完成卸载与清理。共享 lane 测量请求和响应均为 1 KiB 的 unary IPC 额外 p95 往返开销。macOS lane 只篡改一次性应用副本，重新进行 ad-hoc 签名，并要求 ASAR integrity 拒绝启动。受保护矩阵通过已安装的 Renderer／Preload／Main／Utility 进程链各执行一次取消和成功的 1 GiB 导出，并记录 Utility RSS。所有签名目标成功后，独立三目标矩阵会下载并安装每个已签名产物，运行 60 分钟流式响应／取消，替换 Renderer 窗口以轮换真实 `MessagePort` 连接，并要求 Utility 资源计数回到基线。[Desktop 发行 runbook](../../docs/cookbook/releasing-desktop.md#4-exercise-install-and-update-paths)负责最终安装 GUI 的验收记录。

Desktop 发行构建必须在对应目标原生执行：macOS arm64、macOS x64 和 Windows x64。Community 发行使用产品名 `DeepSeek Harness Community Build`、发行者 `Walk-With-Wind`、应用 id `io.github.walk-with-wind.deepseek-harness`、Squirrel 包 id `DeepSeekHarnessCommunity` 和可执行文件名 `deepseek-harness-community`。DMG 使用较短的卷标 `DeepSeek Harness Community`，满足 macOS Alias 的 27 字符上限，同时不改变安装后的应用名称。产品 SemVer 保留在构建与更新元数据中；Forge 会从三段原生应用版本中移除预发布后缀，并把 `DSH_DESKTOP_BUILD_SEQUENCE` 映射为纯数字且单调的构建版本。macOS 调查构建使用临时 ad-hoc 签名，以便原生 updater 能在 fuse 修改后读取应用 bundle 身份；该签名不提供发行身份。只有这个本地调查签名会关闭 library validation，以允许 ad-hoc 的 Electron 嵌套二进制加载；生产 entitlements 仍强制 library validation。设置 `DSH_DESKTOP_SIGNING=1` 后，macOS 使用 Developer ID 签名与公证，Windows 使用带 RFC 3161 时间戳的 SHA-256 Authenticode 签名。受保护验证会固定 macOS Team ID 与 Authority，以及 Windows 签名者指纹。受保护构建 environment 提供平台凭据；独立的 `desktop-community-release` environment 只会把完整三目标候选发布到 fork 的不可变 GitHub Release 与持久 Pages 更新树。[发行 cookbook](../../docs/cookbook/releasing-desktop.md)负责凭据名称与发布顺序。

## 运行时与故障行为

Main 与 Utility 使用严格且带版本的控制协议通信。每次 Renderer 连接都会获得绑定新 generation 的 `MessagePort` 通道；Main 校验发送方和命令信封，但不解释 API 请求或响应正文。共享连接控制器必须先通过该端口完成一次 unary `host.describe` 请求并打开两条事件流，Renderer 才报告 ready，因此 packaged readiness 证明的是业务通道可达，而不只是传输层 hello。原生路径交接使用绑定 generation 的一次性 operation id：Utility 授权规范目标，Main 执行默认应用／文本编辑器打开器，取消或 generation 替换会移除等待中的操作。Utility 崩溃采用带有界抖动的指数退避恢复；Renderer 崩溃只替换窗口；连续失败会打开恢复熔断，并把重试和诊断导出保留为用户显式操作。包内 `desktop.config.json` 是严格校验的应用私有配置，未知字段、越界值以及不一致的 base／maximum／jitter 组合都会在创建运行时前失败。

Windows 会在构建常规 Host 前处理 Squirrel 安装、更新、卸载和 obsolete 事件。快捷方式维护在分离的 updater 进程中运行，应用会在一秒后退出且不等待该进程关闭；即使两个 updater 进程需要同一把锁，父 Squirrel 操作也能继续。安装器验收把每次 Squirrel 卸载限制为 30 秒，并在清理 runner 前报告超时。

Windows 安装态数据验收会在附件或导出阶段开始时确定需要测量的进程集合，随后每秒读取一次这些稳定 PID 的工作集，不在每个样本中重新枚举 WMI 进程树。每次 PowerShell 查询都有 10 秒上限；验收还会输出启动、附件持久化、可选导出／耐久和关停阶段标记，使原生 runner 的停止位置可直接从实时日志辨认。

关停会先停止新工作，请求 Utility flush 并 dispose，等待 `host/quiescent`，随后才退出或立即完成已下载更新。超过宽限期会升级终止，但不会宣称已达到 quiescent。macOS 与 Windows 只在用户选择更新命令后检查；在 Electron 开始自动下载前，Main 会根据编译进应用的 `https://walk-with-wind.github.io/deepseek-harness/desktop-updates` 源和 fork 的不可变 `dsh-v<version>` GitHub Release 验证每个 feed 包地址。Electron 会在下次正常启动时应用已下载更新；准备就绪操作只会请求提前进行 quiescent 重启。

日志位于解析后 home 的 `logs/desktop/`，是仅属主可读写、按大小限制的 JSONL 文件，只允许稳定事件码和数值生命周期字段。诊断导出会先显示内容与排除项确认，再原子写入 ZIP；包内包含构建身份、安全摘要、配置值、不可逆 home／资源标识、更新状态和白名单日志，明确排除凭据、环境变量、会话／模型正文、工作区内容、插件源码与绝对路径。

## 安全不变量

- 生产窗口启用 sandbox 和 context isolation、禁用 Node integration，默认拒绝导航、弹窗和权限，并使用不允许远程脚本、`unsafe-eval` 或网络连接源的 CSP。窗口创建前复验唯一 WebPreferences 配置；Renderer 在共享 GUI 启动前复验精确 origin、Node 全局隔离和冻结 bridge surface。
- Renderer 不能选择 home、profile、authority、更新源、任意 IPC channel 或绝对保存路径。Main 通过原生对话框选择路径，文件生成在 Utility 中执行。`host.openPath` 请求必须解析为已登记规范 Workspace 内的现存目标；Utility 拒绝外部目标与符号链接逃逸，每个获准的系统打开器都在 Main 中运行。
- `app://` 只提供资源 manifest 授权的打包资源，并拒绝路径穿越、编码分隔符、NUL、不支持的方法、未知资源与符号链接逃逸。
- Electron fuses 禁用 RunAsNode、`NODE_OPTIONS` 与 CLI inspect，启用 cookie encryption，在 macOS 上启用 embedded ASAR integrity，并要求从 ASAR 加载应用。
- 已安装插件是在 Utility 中执行的可信本机代码。Renderer 仍只能取得 Host 资源 manifest 声明的客户端模块；Desktop 不提供不可信插件沙箱。

## 模型体验

Desktop 不增加模型可见文本。它与 Web UI 使用相同的 GUI 组合、API 协议和已记录模型输入。

#### KV Cache 影响

无；选择 Desktop carrier 不会改变提供方请求。

## 已知限制与暂缓事项

- 首发仅包含一个主窗口，不包含托盘、深链、远程 Host 或不可信插件沙箱。
- 已签名／公证安装器和更新验证依赖受保护的原生 CI 矩阵；本机未签名 package 只能证明 staging 与运行时行为，不能证明发行身份。
- Windows 打包固定使用 Forge 补丁，把已复制的 `.bin` 清理限定在已打包应用而非仓库。发布仍需一次应用该补丁的原生诊断运行提供全部五个打包内存检查点；仅提高 Node heap 上限不构成发行证据。
