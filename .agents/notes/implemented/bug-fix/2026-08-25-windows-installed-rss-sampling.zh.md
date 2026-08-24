# Agent Note: Windows 安装态 RSS 采样不重复枚举进程树

Status: implemented

[English](2026-08-25-windows-installed-rss-sampling.md) | 中文

## 问题

最终 maker 验收会在已安装应用持久化 100 MiB 附件时测量 Main、Renderer 与 Utility 的 RSS 峰值。Windows 实现原先每 100 毫秒同步启动一次 PowerShell：先通过 `Get-CimInstance Win32_Process` 重新枚举完整进程树，再通过 `Get-Process` 读取工作集。PowerShell 与 WMI 查询可能比采样间隔更久，并且没有超时。

同步查询会阻塞负责 Playwright、持久化期限和关停期限的同一个 Node.js 事件循环。连续逾期的定时器因此可以让验收长时间停在附件阶段，既无法推进页面操作，也无法触发已有的五分钟失败期限；脚本只在完成或失败时输出内容，原生 runner 日志也无法指出停止位置。

## 决策

附件阶段先通过一次进程树快照确定 Main、Renderer 与 Utility PID，之后的峰值样本只读取该固定集合的工作集。导出阶段只测量已知 Utility PID。Windows 的 RSS 采样间隔为一秒，其他平台保留 100 毫秒；低频耐久检查仍会刷新进程树，以覆盖 Renderer 窗口轮换。

所有 PowerShell JSON 查询使用 10 秒上限，并把启动或超时错误作为验收故障保留。定时采样器捕获查询故障、停止继续采样，并在当前异步操作结算后抛出故障，因此不会从 timer callback 形成未捕获异常。

安装态验收会输出启动、附件持久化、附件完成、可选导出／耐久和关停阶段标记。实时日志由此可以区分应用启动、数据路径、可选压力路径与退出路径。

## 验证

Desktop workflow 测试固定 Windows 一秒采样、稳定 PID 复用、Utility 单 PID 导出测量、PowerShell 超时与错误处理，以及关键阶段标记。原生 Windows 最终 maker lane 仍负责证明真实安装器、PowerShell、WMI、附件持久化、RSS 门槛、卸载和重装的完整行为。

## 考虑过的替代方案

**完全移除 Windows RSS 门槛。** 这会避免采样器影响工作负载，但也会删除最终安装应用的大附件内存回归证据。固定 PID 的轻量查询保留门槛而不需要 WMI 高频参与。

**只增加既有持久化期限。** 期限也运行在被同步 PowerShell 阻塞的事件循环上；延长或缩短数值不能使其可靠触发。

**为每个样本异步枚举完整进程树。** 异步调用不会阻塞事件循环，但仍会在 WMI 比间隔更慢时积累查询，并让验收工具本身持续制造额外系统负载。稳定阶段没有重新发现拓扑的需要。

## 后果

Windows 峰值样本的时间分辨率从 100 毫秒变为一秒，但内存门槛不再由同步 WMI 高频查询扰动。附件与导出阶段要求测量进程保持存活；PID 消失或 PowerShell 无法在上限内完成会明确失败。耐久阶段仍以较低频率刷新拓扑，阶段日志则让后续原生 CI 故障拥有可定位的最后进度点。
