# Agent Note: Bind the Preview tag after draft verification

Status: implemented

English | [中文](2026-08-25-desktop-preview-draft-tag.zh.md)

## Problem

Creating a GitHub draft Release with an explicit target commit records `targetCommitish` but does not materialize the corresponding Git tag reference. The Preview workflow verified draft asset bytes, then required the tag reference before publishing, so a complete draft stopped at the final publication step. The state resolver also accepted only a published immutable Release, which prevented a later run from validating and completing the matching draft.

## Decision

Preview state distinguishes an absent Release, a mutable draft, and a published immutable prerelease. A draft is recoverable only when its prerelease flag and target commit match the frozen source. Release notes are rendered for every run, and the workflow compares the complete downloaded asset set, title, and warning notes with the local plan. Only after these checks pass does it create a missing lightweight tag at the frozen commit, recursively resolve any existing tag object to that commit, and publish the draft. A published Release remains acceptable only with the exact tag target and immutable state.

## Verification

The workflow test requires separate draft and published outputs, draft reuse, explicit Git reference creation, exact source binding, and step ordering from draft byte verification through tag binding to immutable publication. The same test requires repository credentials only on steps that call GitHub APIs.

## Alternatives considered

**Assume draft creation also creates the tag.** GitHub exposes the target commit on a draft without creating `refs/tags/<name>`, so the assumption cannot prove the final tag identity.

**Create the tag before uploading the draft.** A failed upload would leave a public repository reference for an asset set that never passed byte verification.

**Publish first and inspect the generated tag afterward.** Immutable publication would make a wrong tag target or incomplete public record impossible to repair.

**Discard every existing draft.** A correctly targeted and byte-identical draft is safe to resume after all local and remote checks repeat. Reuse avoids another large asset upload without weakening validation.

## Consequences

A failed run can leave a private draft without making an unverified tag public. A later protected run can complete that draft only after reproducing and matching its complete publication plan. Tag creation occurs at the last reversible point before publication, and the published tag, target commit, assets, title, notes, prerelease state, and immutability remain independently verified.
