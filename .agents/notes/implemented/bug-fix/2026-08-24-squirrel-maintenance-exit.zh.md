# Agent Note: Squirrel 维护退出不依赖 updater 完成

Status: implemented

[English](2026-08-24-squirrel-maintenance-exit.md) | 中文

## 问题

Squirrel 在安装、更新或卸载时，会使用维护参数启动已安装应用。默认 `electron-squirrel-startup` 处理器会为快捷方式维护启动第二个 `Update.exe`，并且只在该子进程发出 `close` 后调用 `app.quit()`。完整卸载期间，父 updater 持有包更新锁并等待应用退出，快捷方式 updater 则可能等待同一把锁。等待快捷方式 updater 会因此阻止应用与父卸载器完成。

最终 maker 验收会执行两次完整卸载。无界同步调用 `Update.exe --uninstall` 会把该产品死锁变成整个 workflow 的超时，并且无法保留直接故障诊断。

## 决策

Desktop 自行持有 Squirrel 启动处理器。安装和更新事件会启动分离的 `Update.exe --createShortcut=<executable>` 进程；卸载事件会启动 `Update.exe --removeShortcut=<executable>`。该 helper 不继承标准流、解除事件循环引用，而且不会控制应用生命周期。即使 helper 启动失败，应用也会在一秒后按计划调用 `app.quit()`。obsolete 事件会立即退出，所有已处理的维护事件都会阻止构建常规 Host。

最终 maker 验收使用 30 秒超时调用 `Update.exe --uninstall --silent`。验收会在尝试清理一次性 runner 时保留命令故障；若清理也失败，则同时报告两项故障。

## 验证

Desktop Host 测试会注入维护操作，并固定 updater 参数、一秒退出期限、启动失败行为、obsolete 事件、普通启动和非 Windows 行为。Desktop workflow 测试拒绝已移除的依赖，要求 helper 分离运行且解除引用，并要求卸载有界。原生 Windows 最终 maker 验收仍是实际安装、卸载、重装和最终清理行为的权威证据。

## 考虑过的替代方案

**修补 `electron-squirrel-startup`。** 包管理器补丁会保留一个只提供很小启动 switch 的依赖，并要求每次依赖更新都重新验证。由应用持有处理器可以明确表达并直接测试应用生命周期规则。

**卸载时立即退出而不维护快捷方式。** 该做法会避开等待环，但使安装／更新与卸载行为不对称；当父卸载器无法移除快捷方式时，还可能留下用户可见残留。分离的 best-effort 维护既保留所请求操作，又不持有应用生命周期。

**只添加 CI 超时。** 超时会限制 runner 成本，但已安装产品仍无法正常卸载。验收超时是诊断上限，不是产品修复。

## 后果

Squirrel 维护不会等待嵌套 updater 关闭，因此应用退出后，父操作可以重新取得更新锁。快捷方式维护属于 best effort；helper 启动失败不能阻塞安装或移除。被移除的依赖及其类型包不再进入生产闭包。未来修改处理器时必须保留固定退出期限，并通过原生 Windows 最终 maker 验收。
