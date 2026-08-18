# Release the Desktop application

English | [中文](releasing-desktop.zh.md)

This maintainer runbook builds and verifies the Desktop release matrix. It deliberately stops before any remote artifact or update-channel publication: protected native CI proves bytes and signatures, while a release owner separately approves immutable upload and stable-channel movement.

## Prerequisites

Use one frozen commit whose root and `apps/desktop/package.json` versions agree. The protected GitHub environment is named `desktop-release`; require reviewer approval and restrict it to release maintainers. Keep signing material in that environment only, never in repository variables, caches, artifacts, logs, or developer `.env` files.

Configure these protected secrets:

| Platform | Secret | Purpose |
|---|---|---|
| macOS | `DSH_MAC_SIGN_IDENTITY` | Developer ID Application identity selected by codesign |
| macOS | `DSH_MAC_CERTIFICATE_P12_BASE64` | Base64 PKCS#12 certificate imported into a temporary keychain |
| macOS | `DSH_MAC_CERTIFICATE_PASSWORD` | PKCS#12 password |
| macOS | `DSH_APPLE_API_KEY_BASE64` | Base64 App Store Connect `.p8` key used for notarization |
| macOS | `DSH_APPLE_API_KEY_ID` | App Store Connect key identifier |
| macOS | `DSH_APPLE_API_ISSUER` | App Store Connect issuer identifier |
| Windows | `DSH_WINDOWS_CERTIFICATE_PFX_BASE64` | Base64 Authenticode PFX imported into the job workspace |
| Windows | `DSH_WINDOWS_CERTIFICATE_PASSWORD` | PFX password |

An organization signing service may replace the Windows PFX by setting `DSH_WINDOWS_SIGN_WITH_PARAMS` in an equivalent protected runner; the Forge config accepts exactly one signing mode.

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

Confirm the source commit, release notes, application version, and `dsh-v<version>` tag candidate refer to one release. Do not create the tag until the normal repository release policy authorizes it.

## 2. Build the native matrix

Run the `Desktop` workflow manually with `release=true`. Its signed matrix uses native `macos-15` arm64, `macos-15-intel` x64, and `windows-2022` x64 runners. Each job installs from the frozen lockfile, rebuilds Electron native dependencies, runs Forge makers, verifies the packaged application, installs the final maker output, and re-derives release materials. After the full signed matrix succeeds, a separate protected matrix downloads and installs each signed artifact on the same three native targets, then runs the 60-minute streaming IPC endurance gate against every installation. The final matrix job requires both stages to pass and rejects a partial result.

The maker matrix supplies a 5,120 MiB Node old-space budget to every target. The resolved `@electron/asar` 3.4.1 package carries the repository patch that uses bounded small-file hashing, batched archive writes, iterative block hashing, and set-based path scans; this keeps the complete Windows production closure within the same budget as macOS. Keep unsigned and signed rows identical, keep the patch and lockfile hash synchronized, and treat an out-of-memory exit as a candidate blocker instead of permitting a smaller unverified closure.

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

Download all three protected artifacts into an isolated review directory. Every platform directory must contain its installers/update packages plus `update-manifest-<platform>-<arch>.json`, `SHA256SUMS`, `desktop-sbom.cdx.json`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, and `build-provenance.json`. macOS also carries `releases-darwin-<arch>.json`; Windows carries the Squirrel `RELEASES` family.

Verify that all build-provenance files name the frozen commit, source date, version, target platform, and target architecture. Recompute SHA-256 values from the downloaded bytes. Compare SBOM components and third-party notices with the staged production closure by rerunning `pnpm run verify:desktop-materials` in the originating job or an equivalent controlled reconstruction. The license gate must reject every external package that lacks dependency-provided text and is absent from the exact package-identity/version/content-hash audit table; a manifest SPDX expression is not a substitute for legal text.

On macOS, run `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate` against the final application/DMG. On Windows, require `Get-AuthenticodeSignature` to return `Valid` for the application executable and every distributed installer executable, including a timestamp and the approved subject.

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

Publish the candidate artifacts to an isolated canary feed at the compiled application origin, install the previous canary version, and verify discovery, download, explicit install approval, quiescent shutdown, restart, and build identity. Test equal/older version, wrong channel, wrong application/platform/architecture, missing artifact, corrupted bytes, and invalid signature; each case must leave the current installation runnable.

## 5. Publish immutably

Upload versioned artifacts first. Reject any destination where the same versioned name already exists with different bytes; do not overwrite or repair a release in place. Download the remote objects again and compare hashes before exposing metadata.

Publish canary update metadata only after all required platform bytes are present and verified. Observe at least one complete update cycle and review installation failures, startup failures, Utility/Renderer crash loops, lease conflicts, update errors, and support categories. The application and CI do not promote canary to stable automatically.

A release owner moves the stable channel only after Security, Release, Runtime/Persistence, Client/UX, Architecture, and Product evidence has no blocking gap. Preserve the immediately preceding signed installers and their compatibility notes as the manual recovery path. After stable movement, download again from the public channel, verify signatures and hashes on every platform, and run a clean-account smoke.

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
