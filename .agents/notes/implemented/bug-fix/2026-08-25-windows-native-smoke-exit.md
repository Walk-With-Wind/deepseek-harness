# Agent Note: Exit the Windows native probe after flushing its result

Status: implemented

English | [中文](2026-08-25-windows-native-smoke-exit.zh.md)

## Problem

Final-maker acceptance loads every native module from the real installed directory under the Electron ABI and executes Sharp, Koffi, ripgrep, and node-pty. On Windows the probe can complete every assertion and print `outcome: passed` while native modules retain libuv handles that keep the process alive. The parent installer waits through a synchronous child process, so it cannot proceed to the first uninstall, reinstall, or final uninstall.

Two consecutive native Preview runs stopped at the same boundary: the last log entry was the complete native success JSON, followed by no uninstall output until the job's 60-minute limit. The result content already proved native capability completion; natural event-loop exit is not behavior this acceptance needs to verify.

## Decision

The native probe writes its success result through `process.stdout.write` and awaits the callback so the JSON reaches the parent process, then exits the isolated probe with success. Every native capability assertion, PTY exit, and result flush must finish first. Any earlier error remains an unhandled failure with a nonzero exit.

The installer driver emits platform, phase, and action before each initial-install and reinstall `install`, `smoke`, and `uninstall` operation. The live log can therefore show whether a synchronous child returned and which Squirrel lifecycle action is in progress.

## Verification

The Desktop workflow test requires the native probe to await result output, exit successfully, and no longer use a direct `console.log` as its terminal action. It also requires installer lifecycle phase logging. The native Windows Preview lane remains responsible for proving that the success JSON is followed by the first uninstall, reinstall smoke, final uninstall, material verification, and Preview acceptance record.

## Alternatives considered

**Wait for every native module to release its handles.** The probe does not own third-party native modules' global handles, and acceptance only needs to prove successful loading and invocation. Waiting has no observable completion condition and already caused job-level timeouts.

**Add only a timeout around native smoke in the parent.** A timeout would classify a successful capability probe as failed and still would not enter the installer lifecycle. Ending the isolated probe explicitly expresses the real completion condition.

**Call `process.exit(0)` immediately before the success JSON is flushed.** Standard output could be truncated, removing the authoritative success evidence from the parent and CI. The write callback is an exit prerequisite.

## Consequences

The native probe does not wait for Windows handles unrelated to its result and does not claim to verify process-level cleanup for third-party modules. Result flushing remains mandatory. The installer log gains a few phase lines that directly distinguish installation, smoke, and uninstall stopping points. Future native capabilities must complete their assertions before the explicit exit.
