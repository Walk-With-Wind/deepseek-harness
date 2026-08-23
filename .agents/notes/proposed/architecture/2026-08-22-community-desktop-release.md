# Agent Note: Community Desktop distribution and protected publication

Status: proposed

English | [中文](2026-08-22-community-desktop-release.zh.md)

## Problem

The shared Electron implementation has an upstream-compatible product surface, but a personal fork cannot publish it under the official application's native identity, data directory, repository, or update authority. Reusing those values would make independently signed bytes appear official, let two distributions write the same default home, and permit one repository's mutable metadata to select another repository's artifacts. Publishing one successful target before the remaining native targets pass would also create a release that cannot satisfy its stated support matrix.

The [Electron Desktop decision](../../implemented/architecture/2026-08-16-electron-desktop-process-security-and-release.md) remains the authority for process roles, IPC security, lifecycle, packaging, and native acceptance. This proposal specializes its release identity and human publication boundary for one community-maintained fork; it does not replace those runtime decisions. The [platform-scope decision](../../implemented/simplification/2026-08-18-desktop-macos-windows-release-scope.md) continues to own the three supported targets.

## Proposal

Distribute the fork as **DeepSeek Harness Community Build**, published by `Walk-With-Wind`, with application id `io.github.walk-with-wind.deepseek-harness`, Squirrel package id `DeepSeekHarnessCommunity`, and executable `deepseek-harness-community`. User-facing behavior and shared GUI composition continue to follow upstream. Build information, update manifests, provenance, SBOM properties, notices, About UI, native metadata, and recovery UI carry the Community identity and `https://github.com/Walk-With-Wind/deepseek-harness` repository.

The default Desktop home is `~/.deepseek-harness-community`. A nonblank explicit `DSH_HOME` is the only opt-in to share data with a fork CLI or Web process; the canonical-home Host lease still permits one writer. This prevents an independently installed Community Build from silently opening or changing an upstream installation's default data.

GitHub Releases under the fork hold immutable versioned bytes using the upstream `dsh-v<version>` tag family. GitHub Pages under `https://walk-with-wind.github.io/deepseek-harness/desktop-updates` holds canary and stable metadata. macOS feed entries and Windows Squirrel package URLs resolve only to the fork Release. Main parses every update URL and rejects a different protocol, origin, owner, repository, tag, asset segment, credential, query, or fragment.

The `Desktop` workflow retains read-only repository permission and produces three signed candidates: `darwin-arm64`, `darwin-x64`, and `win32-x64`. Each candidate includes its installer/update bytes, hashes, SBOM, notices, license, provenance, and a signed-build/install/endurance acceptance record. Product SemVer remains in product metadata while the CI run number supplies a numeric, monotonic native build version. Release verification pins the macOS Team ID and Authority plus the Windows signer thumbprint and timestamp; signing credentials are imported only after dependency installation and compilation and are removed immediately after signing and notarization.

A separate manually dispatched workflow in the `desktop-community-release` environment has Release and Pages permissions. It accepts only the successful complete-matrix `Desktop` run at current `master`, binds candidate version and source commit to that checkout, and requires repository immutable releases. It creates a SHA-targeted draft with the complete asset set, compares downloaded bytes, publishes and verifies immutability, then persists the overlaid canary/stable Pages tree on the protected `desktop-pages` branch before deployment. An existing Release is accepted only when it is already immutable, targets the same SHA, and is byte-identical.

An unsigned Preview is a separate manual path for invited testing before signing credentials exist. A manual `Desktop` run records `releaseMode: unsigned-preview` and must complete all three native installer cycles before `preview-matrix-complete` passes. Before writing acceptance, native tools verify that both packaged applications and final installers have the expected ad-hoc or `NotSigned` state. The Preview publisher accepts only that job from current `master`, retains the DMGs, Windows setup executable, and audit material, recursively resolves its build-run-specific tag to the frozen source commit, then publishes an immutable prerelease. Repository write credentials are absent during dependency installation and local candidate validation. The workflow has no Pages permission, emits no update ZIP, nupkg, `RELEASES`, or channel metadata, and cannot provide canary or stable evidence. Main does not construct the native updater for this build mode, and the menu states that automatic updates are unavailable.

Canary is the first permitted channel. Stable is a later final-version commit whose selected canary belongs to the same version line and is an ancestor. A tracked structured acceptance record names the reviewer, at least 24 observation hours, and the clean-install, preceding-version-to-canary, and canary-to-stable-candidate result for all three targets; its hash is preserved in the stable Release manifest. Stable metadata is written to both stable and canary paths so installed canary clients can graduate. No workflow automatically promotes canary. A rollback moves or removes Pages metadata and never modifies a versioned Release asset.

The [scoped Forge bin-cleanup patch](../../implemented/bug-fix/2026-08-23-forge-windows-bin-glob-scope.md) prevents Windows from interpreting the repository as the copied application's search root. Windows packaging remains a native release gate until a diagnostic run with that patch reaches all five package checkpoints and the final signed candidate passes. Opt-in JSONL diagnostics report process memory and aggregate file metadata at Forge start, copy completion, ASAR crawl completion, insert completion, and archive write completion; they do not report paths, contents, environment values, or credentials. Heap-limit changes alone do not satisfy this gate.

## Alternatives considered

**Publish under the official application identity.** Matching the official name, bundle id, executable, default home, and updater would make fork signatures and support ownership ambiguous and could let separately released applications contend over or mutate one default data set.

**Use a fork repository but keep the official update origin.** An origin outside the publisher's control cannot provide an auditable availability or rollback promise. It also separates the signed artifact owner from the metadata authority that selects those bytes.

**Publish each native target as soon as it passes.** Partial publication exposes an inconsistent support matrix and makes users discover release completeness from missing assets. The complete-matrix manifest keeps one version and source commit atomic across platforms.

**Promote stable automatically after a timer or green CI.** CI cannot observe support reports, the previous-version upgrade path, or product acceptance. Stable remains an explicit release-owner action backed by a canary record.

**Publish unsigned artifacts through the canary channel.** A channel endpoint would let unsigned bytes participate in automatic installation and blur their trust status. A separate prerelease keeps manual testing available without weakening signed update policy.

**Treat a larger Node heap as the Windows fix.** The observed failure already exhausted a raised heap while staging tens of thousands of files. Stage evidence must locate retained memory before a minimal root-cause change can be accepted.

## Acceptance criteria

- The three native targets produce signed candidates from one commit and version; every candidate passes signature, install/uninstall/reinstall, 1 GiB export, and 60-minute installed endurance gates.
- Windows reaches all five package diagnostic checkpoints without OOM, and any implementation fix is backed by a focused failing test and native evidence.
- The complete-matrix validator rejects missing targets, modified bytes, identity or source drift, incomplete acceptance, an incompatible existing Release, and stable without ancestor canary plus structured promotion evidence.
- The unsigned Preview validator accepts only three `unsigned-preview` candidates from the selected source whose packaged applications and final installers have verified ad-hoc or `NotSigned` states, publishes only manually installed packages and audit material under a tag resolved to that source, leaves Pages unchanged, and the packaged application cannot check or apply native updates.
- A canary publication uploads immutable `dsh-v<version>` assets to the fork, verifies downloaded hashes, deploys the complete persistent Pages tree, and completes both next-launch and immediate-restart updates from the preceding signed version on all three targets.
- Security, Release, Runtime/Persistence, Client/UX, Architecture, and Product reviewers approve the protected record before a separate manual stable publication.

## Risks

The fork publisher owns certificate custody, Pages availability, update metadata, incident response, and user support even while product behavior follows upstream. Upstream version movement can force a rebase before a release candidate is complete. Separate default storage reduces accidental interference but means existing upstream sessions do not appear until a user explicitly selects their shared home. Unsigned Preview installation requires users to bypass platform warnings and therefore remains unsuitable for broad distribution. The complete native matrix and endurance gates increase release time, while the manual stable boundary can delay promotion after code and CI are green.
