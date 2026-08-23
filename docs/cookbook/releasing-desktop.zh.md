# 发布 Desktop 应用

[English](releasing-desktop.md) | 中文

本维护者 runbook 用于从 `Walk-With-Wind/deepseek-harness` fork 构建、验证并发布 DeepSeek Harness Community Build。应用沿用上游 `dsh` 版本与 `dsh-v<version>` tag 族，但产品、发行者、应用 id、可执行文件、默认 home、仓库与更新源均与官方发行隔离。

## 前置条件

使用一个冻结 commit，并保证根 `package.json` 与 `apps/desktop/package.json` 版本一致。`desktop-release` environment 持有原生签名与公证权限；独立的 `desktop-community-release` environment 持有 GitHub Release 与 Pages 发布权限。两者都应要求 reviewer 批准，并仅允许发行维护者使用。为仓库启用 immutable releases，把 GitHub Pages 设为从 Actions 部署，并在首次发布前一次性创建受保护的 `desktop-pages` 分支；该分支是 canary/stable 元数据的持久状态，不是 Pages 部署 artifact。签名材料只能留在构建 environment，不得进入仓库变量、缓存、artifact、日志、发布 job 或开发者 `.env`。

配置以下受保护 secret：

| 平台 | Secret | 用途 |
|---|---|---|
| macOS | `DSH_MAC_SIGN_IDENTITY` | codesign 选择的 Developer ID Application 身份 |
| macOS | `DSH_MAC_EXPECTED_TEAM_ID` | 最终应用签名必须包含的精确十字符 Team ID |
| macOS | `DSH_MAC_CERTIFICATE_P12_BASE64` | 导入临时 keychain 的 Base64 PKCS#12 证书 |
| macOS | `DSH_MAC_CERTIFICATE_PASSWORD` | PKCS#12 密码 |
| macOS | `DSH_APPLE_API_KEY_BASE64` | 用于公证的 Base64 App Store Connect `.p8` key |
| macOS | `DSH_APPLE_API_KEY_ID` | App Store Connect key 标识 |
| macOS | `DSH_APPLE_API_ISSUER` | App Store Connect issuer 标识 |
| Windows | `DSH_WINDOWS_CERTIFICATE_PFX_BASE64` | 导入 job 工作目录的 Base64 Authenticode PFX |
| Windows | `DSH_WINDOWS_CERTIFICATE_PASSWORD` | PFX 密码 |
| Windows | `DSH_WINDOWS_EXPECTED_SIGNER_THUMBPRINT` | 每个已签名可执行文件必须匹配的精确 SHA-1 证书指纹 |
| 发布 | `DSH_RELEASE_ADMIN_TOKEN` | 仅用于确认 immutable releases 已启用、带仓库 Administration 读权限的 fine-grained token |

组织签名服务可以在等效的受保护 runner 中设置 `DSH_WINDOWS_SIGN_WITH_PARAMS` 来替代 Windows PFX；Forge 配置同时只接受一种签名方式。

## 在没有签名凭据时发布无签名 Preview

签名凭据不可用时，无签名 Preview 路线只用于受邀测试。从当前 `master` 人工运行 `Desktop` workflow，并设置 `release=false`；pull request 构建仍是开发产物，不能成为 Preview。该 run 必须完成 `darwin-arm64`、`darwin-x64` 与 `win32-x64` 的完整无签名矩阵以及 `preview-matrix-complete`。

人工运行 `Community Desktop Unsigned Preview`，传入该 Desktop `build_run_id`。受保护 job 只接受当前 `master` commit 上成功且完整的 Preview 矩阵，检出其精确 SHA，并把每个候选的版本与源 commit 绑定到该 checkout。它通过 `pnpm run desktop:community-preview` 验证同一矩阵，确认已启用 immutable Releases，并递归解析已有的轻量或附注 Preview tag，要求其最终指向冻结 commit。它创建指向该 SHA 且包含全部资产的 draft，重新下载并比较每个字节，再以唯一 `dsh-preview-v<version>-<commit>-run.<id>` tag 发布不可变 prerelease。仓库写凭据只注入 GitHub API 和 Release 步骤，依赖安装与本地候选验证无法读取。

Preview Release 只包含两个 macOS DMG、Windows setup 可执行文件及带目标前缀的审计材料。它排除 macOS 更新 ZIP、Windows nupkg／`RELEASES`、Pages 输出以及全部 canary／stable 元数据。其内嵌构建身份为 `unsigned-preview`；应用不会创建原生 updater，**检查更新…** 会说明自动更新不可用，且 Preview 不能作为 canary 或 stable 晋级证据。

macOS Preview 应用只有 ad-hoc 签名且未经公证；Windows Preview 可执行文件没有签名。写入 Preview 验收记录前，每个 macOS lane 都会验证 packaged 应用、挂载最终 DMG、用 `codesign` 验证其中的应用，并要求 ad-hoc 身份且不存在 `Authority`；Windows lane 要求 packaged 应用可执行文件与最终 Setup 可执行文件的 Authenticode 状态均为 `NotSigned`。测试者必须检查 manifest 与 `SHA256SUMS`，只从 fork Release 获取安装器，并显式批准操作系统警告。不得把这些字节描述为可信终端用户发行；广泛发布前必须改用已签名 canary 路线。

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

确认源 commit、发行说明、应用版本和候选 `dsh-v<version>` tag 指向同一发行。产品 SemVer 在 manifest 与更新元数据中保持不变，包括预发布后缀；Forge 把它映射为纯数字三段原生应用版本，并把 `github.run_number` 映射为单调三段原生构建版本。后续构建不得重用更小序列。只有人工选择一个成功的冻结源构建 run 后，Community 发布工作流才会创建该 tag。

## 2. 构建原生矩阵

人工运行 `Desktop` workflow，并设置 `release=true`。签名矩阵使用原生 `macos-15` arm64、`macos-15-intel` x64 和 `windows-2022` x64 runner。每个 job 都会从冻结 lockfile 安装、重建 Electron 原生依赖、执行 Forge maker、验证 packaged application、安装最终 maker 产物并重新派生发行材料。完整签名矩阵成功后，独立受保护矩阵会在同样的三个原生目标下载并安装每个签名产物，再针对全部安装结果执行 60 分钟 IPC 流式耐久；随后加入 `release-acceptance.json`，上传 `darwin-arm64`、`darwin-x64` 和 `win32-x64` 候选 artifact。最终矩阵 job 要求两个阶段都成功，拒绝部分结果。

Windows 会为 Forge 设置 `DSH_DESKTOP_PACKAGE_DIAGNOSTICS=1`。固定的 Forge 补丁会把已复制的 `.bin` 清理限定在已打包应用中；在所选 Forge 版本实现等效修复前，必须保留该补丁。JSONL 记录必须包含 `forge-start`、`packager-copy-complete`、`asar-crawl-complete`、`asar-insert-complete` 和 `archive-write-complete`，每项都带 RSS、heap、external memory、文件数、目录数与聚合字节数。若 job 在某个检查点前结束或耗尽内存，应保留诊断证据并停止发行；修改 heap 上限不属于根因修复或发行证据。

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

把三个受保护候选 artifact 下载到隔离审阅目录。每个平台目录都必须包含安装器／更新包，以及 `update-manifest-<platform>-<arch>.json`、`SHA256SUMS`、`desktop-sbom.cdx.json`、`THIRD_PARTY_NOTICES.md`、`LICENSE`、`build-provenance.json` 和 `release-acceptance.json`。macOS 还包含 `releases-darwin-<arch>.json`，Windows 包含 Squirrel `RELEASES` 发行族。

确认所有 build-provenance 文件都标明同一个冻结 commit、源日期、版本、目标平台和目标架构。对下载字节重新计算 SHA-256。在原始 job 或等效受控重建中重新运行 `pnpm run verify:desktop-materials`，将 SBOM component 和第三方 notices 与 staged production closure 比对。许可证门禁必须拒绝任何没有依赖自带正文、且不在精确 package identity／version／正文 hash 审计表中的外部包；不得用 manifest 中的 SPDX 表达式替代法律正文。

在 macOS 对最终 application／DMG 运行 `codesign --verify --deep --strict`、`spctl --assess --type execute` 和 `xcrun stapler validate`，并要求精确匹配受保护 Team ID 与 Developer ID Application Authority。在 Windows，要求应用 exe 和每个分发 installer exe 的 `Get-AuthenticodeSignature` 返回 `Valid`，匹配受保护签名者指纹，并含时间戳证书。Forge 只使用 SHA-256 与 RFC 3161 时间戳服务签名。

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

把候选产物发布到编译进应用的 origin 下的隔离 canary feed，并安装上一个已签名版本。选择**检查更新…**会授权 Electron 下载已验证包；验证不经另一次提示，已下载包会在下次正常启动时应用。再使用一次**立即重启完成更新**，验证立即重启前完成 quiescent shutdown。分别测试相同／旧版本、错误 channel、错误应用／平台／架构、错误仓库／origin、缺失产物、损坏字节与无效签名；每个被拒绝情况都必须保留当前安装可运行，并在原生下载开始前失败。

## 5. 不可变发布

人工运行 `Community Desktop Publish` workflow，传入成功 Desktop 构建的 `build_run_id` 和 `channel=canary`。受保护 job 只接受当前 `master` 上且 `release-matrix-complete` job 已通过的成功 `Desktop` workflow，检出其精确 SHA，只下载三个候选 artifact，并在调用 `pnpm run desktop:community-publish` 前把候选版本与源 commit 绑定到 checkout。也可以在本地用 `--input`、一个空 `--output`、`--channel=canary`、`--expected-version` 和 `--expected-source-commit` 检查同一验证器；该命令不访问网络，也不修改远端。

发布 job 会先确认仓库 immutable-release 设置。对新 tag，它创建指向冻结 SHA 的 draft，一次性携带全部资产，重新下载全部远端资产并比较完整 hash 集合后才公开。随后必须确认已公开 Release 不可变，并使用 GitHub integrity 命令验证 Release 与每个本地资产。只有既有 tag 已公开、不可变、指向同一 SHA 且字节完全一致时才会接受；已公开 Release 绝不追加或覆盖资产。job 会把生成的通道文件覆盖到 `desktop-pages`、推送该持久状态，再通过 Pages Actions 部署完整分支。macOS 元数据指向带目标前缀的 Release ZIP；Windows `RELEASES` 索引使用指向带目标前缀 Release nupkg 的绝对 URL，因此 Pages 只承载元数据，不承载带版本的软件包字节。

至少观察 24 小时和一个完整 canary 更新周期，再审阅安装失败、启动失败、Utility／Renderer crash loop、租约冲突、更新错误与支持问题类别。stable 是后续 commit 上单独构建的最终 SemVer；所选 canary 必须位于同一版本线，且其源 commit 必须是 stable 源 commit 的祖先。把结构化验收 JSON 提交到 stable 源码，再运行 `Community Desktop Publish`，传入 `channel=stable`、已发布的 `canary_version` 和该已跟踪的相对 `acceptance_record` 路径。验证器会把记录复制到不可变 Release，把其 hash 与 reviewer 写入 release manifest，并把最终元数据同时发布到 stable 与 canary 路径，使已安装 canary 客户端能够晋级。任何 job 都不会自动晋级 canary。

验收 JSON 必须使用以下精确结构；target 条目保持所示顺序，且每个证据 URL 均属于 fork 仓库：

```json
{
  "formatVersion": 1,
  "kind": "community-desktop-stable-promotion",
  "canaryVersion": "1.2.3-rc.1",
  "canarySourceCommit": "<40-hex-canary-sha>",
  "stableVersion": "1.2.3",
  "observedAt": "2026-08-23T00:00:00.000Z",
  "observationHours": 24,
  "reviewer": "release-owner",
  "targets": [
    { "target": "darwin-arm64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#darwin-arm64" },
    { "target": "darwin-x64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#darwin-x64" },
    { "target": "win32-x64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#win32-x64" }
  ]
}
```

保留上一版已签名安装器及其兼容性说明作为人工恢复路径。stable 发布后，再从公开通道下载全部平台产物，验证签名和 hash，并执行干净账户 smoke。

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
