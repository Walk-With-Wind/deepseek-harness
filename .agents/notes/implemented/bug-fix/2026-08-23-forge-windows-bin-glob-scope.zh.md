# Agent Note: 将 Forge 的 Windows bin 清理限定在已打包应用

Status: implemented

[English](2026-08-23-forge-windows-bin-glob-scope.md) | 中文

## 问题

Electron Forge 7.11.2 使用 `fastGlob(path.join(buildPath, '**/.bin/**/*'))` 删除已复制的包管理器二进制文件。Windows 上的 `path.join` 会产生反斜杠，但 fast-glob 要求 `pattern` 使用正斜杠。由此生成的任务会把进程工作目录而非已复制应用作为搜索基准，使 Forge 在文件复制后遍历仓库及其依赖树。该遍历发生在 `packageAfterCopy` 之前，保留的路径状态足以耗尽已提高的 Node heap，并阻止首个复制后打包诊断写出。

## 决策

工作区通过 pnpm 修补 `@electron-forge/core@7.11.2`。Forge 现在使用相对 `pattern` `**/.bin/**/*`、`cwd: buildPath` 和 `absolute: true` 调用 fast-glob。清理操作因此会在所有平台上只返回已复制应用内的绝对路径，不再把原生绝对路径编码进 glob 语法。

Desktop 打包诊断测试从 Desktop 依赖闭包解析 Forge，并检查其已安装执行文件。测试要求使用限定范围的调用，并拒绝 Windows 上不安全的 `path.join` 形式。原生 Windows 矩阵仍须到达全部五个打包诊断检查点，Preview 或签名发行才能把该构建用作证据。

## 考虑过的替代方案

**再次提高 Node heap。** 错误遍历已经在扫描已打包应用之外的数据时耗尽提高后的 heap。更大的上限会保留无界搜索，只把同一故障延后。

**禁用 Forge 的 `.bin` 清理。** 这会避免遍历，但可能在应用中留下包管理器启动文件。限定现有清理的范围可以保留 Forge 的打包行为。

**把 Windows 绝对路径转换为 glob 语法。** `fast-glob` 提供转换 helper，但相对 `pattern` 配合显式 `cwd` 能直接表达预期搜索根目录，并避免平台特有的绝对 `pattern` 规则。

## 后果

Forge 清理已复制应用时不再扫描仓库，该修复不会改变 ASAR 内容，也不会提高 heap 上限。补丁属于已安装并披露的依赖集合；升级 Forge 时必须重新评估并更新或删除补丁。原生 Windows CI 仍是内存行为和最终安装器验收的权威证据。
