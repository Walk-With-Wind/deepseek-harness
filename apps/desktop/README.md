# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Harness Community Build is the fork-distributed Electron product shell for the shared upstream GUI composition. Main owns native policy, one sandboxed BrowserWindow, the `app://localhost` protocol, update orchestration, dialogs, diagnostics, and the Utility supervisor. Preload exposes only the validated renderer protocol. Utility owns the Harness Host and the per-home Host lease. Renderer runs the shared `AppGuiEntry` over an IPC `ClientCarrier`; it has no Node or Electron access and opens no local network listener.

Without an explicit `DSH_HOME`, the Community Build uses `~/.deepseek-harness-community`, separate from the upstream CLI and Web UI home. Setting a nonblank `DSH_HOME` opts into sharing settings, credentials, sessions, and workspaces with CLI or Web; the Host lease then admits exactly one Host writer for that canonical home. A second Desktop instance focuses the first window, and a different product that loses a shared-home lease fails before mounting business plugins.

## Development

Install the repository dependencies, then run the application from source:

```sh
pnpm --filter @deepseek-ai/dsh-desktop start
```

The root scripts separate source checks from artifact checks:

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm run package:desktop
pnpm run verify:desktop-artifact
pnpm run test:desktop:ipc-latency
pnpm run test:desktop:asar-tamper
pnpm run test:desktop:packaged
pnpm run test:desktop:installed-data
pnpm run make:desktop
pnpm run test:desktop:installer
pnpm run verify:desktop-materials
pnpm run desktop:community-publish -- --help
```

`package:desktop` and `make:desktop` stage a materialized production dependency closure under the ignored `.artifacts/desktop/` directory, rebuild native modules for the running platform and architecture, and invoke Electron Forge. `make:desktop` also derives update metadata, SHA-256 sums, a CycloneDX SBOM, exact third-party notices, the application license, and build provenance from the final staging tree and installer bytes. License generation accepts only verifiable dependency-provided text or an audited supplemental file whose package version and content hash both match; a new dependency with missing legal text fails the build.

`test:desktop:packaged` checks an unpacked packaged application. While its Utility owns the Host lease, the smoke starts a second packaged Desktop and requires a clean single-instance handoff with the first process still alive. It also starts the real headless CLI and Web profile against the same home, requires both to exit on the lease conflict before plugin mount, and verifies that sessions, Workspace storage, attachments, settings, and credentials remain byte-for-byte unchanged across all races. `test:desktop:installer` runs only on a disposable CI runner: it installs the actual `.dmg` or Squirrel artifact, then checks offline startup, the final process tree, no listening port, sandboxed Renderer startup, Utility/Renderer recovery, repeated Utility failures reaching circuit open, forced Main termination followed by same-home recovery, quiescent shutdown, and real native-module loading. It uninstalls and verifies removal, reinstalls the same maker artifact, repeats the packaged startup smoke, and performs a final uninstall and cleanup. The shared lane measures the extra p95 round-trip cost for a 1 KiB unary IPC request and response. macOS lanes mutate only a disposable application copy, re-sign it ad hoc, and require ASAR integrity to reject startup. The protected matrix runs one cancelled and one successful 1 GiB export through the installed Renderer/Preload/Main/Utility chain and records Utility RSS. After every signed target succeeds, a separate three-target matrix downloads and installs each signed artifact, runs 60 minutes of streaming/cancellation, replaces Renderer windows to rotate real `MessagePort` connections, and requires Utility resource counts to return to baseline. The [Desktop release runbook](../../docs/cookbook/releasing-desktop.md#4-exercise-install-and-update-paths) owns the final-installed GUI acceptance record.

Desktop release builds are native per target: macOS arm64, macOS x64, and Windows x64. The Community distribution uses product name `DeepSeek Harness Community Build`, publisher `Walk-With-Wind`, application id `io.github.walk-with-wind.deepseek-harness`, Squirrel package id `DeepSeekHarnessCommunity`, and executable name `deepseek-harness-community`. Its DMG uses the shorter volume name `DeepSeek Harness Community` to satisfy the macOS Alias 27-character limit without changing the installed application name. Product SemVer remains in build and update metadata; Forge removes any prerelease suffix from the three-part native application version and maps `DSH_DESKTOP_BUILD_SEQUENCE` to a numeric monotonic build version. macOS investigation builds use an ad-hoc signature so that the native updater can read the application bundle identity after fuse changes; this signature does not establish a distribution identity. Only that local investigation signature disables library validation so ad-hoc nested Electron binaries can load; production entitlements keep library validation enforced. With `DSH_DESKTOP_SIGNING=1`, macOS uses Developer ID signing and notarization, while Windows uses SHA-256 Authenticode signing with an RFC 3161 timestamp. Protected verification pins the macOS Team ID and Authority and the Windows signer thumbprint. The protected build environment supplies platform credentials; a separate `desktop-community-release` environment publishes only a complete three-target candidate to the fork's immutable GitHub Release and persistent Pages update tree. The [release cookbook](../../docs/cookbook/releasing-desktop.md) owns credential names and publication order.

## Runtime and failure behavior

Main and Utility communicate through a strict versioned control protocol. Each Renderer connection receives fresh generation-bound `MessagePort` channels; Main validates the sender and command envelope but never interprets API request or response bodies. Renderer reports ready only after the shared connection controller completes one unary `host.describe` request and opens both event streams over that port, so packaged readiness proves business-channel reachability rather than only a transport hello. Native path handoff uses one-shot generation-bound operation ids: Utility authorizes a canonical target, Main executes the default/text-editor opener, and cancellation or generation replacement removes the pending operation. Utility crashes use exponential restart with bounded jitter. Renderer crashes replace only the window. Repeated failures open the recovery circuit and leave retry and diagnostic export as explicit user actions. The packaged `desktop.config.json` is strict app-private configuration: unknown fields, out-of-range values, and inconsistent base/maximum/jitter combinations fail before runtime creation.

Shutdown first stops new work, asks Utility to flush and dispose, waits for `host/quiescent`, and only then exits or immediately finishes a downloaded update. A grace timeout escalates termination without claiming quiescence. macOS and Windows check only after the user chooses the update command; before Electron begins its automatic download, Main validates every feed package URL against the compiled `https://walk-with-wind.github.io/deepseek-harness/desktop-updates` origin and the fork's immutable `dsh-v<version>` GitHub Release. Electron applies a downloaded update on the next normal start; the ready-state action only requests an earlier quiescent restart.

Logs are owner-only, size-bounded JSONL files under the resolved home at `logs/desktop/`. Their schema admits stable event codes and numeric lifecycle fields only. A diagnostic export starts with a content/exclusion confirmation and creates an atomic ZIP containing build identity, security summary, configuration values, irreversible home/resource identifiers, update state, and allowlisted logs; it excludes credentials, environment variables, session/model text, workspace content, plugin source, and absolute paths.

## Security invariants

- The production window enables sandbox and context isolation, disables Node integration, rejects navigation, popups, and permissions by default, and runs a CSP with no remote scripts, `unsafe-eval`, or network connection source. Window creation revalidates the single WebPreferences object; Renderer revalidates its exact origin, Node-global isolation, and frozen bridge surface before the shared GUI starts.
- Renderer cannot choose a home, profile, authority, update origin, arbitrary IPC channel, or absolute save path. Native dialogs select paths in Main; file production runs in Utility. A `host.openPath` request must resolve to an existing target inside a registered canonical Workspace; Utility rejects outside targets and symlink escapes, and every accepted system opener runs in Main.
- `app://` serves only manifest-authorized packaged resources and rejects traversal, encoded separators, NULs, unsupported methods, unknown resources, and symlink escapes.
- Electron fuses disable RunAsNode, `NODE_OPTIONS`, and CLI inspection, enable cookie encryption, enable embedded ASAR integrity on macOS, and require loading the application from ASAR.
- Installed plugins are trusted local code executed by Utility. The Renderer still receives only the client modules declared by the Host resource manifest; Desktop is not an untrusted-plugin sandbox.

## Model Experience

Desktop does not add model-visible text. It carries the same GUI composition, API protocol, and logged model inputs as the Web UI.

#### KV Cache effect

None; choosing the Desktop carrier does not alter provider requests.

## Known Limitations and Deferred Work

- The first release has one main window and no tray, deep links, remote Host, or untrusted-plugin sandbox.
- Signed/notarized installer and update verification require the protected native CI matrix; a local unsigned package proves staging and runtime behavior, not release identity.
- Windows publication remains blocked until a native diagnostic run passes Forge packaging and provides all five package-memory checkpoints; increasing the Node heap limit alone is not release evidence.
