# Agent Note: Community Desktop 发行与受保护发布

Status: proposed

[English](2026-08-22-community-desktop-release.md) | 中文

## 问题

共享 Electron 实现具有与上游一致的产品表面，但个人 fork 不能使用官方应用的原生身份、数据目录、仓库或更新权限进行发布。复用这些值会让独立签名字节看起来像官方发行，让两个发行版写入同一默认 home，并允许一个仓库的可变元数据选择另一个仓库的产物。若在其他原生目标通过前发布单个成功目标，还会产生无法满足已声明支持矩阵的发行。

[Electron Desktop 决策](../../implemented/architecture/2026-08-16-electron-desktop-process-security-and-release.md)仍负责进程角色、IPC 安全、生命周期、打包和原生验收。本提案只为一个社区维护 fork 细化其发行身份与人工发布边界，不替代这些运行时决策。[平台范围决策](../../implemented/simplification/2026-08-18-desktop-macos-windows-release-scope.md)继续负责三个受支持目标。

## 提案

fork 以 **DeepSeek Harness Community Build** 名称发行，发行者为 `Walk-With-Wind`，应用 id 为 `io.github.walk-with-wind.deepseek-harness`，Squirrel 包 id 为 `DeepSeekHarnessCommunity`，可执行文件为 `deepseek-harness-community`。用户可见行为和共享 GUI 组合继续跟随上游。构建信息、更新 manifest、provenance、SBOM 属性、notices、About UI、原生元数据与恢复 UI 均携带 Community 身份和 `https://github.com/Walk-With-Wind/deepseek-harness` 仓库。

Desktop 默认 home 为 `~/.deepseek-harness-community`。只有显式设置非空 `DSH_HOME` 才会选择与 fork CLI 或 Web 进程共享数据；规范化 home 的 Host 租约仍只允许一个写入方。独立安装的 Community Build 因此不会静默打开或修改上游安装的默认数据。

fork 的 GitHub Releases 使用上游 `dsh-v<version>` tag 族保存不可变的带版本字节。`https://walk-with-wind.github.io/deepseek-harness/desktop-updates` 下的 GitHub Pages 保存 canary 与 stable 元数据。macOS feed 条目和 Windows Squirrel 包 URL 只能解析到 fork Release。Main 会解析每个更新 URL，并拒绝不同的协议、origin、owner、仓库、tag、资产段、凭据、query 或 fragment。

`Desktop` workflow 保持仓库只读权限，生成 `darwin-arm64`、`darwin-x64` 与 `win32-x64` 三个签名候选。每个候选都包含安装器／更新字节、hash、SBOM、notices、许可证、provenance，以及签名构建／安装／耐久验收记录。产品 SemVer 保留在产品元数据中，CI run number 提供纯数字且单调的原生构建版本。发行验证会固定 macOS Team ID 与 Authority，以及 Windows 签名者指纹和时间戳；签名凭据只在安装依赖与编译完成后导入，并在签名与公证后立即移除。

独立的人工触发 workflow 在 `desktop-community-release` environment 中持有 Release 与 Pages 权限。它只接受当前 `master` 上完整矩阵成功的 `Desktop` run，把候选版本与源 commit 绑定到该 checkout，并要求仓库已启用 immutable releases。它会创建指向冻结 SHA、包含全部资产的 draft，比较重新下载的字节，公开并验证不可变性，然后在部署前把覆盖后的 canary/stable Pages 树持久化到受保护 `desktop-pages` 分支。只有既有 Release 已不可变、指向同一 SHA 且字节完全一致时才会接受。

无签名 Preview 是签名凭据就绪前供受邀测试使用的独立人工路径。人工 `Desktop` run 会记录 `releaseMode: unsigned-preview`，且全部三个原生安装器循环完成后 `preview-matrix-complete` 才会通过。写入验收记录前，原生平台工具会验证 packaged 应用与最终安装器具有预期的 ad-hoc 或 `NotSigned` 状态。Preview 发布器只接受当前 `master` 上的该 job，保留 DMG、Windows setup 可执行文件和审计材料，递归解析构建 run 专属 tag 并要求其指向冻结源码 commit，再将其发布为不可变 prerelease。依赖安装与本地候选验证期间不存在仓库写凭据。该工作流没有 Pages 权限，不生成更新 ZIP、nupkg、`RELEASES` 或通道元数据，也不能提供 canary 或 stable 证据。Main 不会为该构建模式创建原生 updater，菜单会说明自动更新不可用。

canary 是第一个允许发布的通道。stable 位于后续的最终版本 commit，所选 canary 属于同一版本线并且是其祖先。已跟踪的结构化验收记录要写明 reviewer、至少 24 小时观察期，以及三个目标的干净安装、上一版本到 canary、canary 到 stable 候选结果；其 hash 会保存在 stable Release manifest 中。stable 元数据同时写入 stable 与 canary 路径，使已安装 canary 客户端能够晋级。任何 workflow 都不会自动晋级 canary。回退只移动或移除 Pages 元数据，绝不修改带版本的 Release 资产。

[限定范围的 Forge bin 清理补丁](../../implemented/bug-fix/2026-08-23-forge-windows-bin-glob-scope.md)可防止 Windows 把仓库解释为已复制应用的搜索根目录。在应用该补丁的诊断 run 到达全部五个打包检查点且最终签名候选通过前，Windows 打包仍是原生发行门禁。显式开启的 JSONL 诊断会在 Forge 启动、复制完成、ASAR crawl 完成、insert 完成和 archive 写入完成时报告进程内存与聚合文件元数据；它不报告路径、内容、环境值或凭据。仅修改 heap 上限不能满足该门禁。

## 考虑过的替代方案

**使用官方应用身份发布。** 复用官方名称、bundle id、可执行文件、默认 home 与 updater 会让 fork 的签名和支持归属不清，并可能让独立发行的应用争用或修改同一默认数据集。

**使用 fork 仓库但保留官方更新源。** 发布者无法为不受其控制的 origin 提供可审计的可用性或回退承诺，同时还会把签名产物所有者与选择这些字节的元数据权限分离。

**每个原生目标通过后立即单独发布。** 部分发布会暴露不一致的支持矩阵，并迫使用户通过缺失资产判断发行是否完整。完整矩阵 manifest 使一个版本和源 commit 跨平台保持原子性。

**在计时器到期或 CI 通过后自动晋级 stable。** CI 无法观察支持问题、上一版本升级路径或产品验收。stable 继续由发行负责人基于 canary 记录显式执行。

**通过 canary 通道发布无签名产物。** 通道 endpoint 会让无签名字节参与自动安装，并模糊其信任状态。独立 prerelease 能保留人工测试能力，而不会削弱已签名更新策略。

**把更大的 Node heap 视为 Windows 修复。** 已观察到的失败在暂存数万文件时耗尽了已提高的 heap。只有阶段证据定位保留内存后，才可以接受最小根因修复。

## 验收标准

- 三个原生目标从同一 commit 和版本生成签名候选；每个候选都通过签名、安装／卸载／重装、1 GiB 导出和 60 分钟安装态耐久门禁。
- Windows 在不发生 OOM 的情况下到达全部五个打包诊断检查点；任何实现修复都有聚焦失败测试和原生证据。
- 完整矩阵验证器会拒绝缺失目标、修改字节、身份或源码漂移、不完整验收、不兼容的既有 Release，以及缺少祖先 canary 和结构化晋级证据的 stable。
- 无签名 Preview 验证器只接受来自所选源码且 packaged 应用与最终安装器均已验证 ad-hoc 或 `NotSigned` 状态的三个 `unsigned-preview` 候选，只把人工安装包与审计材料发布到解析后指向该源码的 tag，保持 Pages 不变，且 packaged 应用不能检查或应用原生更新。
- canary 发布把不可变 `dsh-v<version>` 资产上传到 fork，验证重新下载的 hash，部署完整持久 Pages 树，并在三个目标上都完成从上一签名版本的下次启动更新与立即重启更新。
- Security、Release、Runtime/Persistence、Client/UX、Architecture 与 Product reviewer 在独立人工 stable 发布前批准受保护记录。

## 风险

即使产品行为跟随上游，fork 发布者仍需负责证书保管、Pages 可用性、更新元数据、安全事件响应与用户支持。上游版本移动可能迫使尚未完成的候选重新 rebase。独立默认存储减少意外干扰，但现有上游会话不会出现，除非用户显式选择共享 home。安装无签名 Preview 需要用户绕过平台警告，因此不适合广泛分发。完整原生矩阵和耐久门禁会增加发行时间，人工 stable 边界也可能让代码与 CI 已通过后的晋级延迟。
