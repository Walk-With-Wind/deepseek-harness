# Agent Note: Normalize desktop Release asset names before publication

Status: implemented

English | [中文](2026-08-25-desktop-release-asset-names.zh.md)

## Problem

Desktop installer filenames may contain spaces or other characters that GitHub normalizes during Release upload. Publication previously wrote the original prefixed filename into the manifest and `SHA256SUMS`, then downloaded a differently named asset from the draft. The bytes remained identical, but the immutable publication check correctly rejected the name mismatch.

## Decision

The publisher derives every Release asset name before manifest rendering, hashing, or upload. Each candidate-relative path segment retains ASCII letters, digits, period, underscore, and hyphen; every consecutive run of other characters becomes one hyphen. Directory separators become a double hyphen and the target prefix remains part of the name. Both signed and unsigned Preview plans reject any duplicate name after normalization.

## Verification

Publication fixtures use the actual spaced macOS DMG filename and require the generated plans to contain only conservative ASCII names. The Preview fixture also supplies two distinct candidate paths that normalize to the same name and requires plan construction to reject the collision.

## Alternatives considered

**Accept GitHub's renamed assets after upload.** The manifest and checksum file would then describe names that do not exist, and consumers could not treat the pre-upload plan as the publication authority.

**Compare only asset hashes.** Equal bytes do not repair broken manifest references and do not prove that the complete intended asset set exists under the expected names.

**Copy GitHub's current replacement behavior.** Depending on an undocumented punctuation rewrite would make local validation track a remote implementation detail. A conservative allowed character set keeps the publisher's output stable.

## Consequences

Release manifests, checksum files, download URLs, uploaded assets, and downloaded verification files use the same deterministic names. Original candidate paths remain authoritative for reading and verifying source bytes. A future artifact whose name collides after normalization must be renamed at its source or given an explicit distinct publication name.
