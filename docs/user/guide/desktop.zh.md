# 使用桌面应用

[English](desktop.md) | 中文

DeepSeek Harness Community Build 是由 `Walk-With-Wind/deepseek-harness` fork 发行的开源扩展构建。它与上游 Harness 和共享 GUI 保持一致，但使用独立的应用、安装器、数据 home 与更新身份。应用不需要单独安装 Node.js、pnpm 或浏览器服务器，也不会打开本机端口。

## 安装

从 [Community Build 发行页](https://github.com/Walk-With-Wind/deepseek-harness/releases)下载与你的操作系统和 CPU 架构匹配的产物。只有三个平台目标全部存在、下载文件与已发布 SHA-256 校验和一致，并且平台接受其签名，才可视为完整发行产物。

- **macOS：** 打开 `.dmg`，把 **DeepSeek Harness Community Build** 拖入 Applications，再从 Applications 打开。Apple 芯片（`arm64`）与 Intel（`x64`）分别发布对应构建。
- **Windows：** 运行 `DeepSeek-Harness-Community-Setup.exe`。首发使用 Squirrel，目标为 `x64` Windows。

每个版本的发行说明会列出操作系统支持范围。不要使用为其他架构构建的产物替代。

## 首次启动

首次启动后，打开**设置 → 模型**，输入提供方凭据并保存，然后通过系统目录选择器选择工作区。Agent 只会按照所选工作区和当前权限策略取得访问能力，常规审批提示仍然生效。

Community Build 默认把设置、凭据、会话、已登记工作区和日志存放在 `~/.deepseek-harness-community`，与上游 CLI 和 Web UI 隔离。只有明确希望与 fork CLI 或 Web 进程共享 home 时，才在启动应用前设置非空 `DSH_HOME`。一个规范化共享 home 同时只能有一个 Host 写入。若启动提示 Host 租约冲突，请关闭正在使用同一 home 的其他 Desktop、Web UI 或 CLI Host，不要手动删除锁文件。再次打开 Desktop 会聚焦已有 Desktop 窗口。

已安装的 Harness 插件是可信本机代码，会在 Utility Host 中以该 Host 获得的权限执行。沙箱界面只能取得 Host 声明的客户端模块，但 Desktop 不会把不可信插件变成安全代码。只安装来自可信来源的插件。

## 文件、链接与导出

工作区选择使用操作系统目录选择器。外部链接只会把允许的 scheme 交给系统浏览器，应用窗口不会导航到外部站点。导出会话时，应用先要求选择目标位置，再由 Utility 写入，因此 Renderer 不会获得任意文件系统能力。

## 更新

Desktop 只在你于 macOS 选择 **DeepSeek Harness Community Build → 检查更新…**，或于 Windows 选择**应用 → 检查更新…**时检查更新。这项操作会授权 Electron 自动下载有效的新版本。已下载更新会在下次正常启动时应用，即使你没有选择**立即重启完成更新**；该按钮只会先排空本地 Host，在达到 quiescent 后立即重启。

在 Electron 开始原生下载前，Desktop 会读取编译进应用的 `walk-with-wind.github.io/deepseek-harness/desktop-updates` feed，并验证每个包地址。元数据只能选择 Community fork 的 GitHub Releases 中不可变的 `dsh-v<version>` 资产。稳定版拒绝预发布元数据；canary 版只能晋级到同一版本线的最终版。updater 也会拒绝相同版本、旧版本、错误仓库或错误来源。当平台 updater 无法安全降级时，发行页会保留上一版已签名安装器供人工恢复。

## 从启动失败中恢复

即使 Utility 无法启动，Desktop 仍会保留可用界面。恢复面板会显示稳定错误码、当前 runtime generation、**重新启动运行时**和**导出诊断包**。单次 Utility 崩溃会通过有界退避启动新的隔离 generation；Utility 或 Renderer 连续崩溃时，应用会暂停自动恢复，避免无限重启。

请按顺序尝试：

1. 关闭使用同一 `DSH_HOME` 的其他 Harness Host，再选择**重新启动运行时**。
2. 检查 `DSH_HOME` 与所选工作区是否可写，并确认磁盘有可用空间。
3. 在不修改或删除 sessions 目录的情况下重启 Desktop；下次 Host 成功启动时，会话存储会执行常规 crash repair。
4. 导出诊断包，并在请求支持时附上稳定错误码。

Desktop 不提供会静默禁用已安装插件的命令行“安全模式”，因为那会在没有显式配置的情况下改变所选 profile。若要隔离可信插件问题，请先备份 home，再使用常规 Harness 工具修正 profile 或插件配置，然后重启。

## 日志、诊断与隐私

Desktop 在解析后的 Community home 或显式 `DSH_HOME` 的 `logs/desktop/` 中保留仅属主可读写、按大小限制的日志。日志包含时间戳、应用版本、进程名、稳定生命周期／错误 token、generation、耗时与进程 ID，不记录模型 prompt 或响应、会话正文、凭据、Authorization header、Cookie、环境变量值、工作区内容、插件源码或任意绝对路径。

在 macOS 选择**帮助 → 导出诊断包…**，在 Windows 选择**应用 → 导出诊断包…**。Desktop 会先展示包含类别和明确排除项，再请求目标位置。分享前请检查 ZIP 内的 `contents.json`、`diagnostic.json` 与白名单 JSONL 文件。诊断包包含构建／版本身份、安全和 fuse 摘要、Desktop 配置值、不可逆标识、更新状态与近期白名单日志，但不包含 `DSH_HOME` 副本。

匿名产品遥测遵循其他 Harness 产品共用的同一设置；Desktop 诊断只保留在本机，并且只在你显式操作后导出。导出诊断 ZIP 不会上传或发送该文件。

## 卸载

- **macOS：** 退出应用，并将 Applications 中的 DeepSeek Harness Community Build 移入废纸篓。
- **Windows：** 从“已安装的应用”中卸载 DeepSeek Harness Community Build。

卸载应用不会删除 `~/.deepseek-harness-community` 或显式选择的 `DSH_HOME`。请先备份需要的会话；只有在 Community Build、CLI 或 Web 进程都不再需要其中的设置、凭据、工作区、会话或日志时，才单独移除该 home。
