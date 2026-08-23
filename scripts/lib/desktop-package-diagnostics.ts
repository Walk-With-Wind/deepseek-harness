/** Opt-in Desktop packaging telemetry for native Forge OOM investigation. */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable checkpoints spanning Forge copy and the ASAR pipeline. */
export type DesktopPackageDiagnosticPhase =
  | 'forge-start'
  | 'packager-copy-complete'
  | 'asar-crawl-complete'
  | 'asar-insert-complete'
  | 'archive-write-complete'

/** Aggregate filesystem metadata; no path, content, or environment data is retained. */
export interface DesktopPackageInventory {
  readonly fileCount: number
  readonly directoryCount: number
  readonly totalBytes: number
}

/** One JSONL record emitted by the opt-in package diagnostic. */
export interface DesktopPackageDiagnostic extends DesktopPackageInventory {
  readonly type: 'desktop-package-diagnostic'
  readonly phase: DesktopPackageDiagnosticPhase
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly externalBytes: number
}

/**
 * Clear the diagnostic-only Node arguments before Forge forks native rebuild workers.
 * @param execArgv - Mutable argument list owned by the diagnostic Forge process.
 */
export function clearDesktopPackageDiagnosticExecArgv(
  execArgv: string[] = process.execArgv,
): void {
  execArgv.length = 0
}

/**
 * Recursively aggregate file metadata without reading names into the result or opening contents.
 * @param root - Directory whose descendants are being packaged.
 * @returns File count, directory count excluding the root, and regular-file bytes.
 */
export async function collectDesktopPackageInventory(root: string): Promise<DesktopPackageInventory> {
  const inventory = { fileCount: 0, directoryCount: 0, totalBytes: 0 }
  await visit(root, false)
  return inventory

  async function visit(path: string, countDirectory: boolean): Promise<void> {
    const metadata = await stat(path)
    if (!metadata.isDirectory()) {
      inventory.fileCount += 1
      inventory.totalBytes += metadata.size
      return
    }
    if (countDirectory) inventory.directoryCount += 1
    const entries = await readdir(path)
    for (const entry of entries) await visit(join(path, entry), true)
  }
}

/**
 * Aggregate the metadata already retained by ASAR crawl without another filesystem traversal.
 * @param metadata - Internal ASAR crawl result reduced to type and stat size fields.
 * @returns File and directory totals for the ASAR input.
 */
export function desktopPackageInventoryFromAsarMetadata(
  metadata: Record<string, { readonly type?: unknown; readonly stat?: { readonly size?: unknown } }>,
): DesktopPackageInventory {
  let fileCount = 0
  let directoryCount = 0
  let totalBytes = 0
  for (const entry of Object.values(metadata)) {
    if (entry.type === 'directory') {
      directoryCount += 1
      continue
    }
    fileCount += 1
    if (entry.type === 'file' && typeof entry.stat?.size === 'number') totalBytes += entry.stat.size
  }
  return { fileCount, directoryCount, totalBytes }
}

/**
 * Combine one checkpoint's process memory and aggregate filesystem statistics.
 * @param phase - Stable package pipeline checkpoint.
 * @param inventory - Aggregate input inventory for this checkpoint.
 * @param memory - Node process memory counters.
 * @returns JSON-serializable diagnostic with no paths, contents, or environment values.
 */
export function formatDesktopPackageDiagnostic(
  phase: DesktopPackageDiagnosticPhase,
  inventory: DesktopPackageInventory,
  memory: NodeJS.MemoryUsage = process.memoryUsage(),
): DesktopPackageDiagnostic {
  return {
    type: 'desktop-package-diagnostic',
    phase,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    ...inventory,
  }
}

/**
 * Emit one compact JSONL record only when the explicit diagnostic switch is enabled.
 * @param phase - Stable package pipeline checkpoint.
 * @param inventory - Aggregate filesystem statistics.
 * @param environment - Environment used only to read the boolean opt-in switch.
 */
export function emitDesktopPackageDiagnostic(
  phase: DesktopPackageDiagnosticPhase,
  inventory: DesktopPackageInventory,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.DSH_DESKTOP_PACKAGE_DIAGNOSTICS !== '1') return
  console.log(JSON.stringify(formatDesktopPackageDiagnostic(phase, inventory)))
}

/**
 * Collect aggregate path statistics and emit one opt-in record.
 * @param phase - Stable package pipeline checkpoint.
 * @param root - Directory whose aggregate metadata belongs to the checkpoint.
 */
export async function emitDesktopPackageDiagnosticForPath(
  phase: DesktopPackageDiagnosticPhase,
  root: string,
): Promise<void> {
  if (process.env.DSH_DESKTOP_PACKAGE_DIAGNOSTICS !== '1') return
  emitDesktopPackageDiagnostic(phase, await collectDesktopPackageInventory(root))
}
