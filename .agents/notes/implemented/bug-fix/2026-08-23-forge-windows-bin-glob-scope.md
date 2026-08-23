# Agent Note: Scope Forge's Windows bin cleanup to the packaged application

Status: implemented

English | [中文](2026-08-23-forge-windows-bin-glob-scope.zh.md)

## Problem

Electron Forge 7.11.2 removes copied package-manager binaries with `fastGlob(path.join(buildPath, '**/.bin/**/*'))`. On Windows, `path.join` emits backslashes even though fast-glob requires forward slashes in glob patterns. The resulting task uses the process working directory as its search base instead of the copied application, so Forge traverses the repository and its dependency tree after file copying. This traversal runs before `packageAfterCopy`, retains enough path state to exhaust the raised Node heap, and prevents the first post-copy package diagnostic from being emitted.

## Decision

The workspace patches `@electron-forge/core@7.11.2` through pnpm. Forge now calls fast-glob with the relative pattern `**/.bin/**/*`, `cwd: buildPath`, and `absolute: true`. The cleanup therefore returns absolute paths only from the copied application on every platform without encoding a native absolute path into glob syntax.

The Desktop package diagnostic test resolves Forge from the Desktop dependency closure and inspects its installed execution file. It requires the scoped call and rejects the Windows-unsafe `path.join` form. The native Windows matrix still has to reach all five package diagnostic checkpoints before a Preview or signed release can use this build as evidence.

## Alternatives considered

**Raise the Node heap again.** The faulty traversal already consumed a raised heap while scanning data outside the packaged application. A larger limit would preserve the unbounded search and defer the same failure.

**Disable Forge's `.bin` cleanup.** This would avoid the traversal but could leave package-manager launcher files in the application. Scoping the existing cleanup preserves Forge's packaging behavior.

**Convert the absolute Windows path into glob syntax.** `fast-glob` provides conversion helpers, but a relative pattern with an explicit `cwd` directly expresses the intended search root and avoids platform-specific absolute-pattern rules.

## Consequences

Forge no longer scans the repository while cleaning the copied application, and the fix does not change ASAR contents or increase the heap limit. The patch is part of the installed and disclosed dependency set; any Forge upgrade must re-evaluate and either refresh or remove it. Native Windows CI remains the authority for memory behavior and final installer acceptance.
