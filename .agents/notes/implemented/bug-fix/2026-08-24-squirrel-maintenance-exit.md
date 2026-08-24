# Agent Note: Bound Squirrel maintenance exit independently of updater completion

Status: implemented

English | [中文](2026-08-24-squirrel-maintenance-exit.zh.md)

## Problem

Squirrel launches the installed application with maintenance arguments while installing, updating, or uninstalling it. The default `electron-squirrel-startup` handler launches a second `Update.exe` for shortcut maintenance and calls `app.quit()` only after that child emits `close`. During full uninstall, the parent updater holds the package update lock and waits for the application to exit, while the shortcut updater can wait for the same lock. Waiting for the shortcut updater therefore prevents the application and parent uninstaller from completing.

The final-maker acceptance executes two complete uninstall cycles. An unbounded synchronous `Update.exe --uninstall` call turns this product deadlock into a workflow-wide timeout without preserving a direct failure diagnostic.

## Decision

Desktop owns its Squirrel startup handler. Install and update events start a detached `Update.exe --createShortcut=<executable>` process; uninstall starts `Update.exe --removeShortcut=<executable>`. The helper inherits no standard streams, is unreferenced, and never controls application lifetime. The application schedules `app.quit()` after one second even when helper startup fails. The obsolete event quits immediately, and every handled maintenance event prevents regular Host construction.

Final-maker acceptance invokes `Update.exe --uninstall --silent` with a 30-second timeout. It preserves a command failure while attempting disposable-runner cleanup and reports both failures when cleanup also fails.

## Verification

The Desktop Host test injects maintenance operations and fixes the updater arguments, one-second exit deadline, startup-failure behavior, obsolete event, ordinary startup, and non-Windows behavior. The Desktop workflow test rejects the removed dependency, requires detached unreferenced helper execution, and requires a bounded uninstall. Native Windows final-maker acceptance remains the authority for real install, uninstall, reinstall, and final cleanup behavior.

## Alternatives considered

**Patch `electron-squirrel-startup`.** A package-manager patch would retain a dependency whose only required behavior is a small startup switch and would need revalidation on every dependency update. Owning the handler makes the application lifetime rule explicit and directly testable.

**Quit immediately on uninstall without shortcut maintenance.** This avoids the wait cycle but makes install/update and uninstall behavior asymmetric and can leave user-visible shortcuts when the parent uninstaller cannot remove them. Detached best-effort maintenance preserves the requested operation without owning application lifetime.

**Add only a CI timeout.** A timeout would bound runner cost but leave the installed product unable to uninstall normally. The acceptance timeout is a diagnostic limit, not the product fix.

## Consequences

Squirrel maintenance never waits for the nested updater to close, so the parent operation can regain the update lock after the application exits. Shortcut maintenance is best effort; a helper launch failure cannot hold installation or removal open. The removed dependency and its type package leave the production closure. A future handler change must preserve the fixed exit deadline and pass native Windows final-maker acceptance.
