# Agent Note: Resolve Windows release indexes from verified candidate paths

Status: implemented

English | [中文](2026-08-25-desktop-windows-candidate-relative-paths.zh.md)

## Problem

Electron Forge writes the Windows Squirrel family below a maker-specific directory such as `squirrel.windows/x64/`. Desktop update metadata and provenance preserve those artifact-root-relative paths. Candidate validation checked the nested `RELEASES` bytes and hashes through the manifest, then separately tried to read `RELEASES` from the candidate root. A complete native matrix therefore passed build acceptance but failed before an unsigned Preview draft could be created.

## Decision

The candidate manifest is the authority for maker artifact locations. After path validation, role validation, byte validation, and provenance validation, the publication reader locates the single `update-index` artifact by role and reads its verified relative path. Preview and signed publication use the same candidate reader, so both accept the actual Forge directory layout without searching the filesystem or flattening artifacts.

## Verification

Preview and signed publication fixtures preserve the Windows Squirrel directory hierarchy. Their plans must validate the nested installer, nupkg, and `RELEASES`, exclude update files from unsigned Preview assets, and render signed Windows update metadata against the target-prefixed nested nupkg asset name.

## Alternatives considered

**Flatten Windows artifacts during upload or download.** Flattening would change names outside the signed and hashed candidate evidence, and duplicate a layout transformation in workflows instead of using the manifest that already records every path.

**Search recursively for a file named `RELEASES`.** A filename search would introduce another source of artifact identity and could select an unrecorded file. The manifest role already proves uniqueness and binds the path to its byte evidence.

**Special-case only the unsigned Preview workflow.** The same root-path assumption existed in the shared signed publication reader. Fixing the shared reader keeps both publication routes aligned with the validated candidate format.

## Consequences

Maker directory changes remain acceptable when the generated manifest, hashes, provenance, and files agree. Publication still rejects missing, duplicate, unsafe, or byte-mismatched update indexes. Release asset names retain the candidate-relative directory segments, so generated Windows `RELEASES` URLs continue to point to the exact immutable nupkg asset.
