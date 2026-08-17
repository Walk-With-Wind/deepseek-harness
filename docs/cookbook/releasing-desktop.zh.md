# 发布 Desktop 应用

[English](releasing-desktop.md) | 中文

本维护者 runbook 用于构建并验证 Desktop 发行矩阵。流程有意在任何远端产物或更新通道发布之前停止：受保护的原生 CI 负责证明字节与签名，发行负责人另行批准不可变上传和 stable 通道移动。

## 前置条件

使用一个冻结 commit，并保证根 `package.json` 与 `apps/desktop/package.json` 版本一致。受保护 GitHub environment 名为 `desktop-release`；应要求 reviewer 批准，并仅允许发行维护者使用。签名材料只保存在该 environment 中，不得进入仓库变量、缓存、artifact、日志或开发者 `.env`。

配置以下受保护 secret：

| 平台 | Secret | 用途 |
|---|---|---|
| macOS | `DSH_MAC_SIGN_IDENTITY` | codesign 选择的 Developer ID Application 身份 |
| macOS | `DSH_MAC_CERTIFICATE_P12_BASE64` | 导入临时 keychain 的 Base64 PKCS#12 证书 |
| macOS | `DSH_MAC_CERTIFICATE_PASSWORD` | PKCS#12 密码 |
| macOS | `DSH_APPLE_API_KEY_BASE64` | 用于公证的 Base64 App Store Connect `.p8` key |
| macOS | `DSH_APPLE_API_KEY_ID` | App Store Connect key 标识 |
| macOS | `DSH_APPLE_API_ISSUER` | App Store Connect issuer 标识 |
| Windows | `DSH_WINDOWS_CERTIFICATE_PFX_BASE64` | 导入 job 工作目录的 Base64 Authenticode PFX |
| Windows | `DSH_WINDOWS_CERTIFICATE_PASSWORD` | PFX 密码 |

组织签名服务可以在等效的受保护 runner 中设置 `DSH_WINDOWS_SIGN_WITH_PARAMS` 来替代 Windows PFX；Forge 配置同时只接受一种签名方式。

## 1. 验证冻结源

在干净 checkout 中使用锁定的 pnpm 和受支持 Node 版本，执行一次相关源码门禁：

```sh
pnpm install --frozen-lockfile
pnpm run test:desktop
pnpm run test:desktop:ipc-latency
pnpm run build:desktop
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run website:build
```

确认源 commit、发行说明、应用版本和候选 `dsh-v<version>` tag 指向同一发行。只有常规仓库发行策略授权后才能创建 tag。

## 2. 构建原生矩阵

人工运行 `Desktop` workflow，并设置 `release=true`。签名矩阵使用原生 `macos-15` arm64、`macos-15-intel` x64 和 `windows-2022` x64 runner。每个 job 都会从冻结 lockfile 安装、重建 Electron 原生依赖、执行 Forge maker、验证 packaged application、安装最终 maker 产物并重新派生发行材料。完整签名矩阵成功后，独立受保护矩阵会在同样的三个原生目标下载并安装每个签名产物，再针对全部安装结果执行 60 分钟 IPC 流式耐久。最终矩阵 job 要求两个阶段都成功，拒绝部分结果。

在匹配平台与架构上进行本机未签名调查时运行：

```sh
pnpm run make:desktop
pnpm run verify:desktop-artifact
pnpm run test:desktop:asar-tamper
pnpm run test:desktop:packaged
pnpm run verify:desktop-materials
```

未签名输出只能作为测试证据，绝不能提升为 macOS 或 Windows 发行产物。`pnpm run test:desktop:installer` 会真实安装、卸载、重装系统应用，再次执行 packaged 启动 smoke 并最终卸载，只能在一次性 CI runner 上执行，不能用于开发者日常工作站。

## 3. 检查发行族

把三个受保护 artifact 下载到隔离审阅目录。每个平台目录都必须包含安装器／更新包，以及 `update-manifest-<platform>-<arch>.json`、`SHA256SUMS`、`desktop-sbom.cdx.json`、`THIRD_PARTY_NOTICES.md`、`LICENSE` 和 `build-provenance.json`。macOS 还包含 `releases-darwin-<arch>.json`，Windows 包含 Squirrel `RELEASES` 发行族。

确认所有 build-provenance 文件都标明同一个冻结 commit、源日期、版本、目标平台和目标架构。对下载字节重新计算 SHA-256。在原始 job 或等效受控重建中重新运行 `pnpm run verify:desktop-materials`，将 SBOM component 和第三方 notices 与 staged production closure 比对。许可证门禁必须拒绝任何没有依赖自带正文、且不在精确 package identity／version／正文 hash 审计表中的外部包；不得用 manifest 中的 SPDX 表达式替代法律正文。

在 macOS 对最终 application／DMG 运行 `codesign --verify --deep --strict`、`spctl --assess --type execute` 和 `xcrun stapler validate`。在 Windows，要求应用 exe 和每个分发 installer exe 的 `Get-AuthenticodeSignature` 返回 `Valid`，并具有时间戳和已批准 subject。

## 4. 演练安装与更新

在没有 checkout、全局 Node、pnpm 或既有 Harness home 的干净 OS 账户中安装每个最终产物。自动 installer smoke 会在阻断代理和无 API key 下启动，验证 Renderer 安全启动、真实进程树、无 TCP／UDP listener、Renderer 与 Utility 分别崩溃后的恢复和独立熔断域、强制终止 Main 后使用同一 home 恢复、quiescent 退出、全部 `.node` load，以及 sharp、Koffi、PTY 和 ripgrep 的功能探针。随后它卸载并验证应用已移除，重装同一 maker 产物，再次执行 packaged 启动 smoke，最后完成卸载与清理。共享 lane 要求请求和响应均为 1 KiB 的 unary IPC 额外 p95 往返开销不超过 10 ms。每个 macOS lane 都会篡改一次性应用副本内 `lib/main.js` 注释中的一个字节，并对该副本重新进行 ad-hoc 签名，避免 OS 签名失败掩盖结果；Electron 必须在 Renderer ready 前报告 ASAR integrity 失败。在一次性 CI home 中，只用于验收的可信插件提供有界合成持久化、谱系与附件数据源，Main 则把目标固定到 owner-only 目录；已安装 GUI 通过 Renderer、Preload、Main 与 Utility 调用正常保存和取消命令，由生产 Session 导出 handler 生成 ZIP。发行门禁各完成一次取消和一个不小于 1 GiB 的成功归档，验证中央目录内的 Session／媒体条目及流式 SHA-256，要求原子清理，并把 Utility RSS 增长限制在 128 MiB。受保护矩阵还会从不同 home 保留 20 个冷启动原始样本，并从同一个共享 home 保留 20 个温启动／RSS 原始样本；关停 p95 会同时包含两组样本。进程 smoke 不能替代以下用户流程检查。

每个 60 分钟耐久 job 都会让一个最终安装目标连接由测试驱动进程持有的、仅监听回环的 OpenAI 兼容 provider。耐久流量开始前，已安装 Renderer 会通过 Preload 转交的 Electron `MessagePort` 发送 20 次预热和 100 次测量用 1 KiB unary 请求；门禁减去同一个 Utility handler 的 p95 耗时，并要求额外往返开销不超过 10 ms。随后它持续拉取 4 KiB 响应分块，每第五个 turn 取消，并每 100 个请求终止受监督 Renderer，使 Main 替换 BrowserWindow 并连接新的真实 `MessagePort`。临时可信 Utility 插件只记录 bridge、registry、reader、导出、对话框与原生路径聚合计数；最终稳定快照必须与初始基线相同。每个 job 每分钟记录已安装 Main／Utility／Renderer RSS，要求请求完成、取消且至少有两个端口代际，把峰值增长限制在 128 MiB，并把尾部窗口相对头部窗口的增长限制在 64 MiB。即使失败，它也会关闭 provider、移除应用并删除两个一次性 home。保留证据只包含脱敏指标，不包含流正文或路径。

每个目标都必须在受保护发行记录中填写平台与架构、安装器文件名与 SHA-256、应用版本与源 commit、执行时间、操作者与 reviewer、一次性 Harness home 标识、测试 provider 或 fixture、下表每一行的结果，以及脱敏截图、日志或导出证据的链接。跳过某行必须写明平台不适用理由并取得 Release 批准；无法解释的跳过会阻断候选版本。

| 验收 | 最终安装应用中的必需观察结果 |
|---|---|
| A-F01 | 使用一次性测试 provider 完成首次启动、正常重启、新建 Session、恢复 Session、流式回复、停止生成和至少一次工具调用；退出并重开后再确认恢复的 transcript。 |
| A-F02 | 演练批准、用户提问、后台任务、subagent、压缩和自动 Session 标题场景；把安装应用中的 UI 结果与对应 built-browser replay 证据配对，并确认持久事件语义一致。 |
| A-F03 | 通过原生目录选择器添加 Workspace，分别执行一次取消和一次选择；确认只有已登记规范 Workspace 内的现存目标能够使用系统打开器。 |
| A-F04 | 保存一次性模型设置和凭据引用，确认二者无需重启即可热更新；随后扫描 Renderer 可见状态、结构化日志和导出的诊断 ZIP，确保不存在一次性 secret 值。 |
| A-F05 | 验证历史、搜索、投影、附件上传和生成文件操作继续使用既有 Host 数据；通过捕获 endpoint 加载 HTTPS Markdown 图片并确认没有 Referer，同时 HTTP 与本机相对图片均不加载。 |
| A-F06 | 通过原生保存对话框取消一次 Session ZIP 导出并成功完成一次；确认没有 sibling 临时文件残留，并将成功 ZIP 的条目名与 digest 同一 Session 的 Web 导出比较。 |
| A-F07 | 在系统浏览器打开一个 allowlist 内的仓库或产品文档 HTTPS 链接，再尝试非 allowlist HTTPS URL 以及 `file:`、带凭据、`javascript:` 和 `data:` URL；应用窗口保持在 `app://localhost`，全部禁用目标都未打开。 |
| A-F08 | 比对 About、导出的诊断 build 记录、安装器 provenance 和 canary 更新状态；版本、源 commit、平台与架构必须指向同一候选版本。 |

把候选产物发布到编译进应用的 origin 下的隔离 canary feed，安装上一 canary 版本，再验证发现、下载、显式安装批准、quiescent shutdown、重启与构建身份。分别测试相同／旧版本、错误 channel、错误应用／平台／架构、缺失产物、损坏字节与无效签名；每种情况都必须保留当前安装可运行。

## 5. 不可变发布

先上传带版本的产物。如果目标位置已存在同名版本产物但字节不同，必须拒绝；不得原地覆盖或修复某个发行。暴露元数据前，应重新下载远端对象并比对 hash。

只有所有必需平台字节都存在且通过验证后，才能发布 canary 更新元数据。至少观察一个完整更新周期，并审阅安装失败、启动失败、Utility／Renderer crash loop、租约冲突、更新错误与支持问题类别。应用和 CI 都不会自动把 canary 提升为 stable。

只有 Security、Release、Runtime/Persistence、Client/UX、Architecture 和 Product 的证据均无阻断缺口后，发行负责人才能移动 stable channel。保留上一版已签名安装器及其兼容性说明作为人工恢复路径。stable 移动后，再从公开渠道下载全部平台产物，验证签名和 hash，并执行干净账户 smoke。

## 停止或回退通道

若远端字节、签名、元数据或启动行为不一致，先停止通道再调查。通过发布系统的原子操作移除可变 channel 指针，或把它指回上一已知良好的签名版本；绝不覆盖带版本产物。已安装的 macOS／Windows 客户端通常通过升级到更高版本的修复包恢复。平台无法安全降级时，提供上一版已签名安装器，并明确说明数据格式兼容性。

部分成功的矩阵绝不能进入 stable。即使只有一个平台受影响，也应停止整个发行，除非发行记录明确批准分平台发布及其用户影响。

## 支持与安全事件

- **Utility 或 Renderer crash loop：** 收集稳定错误码、版本／commit、OS／架构、是否为 packaged app、更新状态和用户审阅过的诊断 ZIP；不要索取完整 `DSH_HOME`。
- **租约冲突或残留 endpoint：** 确认使用同一规范化 home 的所有 Harness 产品，并让它们正常退出。在属主／类型检查证明 socket、pipe 或 lock 属于失败 Host 之前，不得要求用户删除。
- **磁盘满或导出／更新失败：** 保留当前安装与 session 目录，释放空间后重试。检查 sibling 临时文件已移除；不得以部分 archive 替换目标文件。
- **敏感日志报告：** 停止共享／上传受影响诊断 artifact，保留访问受控的证据，轮换任何可能暴露的凭据，并在恢复通道前审计字段白名单。
- **签名 key 泄漏：** 停止通道，通过平台机构撤销／轮换受影响证书或 key，使受保护 environment 中的材料失效，并从冻结源重建所有受影响字节。不得原地重新签名既有 installer。

每次 Electron 大版本更新都要审阅其支持状态和原生 ABI 兼容性。在全部原生目标上重建并加载每个原生依赖，重复 fuse／ASAR／签名检查，并比较共享 GUI snapshot。跟踪 macOS Developer ID／App Store Connect 与 Windows 签名证书的到期时间，为轮换和一次完整 canary 周期保留足够提前量。

每个 CI job 结束时删除临时 keychain 和解码后的证书／key 文件。只按批准的 retention 策略保留受保护构建日志、验证摘要和发行 artifact；不得保留签名输入或开发 user-data 目录。
