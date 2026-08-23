/** Opt-in preload that observes Electron Packager's vendored ASAR stages without changing output. */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Writable } from 'node:stream'
import {
  clearDesktopPackageDiagnosticExecArgv,
  collectDesktopPackageInventory,
  desktopPackageInventoryFromAsarMetadata,
  emitDesktopPackageDiagnostic,
  type DesktopPackageInventory,
} from './lib/desktop-package-diagnostics.ts'

interface AsarMetadataEntry {
  readonly type?: unknown
  readonly stat?: { readonly size?: unknown }
}

type CrawlFunction = (...args: unknown[]) => Promise<[
  readonly string[],
  Record<string, AsarMetadataEntry>,
]>
type WriteFilesystemFunction = (...args: unknown[]) => Promise<Writable>

if (process.env.DSH_DESKTOP_PACKAGE_DIAGNOSTICS === '1') {
  clearDesktopPackageDiagnosticExecArgv()
  const staging = requiredEnvironmentPath('DSH_DESKTOP_DIAGNOSTICS_STAGING')
  const forgeCli = realpathSync(requiredEnvironmentPath('DSH_DESKTOP_DIAGNOSTICS_FORGE_CLI'))
  const forgeRequire = createRequire(forgeCli)
  const coreManifest = forgeRequire.resolve('@electron-forge/core/package.json')
  const coreRequire = createRequire(coreManifest)
  const packagerManifest = coreRequire.resolve('@electron/packager/package.json')
  const packagerRequire = createRequire(packagerManifest)
  const crawlPath = packagerRequire.resolve('@electron/asar/lib/crawlfs.js')
  const diskPath = packagerRequire.resolve('@electron/asar/lib/disk.js')
  const crawlModule = packagerRequire(crawlPath) as { crawl: CrawlFunction }
  const diskModule = packagerRequire(diskPath) as { writeFilesystem: WriteFilesystemFunction }
  const originalCrawl = crawlModule.crawl
  const originalWriteFilesystem = diskModule.writeFilesystem
  let asarInventory: DesktopPackageInventory | undefined

  emitDesktopPackageDiagnostic('forge-start', await collectDesktopPackageInventory(staging))
  crawlModule.crawl = async (...args) => {
    const result = await originalCrawl(...args)
    asarInventory = desktopPackageInventoryFromAsarMetadata(result[1])
    emitDesktopPackageDiagnostic('asar-crawl-complete', asarInventory)
    return result
  }
  diskModule.writeFilesystem = async (...args) => {
    const inventory = requiredAsarInventory(asarInventory)
    emitDesktopPackageDiagnostic('asar-insert-complete', inventory)
    const stream = await originalWriteFilesystem(...args)
    if (stream.writableFinished) emitDesktopPackageDiagnostic('archive-write-complete', inventory)
    else stream.once('finish', () => { emitDesktopPackageDiagnostic('archive-write-complete', inventory) })
    return stream
  }
}

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`desktop-package-diagnostics: 缺少 ${name}`)
  return value
}

function requiredAsarInventory(
  inventory: DesktopPackageInventory | undefined,
): DesktopPackageInventory {
  if (inventory === undefined) {
    throw new Error('desktop-package-diagnostics: ASAR insert 发生在 crawl 诊断之前')
  }
  return inventory
}
