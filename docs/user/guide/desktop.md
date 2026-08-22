# Use the Desktop app

English | [中文](desktop.zh.md)

DeepSeek Harness Community Build is an open-source extension build distributed by the `Walk-With-Wind/deepseek-harness` fork. It follows the upstream Harness and shared GUI while using a distinct application, installer, data-home, and update identity. The application does not need a separately installed Node.js, pnpm, browser server, or open local port.

## Install

Download the artifact for your operating system and CPU architecture from the [Community Build releases page](https://github.com/Walk-With-Wind/deepseek-harness/releases). A release is complete only when all three platform targets are present, its published SHA-256 sum matches the downloaded file, and the platform accepts its signature.

- **macOS:** open the `.dmg`, drag **DeepSeek Harness Community Build** to Applications, then open it from Applications. Apple silicon (`arm64`) and Intel (`x64`) builds are published separately.
- **Windows:** run `DeepSeek-Harness-Community-Setup.exe`. The first release uses Squirrel and targets `x64` Windows.

The release notes state the operating-system support window for each version. Do not substitute an artifact built for another architecture.

## First start

On first start, open **Settings → Models**, enter a provider credential, and save it. Then choose a workspace through the native directory picker. The agent receives access only according to the selected workspace and active permission policy; the normal approval prompts remain in effect.

By default, the Community Build stores settings, credentials, sessions, registered workspaces, and logs under `~/.deepseek-harness-community`; this keeps it separate from the upstream CLI and Web UI. Set a nonblank `DSH_HOME` before starting the application only when you intentionally want to share that home with a fork CLI or Web process. Only one Host may write a canonical shared home at a time. Close the other Desktop, Web UI, or CLI Host if startup reports a Host lease conflict; do not delete lock files manually. Opening Desktop a second time focuses the existing Desktop window.

Installed Harness plugins are trusted local code and execute in the Utility Host with the permissions granted to that Host. The sandboxed interface receives only client modules declared by the Host, but Desktop does not turn an untrusted plugin into safe code. Install plugins only from sources you trust.

## Files, links, and exports

Workspace selection uses the operating system directory picker. External links open in the system browser only for approved schemes; the application window never navigates to an external site. Session export asks for a destination and writes through Utility, so the Renderer never receives an arbitrary filesystem capability.

## Updates

Desktop checks for updates only when you choose **DeepSeek Harness Community Build → Check for Updates…** on macOS or **Application → Check for Updates…** on Windows. That action authorizes Electron to download a valid newer build automatically. A downloaded update is applied on the next normal application start even if you do not choose **Restart now to finish update**; that button only drains the local Host and restarts immediately after it becomes quiescent.

Before Electron starts a native download, Desktop reads the compiled `walk-with-wind.github.io/deepseek-harness/desktop-updates` feed and verifies every package URL. Metadata can select only an immutable `dsh-v<version>` asset in the Community fork's GitHub Releases. Stable builds reject prerelease metadata; canary builds may graduate only to the final release on the same version line. The updater also rejects an equal, older, wrong-repository, or wrong-origin target. The releases page retains the previous signed installer for manual recovery when a platform updater cannot downgrade safely.

## Recover from a startup failure

Desktop keeps the interface available even when Utility cannot start. The recovery panel shows a stable error code, the current runtime generation, **Restart runtime**, and **Export diagnostics**. A single Utility crash starts a new isolated generation with bounded backoff. Repeated Utility or Renderer crashes pause automatic recovery so the application does not restart indefinitely.

Try these actions in order:

1. Close another Harness Host using the same `DSH_HOME`, then select **Restart runtime**.
2. Check that `DSH_HOME` and the selected workspace are writable and that the disk has free space.
3. Restart Desktop without modifying or deleting the sessions directory; the session store performs its normal crash repair on the next successful Host start.
4. Export a diagnostic bundle and include the stable error code when requesting support.

Desktop does not provide a command-line “safe mode” that silently disables installed plugins, because that would change the selected profile without explicit configuration. To isolate a trusted plugin problem, back up the home, correct its profile or plugin configuration with the normal Harness tooling, and restart.

## Logs, diagnostics, and privacy

Desktop keeps owner-only, size-bounded logs in `logs/desktop/` under the resolved Community or explicit `DSH_HOME`. Logs contain timestamps, application version, process name, stable lifecycle/error tokens, generations, durations, and process IDs. They do not record model prompts or responses, session text, credentials, authorization headers, cookies, environment-variable values, workspace content, plugin source, or arbitrary absolute paths.

Choose **Help → Export diagnostics…** on macOS or **Application → Export diagnostics…** on Windows. Desktop shows the included categories and explicit exclusions before asking for a destination. Review `contents.json`, `diagnostic.json`, and the allowlisted JSONL files inside the ZIP before sharing it. The bundle contains build/version identity, security and fuse summary, Desktop configuration values, irreversible identifiers, update state, and recent allowlisted logs; it does not contain a copy of `DSH_HOME`.

Anonymous product telemetry follows the same Harness setting used by other products; Desktop diagnostics are local and are exported only after your explicit action. Exporting a diagnostic ZIP does not upload or send it.

## Uninstall

- **macOS:** quit the application and move DeepSeek Harness Community Build from Applications to Trash.
- **Windows:** uninstall DeepSeek Harness Community Build from Installed apps.

Uninstalling the application does not delete `~/.deepseek-harness-community` or an explicitly selected `DSH_HOME`. Back up any sessions you need, then remove that home separately only when no Community Build, CLI, or Web process needs its settings, credentials, workspaces, sessions, or logs.
