# Release the Desktop application

English | [中文](releasing-desktop.zh.md)

This maintainer runbook builds, verifies, and publishes DeepSeek Harness Community Build from the `Walk-With-Wind/deepseek-harness` fork. The application follows the upstream `dsh` version and `dsh-v<version>` tag family, while its product, publisher, application id, executable, default home, repository, and update origin remain isolated from an official distribution.

## Prerequisites

Use one frozen commit whose root and `apps/desktop/package.json` versions agree. The `desktop-release` environment owns native signing and notarization; the separate `desktop-community-release` environment owns GitHub Release and Pages publication. Require reviewer approval for both and restrict them to release maintainers. Enable immutable releases for the repository, configure GitHub Pages to deploy from Actions, and create the protected `desktop-pages` branch once before the first publication; that branch is the durable canary/stable metadata state, not the Pages deployment artifact. Keep signing material in the build environment only, never in repository variables, caches, artifacts, logs, publication jobs, or developer `.env` files.

Configure these protected secrets:

| Platform | Secret | Purpose |
|---|---|---|
| macOS | `DSH_MAC_SIGN_IDENTITY` | Developer ID Application identity selected by codesign |
| macOS | `DSH_MAC_EXPECTED_TEAM_ID` | Exact ten-character Team ID required from the final application signature |
| macOS | `DSH_MAC_CERTIFICATE_P12_BASE64` | Base64 PKCS#12 certificate imported into a temporary keychain |
| macOS | `DSH_MAC_CERTIFICATE_PASSWORD` | PKCS#12 password |
| macOS | `DSH_APPLE_API_KEY_BASE64` | Base64 App Store Connect `.p8` key used for notarization |
| macOS | `DSH_APPLE_API_KEY_ID` | App Store Connect key identifier |
| macOS | `DSH_APPLE_API_ISSUER` | App Store Connect issuer identifier |
| Windows | `DSH_WINDOWS_CERTIFICATE_PFX_BASE64` | Base64 Authenticode PFX imported into the job workspace |
| Windows | `DSH_WINDOWS_CERTIFICATE_PASSWORD` | PFX password |
| Windows | `DSH_WINDOWS_EXPECTED_SIGNER_THUMBPRINT` | Exact SHA-1 certificate thumbprint required from every signed executable |
| Publication | `DSH_RELEASE_ADMIN_TOKEN` | Fine-grained token with repository Administration read access, used only to confirm immutable releases are enabled |

An organization signing service may replace the Windows PFX by setting `DSH_WINDOWS_SIGN_WITH_PARAMS` in an equivalent protected runner; the Forge config accepts exactly one signing mode.

## Publish an unsigned Preview without signing credentials

Use the unsigned Preview route only for invited testing while signing credentials are unavailable. Run the `Desktop` workflow manually from current `master` with `release=false`; pull-request builds remain development artifacts and cannot become a Preview. The run must finish the complete `darwin-arm64`, `darwin-x64`, and `win32-x64` unsigned matrix plus `preview-matrix-complete`.

Run `Community Desktop Unsigned Preview` manually with that Desktop `build_run_id`. The protected job accepts only a successful complete Preview matrix from the current `master` commit, checks out that exact SHA, and binds every candidate version and source commit to it. It validates the same matrix locally through `pnpm run desktop:community-preview`, confirms immutable Releases are enabled, and recursively resolves an existing lightweight or annotated Preview tag to the frozen commit. It creates a SHA-targeted draft with the complete asset set, downloads and compares every byte, then publishes an immutable prerelease under the unique `dsh-preview-v<version>-<commit>-run.<id>` tag. Repository write credentials are injected only into the GitHub API and Release steps, never dependency installation or local candidate validation.

The Preview Release contains only the two macOS DMGs, the Windows setup executable, and target-prefixed audit materials. It excludes macOS update ZIPs, Windows nupkg/`RELEASES`, Pages output, and all canary/stable metadata. Its embedded build identity is `unsigned-preview`; the application does not create a native updater, **Check for Updates…** reports that automatic updates are unavailable, and the Preview cannot serve as canary or stable promotion evidence.

macOS Preview applications are ad-hoc signed and not notarized; Windows Preview executables are unsigned. Before writing Preview acceptance, each macOS lane verifies the packaged application, mounts the final DMG, verifies the contained application with `codesign`, and requires an ad-hoc identity without an `Authority`. The Windows lane requires Authenticode `NotSigned` for both the packaged application executable and final Setup executable. Testers must inspect the manifest and `SHA256SUMS`, obtain the installer only from the fork Release, and explicitly approve the operating-system warning. Do not present these bytes as trusted end-user distribution, and replace them with the signed canary route before broad release.

## 1. Validate the frozen source

From a clean checkout with the locked pnpm version and a supported Node version, run the relevant source gates once:

```sh
pnpm install --frozen-lockfile
pnpm run test:desktop
pnpm run test:desktop:ipc-latency
pnpm run build:desktop
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run website:build
```

Confirm the source commit, release notes, application version, and `dsh-v<version>` tag candidate refer to one release. Product SemVer remains unchanged in manifests and update metadata, including a prerelease suffix. Forge maps it to a numeric three-part native application version and maps `github.run_number` to a monotonic three-part native build version; never reuse a lower sequence for a later build. The Community publication workflow creates that tag only after a successful frozen-source build run is selected manually.

## 2. Build the native matrix

Run the `Desktop` workflow manually with `release=true`. Its signed matrix uses native `macos-15` arm64, `macos-15-intel` x64, and `windows-2022` x64 runners. Each job installs from the frozen lockfile, rebuilds Electron native dependencies, runs Forge makers, verifies the packaged application, installs the final maker output, and re-derives release materials. After the full signed matrix succeeds, a separate protected matrix downloads and installs each signed artifact on the same three native targets, then runs the 60-minute streaming IPC endurance gate against every installation. It adds `release-acceptance.json` and uploads `darwin-arm64`, `darwin-x64`, and `win32-x64` candidate artifacts. The final matrix job requires both stages to pass and rejects a partial result.

Windows sets `DSH_DESKTOP_PACKAGE_DIAGNOSTICS=1` for Forge. Its JSONL records must include `forge-start`, `packager-copy-complete`, `asar-crawl-complete`, `asar-insert-complete`, and `archive-write-complete`, each with RSS, heap, external memory, file count, directory count, and aggregate bytes. If the job ends before a checkpoint or exhausts memory, retain the diagnostic evidence and stop the release; changing a heap limit is not a root-cause fix or release evidence.

For a local unsigned investigation on the matching platform and architecture:

```sh
pnpm run make:desktop
pnpm run verify:desktop-artifact
pnpm run test:desktop:asar-tamper
pnpm run test:desktop:packaged
pnpm run verify:desktop-materials
```

Unsigned output is test evidence only. Never promote it to a macOS or Windows release. `pnpm run test:desktop:installer` performs a real system install, uninstall, reinstall, second packaged startup smoke, and final uninstall; run it only on a disposable CI runner, never as a routine developer-workstation check.

## 3. Inspect the release family

Download all three protected candidate artifacts into an isolated review directory. Every platform directory must contain its installers/update packages plus `update-manifest-<platform>-<arch>.json`, `SHA256SUMS`, `desktop-sbom.cdx.json`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, `build-provenance.json`, and `release-acceptance.json`. macOS also carries `releases-darwin-<arch>.json`; Windows carries the Squirrel `RELEASES` family.

Verify that all build-provenance files name the frozen commit, source date, version, target platform, and target architecture. Recompute SHA-256 values from the downloaded bytes. Compare SBOM components and third-party notices with the staged production closure by rerunning `pnpm run verify:desktop-materials` in the originating job or an equivalent controlled reconstruction. The license gate must reject every external package that lacks dependency-provided text and is absent from the exact package-identity/version/content-hash audit table; a manifest SPDX expression is not a substitute for legal text.

On macOS, run `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate` against the final application/DMG; require the exact protected Team ID and Developer ID Application Authority. On Windows, require `Get-AuthenticodeSignature` to return `Valid` for the application executable and every distributed installer executable, require the protected signer thumbprint, and require a timestamp certificate. Forge signs only with SHA-256 and the RFC 3161 timestamp service.

## 4. Exercise install and update paths

Install each final artifact into a clean OS account with no checkout, global Node, pnpm, or prior Harness home. The automated installer smoke starts behind a blocking proxy with no API key, verifies secure Renderer startup, the real process tree, no TCP/UDP listener, separate Renderer and Utility crash recovery and circuit domains, forced Main termination and same-home recovery, quiescent exit, every `.node` load, and functional sharp, Koffi, PTY, and ripgrep probes. It uninstalls and verifies removal, reinstalls the same maker artifact, repeats the packaged startup smoke, and performs a final uninstall and cleanup. The shared lane gates a 1 KiB request/response unary IPC path at no more than 10 ms extra p95 round-trip cost. Each macOS lane mutates a comment byte in `lib/main.js` inside a disposable application copy, re-signs that copy ad hoc so OS signature failure cannot mask the result, and requires Electron to report an ASAR integrity failure before Renderer ready. In the disposable CI home, an acceptance-only trusted plugin supplies bounded synthetic persistence, lineage, and attachment sources while Main fixes the destination to an owner-only directory; the installed GUI invokes the normal save and cancel commands through Renderer, Preload, Main, and Utility, and the production Session export handler creates the ZIP. The release gate completes one cancelled and one successful archive of at least 1 GiB, validates the central-directory Session and media entries plus a streamed SHA-256, requires atomic cleanup, and caps Utility RSS growth at 128 MiB. The protected matrix also retains 20 raw cold-start samples from distinct homes and 20 warm-start/RSS samples from one shared home; shutdown p95 includes both sets. Process smoke does not replace the following user-flow checks.

Each 60-minute endurance job runs one final installed target against a loopback-only OpenAI-compatible provider owned by the test driver. Before endurance traffic, the installed Renderer sends 20 warmups and 100 measured 1 KiB unary requests through the Preload-transferred Electron `MessagePort`; the gate subtracts the same Utility handler's p95 time and enforces the 10 ms extra-round-trip limit. It then continuously pulls 4 KiB response chunks, cancels every fifth turn, and kills the supervised Renderer after every 100 requests so Main replaces the BrowserWindow and attaches a new real `MessagePort`. A temporary trusted Utility plugin records only aggregate bridge, registry, reader, export, dialog, and native-path counts; the final stable snapshot must equal the initial baseline. Each job records the installed Main/Utility/Renderer RSS once a minute, requires completed requests, cancellations, and at least two port generations, limits peak growth to 128 MiB, and limits the tail-window increase over the head window to 64 MiB. It closes the provider, removes the application, and deletes both disposable homes even on failure. Retained evidence contains sanitized metrics only, never stream content or a path.

For every target, record the platform and architecture, installer filename and SHA-256, application version and source commit, run time, operator and reviewer, disposable Harness home identifier, test provider or fixture, result for every row below, and links to sanitized screenshots, logs, or exported evidence in the protected release record. A skipped row requires an explicit platform N/A reason and Release approval; an unexplained skip blocks the candidate.

| Acceptance | Required observation in the final installed application |
|---|---|
| A-F01 | Complete first launch, normal relaunch, new Session, restored Session, streaming response, stop generation, and at least one tool call with a disposable test provider; quit and reopen before confirming the restored transcript. |
| A-F02 | Exercise approval, user question, background job, subagent, compaction, and automatic Session title scenarios; pair the installed UI result with the matching built-browser replay evidence and confirm the same durable event meaning. |
| A-F03 | Add a Workspace through the native directory chooser, cancel once, select once, and confirm that generated-file opening succeeds only for an existing target inside that canonical Workspace. |
| A-F04 | Save a disposable model setting and credential reference, confirm both hot-reload without relaunch, then scan Renderer-visible state, structured logs, and an exported diagnostic ZIP for the disposable secret value. |
| A-F05 | Verify history, search, projections, attachment upload, and generated-file actions against the existing Host data; load an HTTPS Markdown image through a capture endpoint and confirm no Referer, while HTTP and local relative images remain unloaded. |
| A-F06 | Cancel one Session ZIP export and complete another through the native save dialog; confirm no sibling temporary file remains and compare the successful ZIP entry names and digests with the Web export for the same Session. |
| A-F07 | Open one allowlisted repository or product-documentation HTTPS link in the system browser, then try a non-allowlisted HTTPS URL plus `file:`, credential-bearing, `javascript:`, and `data:` URLs; the application window stays on `app://localhost` and every disallowed target remains unopened. |
| A-F08 | Compare About, the exported diagnostic build record, installer provenance, and canary update state; version, source commit, platform, and architecture must identify the same candidate. |

Publish the candidate artifacts to an isolated canary feed at the compiled application origin and install the preceding signed version. Choosing **Check for Updates…** authorizes Electron to download a validated package; verify that the downloaded package applies on the next normal application start without another prompt. Repeat once with **Restart now to finish update** and verify quiescent shutdown before the immediate restart. Test equal/older version, wrong channel, wrong application/platform/architecture, wrong repository/origin, missing artifact, corrupted bytes, and invalid signature; every rejected case must leave the current installation runnable and must fail before a native download starts.

## 5. Publish immutably

Run the `Community Desktop Publish` workflow manually with the successful Desktop `build_run_id` and `channel=canary`. The protected job accepts only the successful `Desktop` workflow on current `master` whose `release-matrix-complete` job passed, checks out that exact SHA, downloads exactly the three candidate artifacts, and binds their version and source commit to the checkout before invoking `pnpm run desktop:community-publish`. The same validator can be inspected locally with `--input`, an empty `--output`, `--channel=canary`, `--expected-version`, and `--expected-source-commit`; it performs no network access or remote mutation.

The publication job first confirms the repository immutable-release setting. For a new tag it creates a draft targeted at the frozen SHA with the complete asset set, downloads every remote asset, and compares the complete hash set before publishing. It then requires the published Release to be immutable and verifies the Release plus each local asset with GitHub's integrity commands. An existing tag is accepted only when it is already public, immutable, targeted at the same SHA, and byte-identical; assets are never added to or overwritten on a published Release. The job overlays the generated channel files on `desktop-pages`, pushes that durable state, and deploys the complete branch through Pages Actions. macOS metadata points to its target-prefixed Release ZIP; the Windows `RELEASES` index uses absolute URLs for target-prefixed Release nupkg assets, so Pages contains metadata rather than versioned package bytes.

Observe at least 24 hours and one complete canary update cycle, then review installation failures, startup failures, Utility/Renderer crash loops, lease conflicts, update errors, and support categories. Stable is a separately built final SemVer on a later commit; the selected canary must be on the same version line and its source commit must be an ancestor of the stable source commit. Commit a structured acceptance JSON to the stable source, then run `Community Desktop Publish` with `channel=stable`, the published `canary_version`, and that tracked relative `acceptance_record` path. The validator copies the record into the immutable Release, writes its hash and reviewer into the release manifest, and publishes the final metadata to both stable and canary paths so installed canary clients can graduate. No job promotes canary automatically.

The acceptance JSON uses this exact required structure; target entries remain in the shown order and every evidence URL belongs to the fork repository:

```json
{
  "formatVersion": 1,
  "kind": "community-desktop-stable-promotion",
  "canaryVersion": "1.2.3-rc.1",
  "canarySourceCommit": "<40-hex-canary-sha>",
  "stableVersion": "1.2.3",
  "observedAt": "2026-08-23T00:00:00.000Z",
  "observationHours": 24,
  "reviewer": "release-owner",
  "targets": [
    { "target": "darwin-arm64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#darwin-arm64" },
    { "target": "darwin-x64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#darwin-x64" },
    { "target": "win32-x64", "cleanInstallPassed": true, "previousVersionToCanaryPassed": true, "canaryToStableCandidatePassed": true, "evidence": "https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/<id>#win32-x64" }
  ]
}
```

Preserve the immediately preceding signed installers and compatibility notes as the manual recovery path. After stable publication, download again from the public channel, verify signatures and hashes on every platform, and run a clean-account smoke.

## Stop or roll back a channel

If remote bytes, signatures, metadata, or startup behavior disagree, stop the channel before investigating. Remove the mutable channel pointer or redirect it to the last known-good signed version through the publication system's atomic operation; never overwrite a versioned artifact. Installed macOS/Windows clients normally recover by moving forward to a fixed higher version. Offer the preceding signed installer for manual recovery when the platform cannot downgrade safely, and state data-format compatibility explicitly.

A partial matrix never becomes stable. If only one platform is affected, keep the whole release stopped unless a release record explicitly approves platform-specific publication and its user impact.

## Support and security incidents

- **Utility or Renderer crash loop:** collect the stable error code, version/commit, OS/architecture, whether the app was packaged, update state, and a user-reviewed diagnostic ZIP. Do not request the entire `DSH_HOME`.
- **Lease conflict or stale endpoint:** identify all Harness products using the same canonical home and shut them down normally. Never instruct a user to remove a socket, pipe, or lock until ownership/type checks prove it belongs to the failed Host.
- **Disk full or export/update failure:** preserve the current install and session directory, free space, then retry. Check that sibling temporary files were removed; do not replace the destination with a partial archive.
- **Sensitive logging report:** stop sharing/upload of the affected diagnostic artifact, preserve access-controlled evidence, rotate any potentially exposed credential, and audit the field allowlist before resuming the channel.
- **Signing-key exposure:** stop the channel, revoke/rotate the affected certificate or key with the platform authority, invalidate protected-environment material, and rebuild every affected byte from the frozen source. Re-signing an existing installer in place is not allowed.

Review Electron support status and native ABI compatibility at every Electron major update. Rebuild and load every native dependency on all native targets, repeat fuse/ASAR/signature checks, and compare the shared GUI snapshots. Track macOS Developer ID/App Store Connect and Windows signing certificate expiration with enough lead time for rotation plus a complete canary cycle.

Delete temporary keychains and decoded certificate/key files when each CI job ends. Keep only protected build logs, verification summaries, and release artifacts under the approved retention policy; never retain signing inputs or a development user-data directory.
