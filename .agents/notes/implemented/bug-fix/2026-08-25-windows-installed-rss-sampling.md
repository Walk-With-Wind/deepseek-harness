# Agent Note: Stop re-enumerating the Windows process tree for installed RSS samples

Status: implemented

English | [中文](2026-08-25-windows-installed-rss-sampling.zh.md)

## Problem

Final-maker acceptance measures peak RSS for Main, Renderer, and Utility while the installed application persists 100 MiB of attachments. The Windows implementation previously started PowerShell synchronously every 100 milliseconds: it first re-enumerated the complete process tree through `Get-CimInstance Win32_Process`, then read working sets through `Get-Process`. PowerShell and WMI queries can take longer than the sampling interval and had no timeout.

The synchronous queries block the same Node.js event loop that drives Playwright, the persistence deadline, and shutdown deadlines. Continuously overdue timers can therefore leave acceptance in the attachment phase without advancing page operations or firing the existing five-minute failure deadline. The script also emitted output only when it completed or failed, so the native runner log could not identify the stopping point.

## Decision

The attachment phase takes one process-tree snapshot to determine the Main, Renderer, and Utility PIDs, then reads working sets only for that fixed set when recording peak samples. The export phase measures only the known Utility PID. Windows samples RSS once per second while other platforms retain the 100-millisecond interval. Low-frequency endurance checks continue to refresh the process tree because they rotate Renderer windows.

Every PowerShell JSON query has a 10-second limit and preserves startup or timeout errors as acceptance failures. Timer samplers capture query failures, stop further sampling, and throw the failure after the current asynchronous operation settles, so a timer callback cannot create an uncaught exception.

Installed-data acceptance emits launch, attachment-persistence, attachment-complete, optional export/endurance, and shutdown phase markers. A live log can therefore distinguish application startup, the data path, optional stress paths, and exit.

## Verification

The Desktop workflow test fixes the one-second Windows interval, stable-PID reuse, Utility-only export measurement, PowerShell timeout and error handling, and key phase markers. The native Windows final-maker lane remains responsible for proving the complete real-installer, PowerShell, WMI, attachment-persistence, RSS-limit, uninstall, and reinstall behavior.

## Alternatives considered

**Remove the Windows RSS limit entirely.** This would prevent the sampler from affecting the workload but would also delete the large-attachment memory regression evidence for the final installed application. Lightweight fixed-PID queries retain that limit without high-frequency WMI work.

**Only change the existing persistence deadline.** The deadline runs on the event loop blocked by synchronous PowerShell. Raising or lowering its value cannot make it fire reliably.

**Enumerate the complete process tree asynchronously for every sample.** Asynchronous calls would not block the event loop, but queries would still accumulate when WMI is slower than the interval and the acceptance harness would keep creating additional system load. Stable phases do not need topology rediscovery.

## Consequences

Windows peak samples move from 100-millisecond to one-second temporal resolution, but synchronous high-frequency WMI queries no longer perturb the memory acceptance. Attachment and export phases require the measured processes to remain alive; a missing PID or a PowerShell query that cannot finish within the limit fails explicitly. Endurance still refreshes topology at a lower frequency, and phase logging gives future native CI failures a locatable last-progress marker.
