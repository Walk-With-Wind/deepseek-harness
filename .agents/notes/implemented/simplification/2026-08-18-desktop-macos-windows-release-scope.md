# Agent Note: Limit Desktop releases to macOS and Windows

Status: implemented

English | [中文](2026-08-18-desktop-macos-windows-release-scope.zh.md)

## Problem

Linux Desktop packaging added DEB and RPM makers, a fourth native build/install/endurance lane, package-manager integration checks, Linux-only native staging rules, and an update state that existed only to redirect users outside the application. Maintaining that surface would consume release capacity without a current Linux Desktop requirement, while the repository's CLI, Web, and CI still need general Linux support.

## Decision

Desktop releases support macOS arm64/x64 and Windows x64. Forge produces ZIP/DMG and Squirrel artifacts only; update metadata, installer lifecycle checks, signed CI, and installed endurance checks use the same three-target matrix. Main rejects any other platform before constructing the runtime, and the Renderer update protocol contains only states reachable on supported platforms.

This scope does not remove repository-wide Linux support, Linux CI runners used for platform-neutral jobs, or Linux dependencies required by CLI, Web, native workspaces, and cross-platform development. The Desktop release checks reject reintroduced Linux package makers or workflow targets without treating generic lockfile entries as Desktop artifacts.

## Alternatives considered

**Keep Linux packages but make them best effort.** A package that bypasses signing, installer-cycle, update-policy, or endurance requirements would weaken the release definition and leave users with an unowned support level.

**Keep the Linux fallback state without producing packages.** Dead protocol and menu branches would imply an unsupported distribution path, expand validation, and allow documentation to drift back toward a product promise that the release matrix does not satisfy.

## Consequences

- Desktop has three native release targets and no DEB, RPM, Linux package-manager, or Linux update-guidance path.
- Generic Linux runtime and dependency support remains available to non-Desktop products and repository tooling.
- Adding Linux Desktop support requires a new decision that restores native packaging, installation, update ownership, documentation, and the full protected release evidence together.
