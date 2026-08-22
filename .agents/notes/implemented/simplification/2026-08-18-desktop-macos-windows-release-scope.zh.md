# Agent Note: 将 Desktop 发行范围限制为 macOS 与 Windows

Status: implemented

[English](2026-08-18-desktop-macos-windows-release-scope.md) | 中文

## 问题

Linux Desktop 打包会增加 DEB 与 RPM maker、第四条原生构建／安装／耐久 lane、软件包管理器集成检查、Linux 专属原生 staging 规则，以及仅用于把用户引导至应用外部的更新状态。当前没有 Linux Desktop 需求，维护这些功能会占用发行能力；与此同时，仓库的 CLI、Web 与 CI 仍需要通用 Linux 支持。

## 决策

Desktop 发行支持 macOS arm64／x64 与 Windows x64。Forge 只生成 ZIP／DMG 和 Squirrel 产物；更新元数据、安装器生命周期检查、签名 CI 与已安装耐久检查使用同一组三目标矩阵。Main 在构造运行时前拒绝其他平台，Renderer 更新协议只包含受支持平台可达的状态。

该范围不移除仓库级 Linux 支持、平台无关 job 使用的 Linux CI runner，也不移除 CLI、Web、原生 workspace 与跨平台开发所需的 Linux 依赖。Desktop 发行检查会拒绝重新引入 Linux package maker 或 workflow 目标，但不会把通用 lockfile 条目误判为 Desktop 产物。

## 考虑过的替代方案

**保留 Linux 包，但按尽力而为提供。** 绕过签名、安装器周期、更新策略或耐久要求的软件包会削弱发行定义，并留下无人负责的支持等级。

**保留 Linux 降级状态，但不生成安装包。** 不可达的协议和菜单分支会暗示一个不受支持的分发路径、扩大验证范围，并让文档重新漂移为发行矩阵无法满足的产品承诺。

## 后果

- Desktop 有三个原生发行目标，不包含 DEB、RPM、Linux 软件包管理器或 Linux 更新指引路径。
- 通用 Linux 运行时与依赖支持仍供非 Desktop 产品和仓库工具使用。
- 若要增加 Linux Desktop 支持，必须通过新决策同时恢复原生打包、安装、更新所有权、文档与完整受保护发行证据。
