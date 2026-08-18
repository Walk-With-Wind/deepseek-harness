# Agent Note: Electron Desktop 进程权限、生命周期与发行身份

Status: implemented

[English](2026-08-16-electron-desktop-process-security-and-release.md) | 中文

## 问题

在 Electron 中运行共享 GUI 会引入 Web 产品不具备的权限：原生窗口与对话框、已安装包文件系统、OS 进程控制、签名和更新 API，以及与 CLI／Web 进程共享持久数据的本地 Host。若把 Harness Host 放进 Main，Electron 要求保持响应的进程就会同时持有不可信 Renderer 输入、原生 UI 策略、插件、存储和长时间 Agent 工作。暴露通用 Preload bridge 或启动私有 HTTP server 会重新建立宽泛远程控制接口，并削弱无 listener 目标。若把进程退出视为干净关停，更新或崩溃还会与 session flush 和租约释放竞态。

可安装产品必须让应用代码、原生依赖、安装器、更新元数据、hash、合规材料和诊断共享同一发行身份。若在打包后签名开发树，或在每个目标就绪前发布可变更新元数据，用户运行的字节就会不同于仓库验证过的字节。

## 决策

Desktop 为每个 Electron 角色分配一种权限。Main 持有窗口／导航／权限策略、协议资源、sender 校验、对话框、更新、诊断编排与生命周期 supervisor；Utility 持有 Harness profile、业务 API dispatcher、插件、持久化、原生 provider、导出、日志与规范化 home 的 Host 租约；Preload 暴露一个冻结、带版本且命令 union 闭合的 API；Renderer 在无法访问 Node 或原始 Electron 对象的环境中运行共享 GUI 与 IPC carrier。Main 转发经过校验的外层 frame 和 generation-bound port，不解析业务请求或响应正文。

数据协议是在转交 `MessagePort` 上运行的闭合 discriminated union。每次控制和数据登记都包含 supervisor generation；替换进程会关闭旧 port 并拒绝迟到 frame。请求上限可配置且在加载时校验。Unary body 与 stream body 使用 pull 驱动 chunk，只允许一个未完成 pull 和一个在途 chunk；Renderer 会在结构化克隆前把上游小分片合并到最多 1 MiB，避免每个浏览器常见的 64 KiB 文件分片都产生一次跨进程复制。取消双向传播，每个 registry 在 close 时只结算一次。可能已经进入失败 Utility 的请求返回 outcome unknown，不自动重放。

Main 把 `app://localhost` 注册为唯一 Renderer origin。资源映射初始为空，只有取得 Utility 的严格客户端资源 manifest 后才可用。它接受打包核心资源与已声明客户端 bundle，拒绝不支持方法、路径穿越／编码分隔符／NUL、未知 id／revision 和符号链接逃逸，并按资源设置 content type 及不允许远程 script、`unsafe-eval` 或网络连接源的 CSP。BrowserWindow 启用 sandbox 和 context isolation、禁用 Node integration，默认拒绝权限／导航／popup，并且只把 allowlist 中的外部 scheme 交给 OS。窗口工厂在构造前复验唯一 WebPreferences 对象；Renderer 在 GUI boot 前复验精确 origin、Node 全局隔离与冻结 bridge key。每个 Main IPC 命令都会检查实时 WebContents、main frame、精确 origin、generation 与 schema。

Desktop 使用只替换原生路径默认值的子类替代共享 API Gateway 行。原始 `host.openPath` 载荷在 Utility 中通过 realpath 解析，只允许已登记规范 Workspace 内的目标；符号链接逃逸或缺失目标会在抵达 Main 前失败。设置与 Agent Preset 操作不从 Renderer 携带路径，因此继续使用 Host 自行解析的目标。每项获准的默认应用或文本编辑器交接都以绑定 generation 的一次性 operation id 穿过严格控制协议；Main 持有 OS 调用，取消、重复 id、关停与 Utility 替换会移除等待中的操作，同时不会暴露可接受任意路径的 Main IPC 方法。

Supervisor 将 starting、ready、degraded、recovering、circuit-open、stopping 与 stopped 视为不同状态。Utility ready 要求协议／版本一致、generation／应用版本匹配、完整 boot／资源 manifest、profile 激活与 Host 租约。POSIX 使用 owner-only 目录和经过安全分类的 Unix socket；Windows 使用具有显式 DACL 的 owner-only named pipe。租约在 Utility 挂载业务插件前取得，因此 Desktop、CLI 与 Web 在实际写入方处竞争。Utility 崩溃会关闭失败 generation，并按有界指数退避与对称抖动重试；base、maximum 与 jitter 均来自严格、应用私有且在加载时校验的配置。Renderer 恢复拥有独立失败预算：其熔断打开时只把窗口替换成恢复 UI，保留健康 Utility 与无关 Host 工作；人工重试会为同一 Utility generation 连接新的数据端口。

正常关停先停止新操作，取消 generation registry，请求 Utility flush／dispose／release，并等待 `host/quiescent`。超时升级会终止再 kill 子进程，但不会把结果标记为 quiescent。更新安装复用同一路径，只有达到 quiescence 后才调用原生 installer；否则中止安装尝试，并保持当前应用不变。

生产 updater origin 与 application id 是编译期常量。Main 从应用语义版本推导 stable／canary，校验目标版本单调递增、channel 与 HTTPS origin，并且只向 Renderer 暴露闭合状态。macOS 与 Windows 使用 Electron 原生 updater。下载与安装批准彼此分离。

构建使用与 Python 可执行 staging 规则共享的物化生产闭包，移除符号链接和错误原生变体，针对 Electron 重建原生依赖，把核心代码打入 ASAR，只解包获批原生文件，并烧录限制性 fuse。最终 installer 字节派生更新元数据、SHA-256 校验和、CycloneDX SBOM、精确 notices、许可证、构建身份与 provenance。外部依赖的法律正文必须来自包内文件，或来自同时固定 package identity、version 与正文 hash 的审计补充；未知缺失项阻断材料生成。原生 CI 矩阵构建 macOS arm64／x64 与 Windows x64；未签名与签名 job 都为每个目标分配 5,120 MiB Node old-space。实际解析的 `@electron/asar` 3.4.1 包含仓库补丁，采用有界小文件哈希、批量归档写入、迭代式分块哈希与基于集合的路径扫描，使 Forge 能在该预算内完成完整 Windows 生产闭包的最终处理。签名／公证只在受保护 environment 中运行，验证最终应用与 installer，且绝不发布远端 channel。只有完整矩阵完成后，人工才能跨过发布边界。

最终 maker 验收从 `.dmg` 或 Squirrel 产物安装应用，在阻断网络和无 API key 的环境中启动，并验证真实进程树、无监听端口、Renderer／Utility 故障恢复与独立熔断域、强制终止 Main 后使用同一 home 恢复、quiescent 关停和系统卸载。它验证应用已移除，重装同一 maker 产物，再次执行 packaged 启动 smoke，然后再次卸载。已安装 Utility 持有 home 租约时，第二份 packaged Desktop 必须完成单实例交接且首实例保持存活，真实 headless CLI 与 Web profile 也必须在挂载插件前输掉同一 home 竞争；稳定快照证明所有失败进程均未新增、删除或修改会话、Workspace storage、附件、设置或凭据。原生探针直接加载全部已解包 `.node`，并执行 sharp、Koffi、PTY 与 ripgrep。共享门禁用请求和响应均为 1 KiB 的生产 carrier／Host bridge 与同一 dispatcher 直连路径比较，测量额外 p95 往返开销并要求不超过 10 ms；已安装三目标耐久矩阵还会通过最终 Renderer、Preload 转交的 Electron `MessagePort` 和 Utility handler，使用 20 次预热和 100 个样本重复该测量。macOS job 只篡改一次性应用副本，恢复有效的 ad-hoc 签名，并要求 embedded ASAR integrity 在 Renderer ready 前拒绝启动。受保护矩阵通过已安装 Renderer／Preload／Main／Utility 进程链各执行一次取消和一个不小于 1 GiB 的成功归档；只有显式开启且同时处于 CI 与 packaged 状态时，Main 才把目标固定到一次性 home 的 owner-only 目录，验收插件为生产 Session 导出 handler 提供有界合成持久化、谱系与附件数据源，不新增 Renderer 命令。门禁会验证中央目录条目与流式 SHA-256。签名矩阵完成后，每个耐久目标都使用外部回环 provider，每第五个流取消，每 100 个请求替换 Renderer 以轮换实际端口，对已安装进程树持续采样 60 分钟，并要求 Utility 的 bridge／registry／reader／原生操作聚合计数回到基线。这些自动门禁生成候选证据，但不替代最终安装 GUI 的验收记录、上一签名版本更新演练、canary 观察或人工发布批准。

空闲内存发行检查在 READY 后连续采样五分钟，并对 Main、Utility 与 Renderer 的平台原生 RSS 求和，不扣除在多个进程中驻留的 Electron Framework 页。门槛为 560 MiB：macOS arm64 参考产物的 p95 为 532.4 MiB，三进程物理 footprint 合计约 324 MiB；该门槛为 RSS 保留约 5% 波动空间，同时不把跨平台指标替换为平台专属的 footprint 统计。已安装数据验收会通过 Renderer、Main 与 Utility 提交 20 张各 5 MiB 的图片、持久化 20 个对象，并要求三个进程相对稳定基线的峰值 RSS 增量不超过 300 MiB；参考安装包实测为 272,711,680 字节。磁盘暂存、准入阶段生成 480px WebP 派生图、关闭 libvips 缓存、按视口延迟加载缩略图、按用途缓存 URL 与按需读取原图共同构成该门槛的实现机制。

结构化日志只允许稳定 code 和数值生命周期字段，按大小轮转并使用 owner-only 文件。诊断导出在用户确认后从 allowlist 重新构建 ZIP，绝不盲目复制原始日志，并排除凭据、环境变量、会话／模型正文、工作区／插件内容与绝对路径。

## 考虑过的替代方案

**在 Main 中运行 Host。** 这会少一个进程和 bridge，但插件或原生工作可能阻塞／崩溃窗口权限主体，Renderer 输入也会抵达持有文件系统、更新与导航权限的同一进程。干净重启 Host 还会与重启整个应用不可分离。

**使用隐藏 localhost WebServer。** 复用 HTTP／WebSocket 可以减少 IPC 代码，却会创建监听 socket、port／认证生命周期、浏览器 origin 暴露，以及绕开 sender／generation 校验的新路径。与传输无关的 dispatcher 和显式 carrier 能复用协议行为，而不引入该权限。

**通过 Preload 暴露通用 invoke／send／on。** 通用 bridge 会让 Renderer 选择 Main 未明确授予的 channel 或 payload。闭合 schema 随带版本命令演进，使每项权限都可审阅。

**让 Main 持有 Host 租约。** Utility 失败或尚未挂载持久化时 Main 仍可能存活，因此其 lock 无法证明实际写入方存在。Utility 所有权让租约生命周期与业务写入对齐，也让 CLI／Web 复用同一原语。

**Utility 重启后重试 mutation。** 这可能重复执行在故障前已跨过进程边界的操作。Outcome unknown 加 baseline 重建保留至多一次提交，不进行猜测。

**从一个 cross-compile runner 发布 installer，或在验证后再签名。** 原生 ABI、helper 签名、installer 行为与公证都是目标特定最终字节的属性。原生受保护构建和签名后验证保证测试 artifact 与候选发行完全一致。

**在首发中提供 Linux 包。** 这会增加 DEB／RPM maker、软件包管理器专属验收和第四条原生发行 lane。[Desktop 平台范围决策](../simplification/2026-08-18-desktop-macos-windows-release-scope.md)将受支持发行矩阵限制为 macOS 与 Windows。

## 后果

- Main 足够小且可审计，但必须监督真实 Utility 协议、generation registry 和有界清理，不能直接调用 Host 方法。
- Utility 故障可以在不丢弃健康 Renderer 的情况下恢复，Renderer 故障也能在不终止健康 Host 的情况下替换窗口；旧进程 artifact 在新 generation 中没有权限。
- 独占 home 租约保护跨产品共享持久数据，代价是用户不能针对同一 `DSH_HOME` 同时运行两个 Host 写入方。
- 原生 package 证据必然属于三 runner 发行问题。本机未签名打包可以验证闭包、ASAR／fuse、原生加载、进程 wiring 与材料，但不能声称平台签名、公证、更新 feed 可用或 stable 已发布。
- 发行可靠性检查会增加受保护 CI 的时长；三目标 60 分钟耐久矩阵与 20 个冷启动／20 个温启动性能样本只在人工 release 运行，不进入普通 PR，但矩阵汇总会把任何一项失败视为发行失败。
- 日志与诊断包用任意调试细节换取可审阅的隐私保证；支持请求使用稳定 code 和用户审阅 artifact，不索取完整 home 副本。
- [GUI 分层／RPC Note](2026-07-19-gui-layering-and-rpc-protocol.md)、[Web 传输 Note](2026-07-24-web-config-tree-boot-and-transport-layering.md)和[共享 GUI carrier Note](2026-08-16-shared-gui-composition-and-explicit-carrier.md)仍保持活跃：本决策实现其扩展点，但不替代协议、Web 或共享组合理由。
