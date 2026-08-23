/** Desktop package OOM 诊断格式只暴露阶段、内存和文件统计。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectDesktopPackageInventory,
  desktopPackageInventoryFromAsarMetadata,
  emitDesktopPackageDiagnostic,
  formatDesktopPackageDiagnostic,
  type DesktopPackageDiagnosticPhase,
} from './lib/desktop-package-diagnostics.ts'

const fixtures: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Desktop package diagnostics', () => {
  it('为每个固定阶段输出内存、文件、目录和字节字段', () => {
    const phases: DesktopPackageDiagnosticPhase[] = [
      'forge-start',
      'packager-copy-complete',
      'asar-crawl-complete',
      'asar-insert-complete',
      'archive-write-complete',
    ]
    for (const phase of phases) {
      expect(formatDesktopPackageDiagnostic(
        phase,
        { fileCount: 3, directoryCount: 2, totalBytes: 7 },
        { rss: 11, heapUsed: 12, heapTotal: 13, external: 14, arrayBuffers: 15 },
      )).toEqual({
        type: 'desktop-package-diagnostic',
        phase,
        rssBytes: 11,
        heapUsedBytes: 12,
        heapTotalBytes: 13,
        externalBytes: 14,
        fileCount: 3,
        directoryCount: 2,
        totalBytes: 7,
      })
    }
  })

  it('只统计元数据，不读取文件内容或环境变量值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-diagnostics-'))
    fixtures.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'a.txt'), 'abc')
    await writeFile(join(root, 'nested', 'b.txt'), '12345')
    expect(await collectDesktopPackageInventory(root)).toEqual({
      fileCount: 2,
      directoryCount: 1,
      totalBytes: 8,
    })
    expect(desktopPackageInventoryFromAsarMetadata({
      '/a': { type: 'file', stat: { size: 3 } },
      '/nested': { type: 'directory', stat: { size: 0 } },
      '/nested/b': { type: 'file', stat: { size: 5 } },
    })).toEqual({ fileCount: 2, directoryCount: 1, totalBytes: 8 })
  })

  it('默认静默且只在显式诊断开关下写 JSONL', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const inventory = { fileCount: 1, directoryCount: 0, totalBytes: 2 }
    emitDesktopPackageDiagnostic('forge-start', inventory, {})
    expect(log).not.toHaveBeenCalled()
    emitDesktopPackageDiagnostic('forge-start', inventory, {
      DSH_DESKTOP_PACKAGE_DIAGNOSTICS: '1',
      SECRET_VALUE: '不得输出',
    })
    expect(log).toHaveBeenCalledOnce()
    const line: unknown = log.mock.calls[0]?.[0]
    expect(line).not.toContain('不得输出')
    if (typeof line !== 'string') throw new Error('expected a JSONL diagnostic line')
    const record: unknown = JSON.parse(line)
    expect(record).toBeDefined()
  })

  it('在 Forge 与 ASAR 的真实阶段接入诊断，并只对 Windows CI 开启', async () => {
    const root = join(import.meta.dirname, '..')
    const [desktop, forge, preload, workflow] = await Promise.all([
      readFile(join(root, 'scripts/desktop.ts'), 'utf8'),
      readFile(join(root, 'apps/desktop/forge.config.ts'), 'utf8'),
      readFile(join(root, 'scripts/desktop-package-diagnostics-preload.ts'), 'utf8'),
      readFile(join(root, '.github/workflows/desktop.yml'), 'utf8'),
    ])
    expect(desktop).toContain('desktop-package-diagnostics-preload.ts')
    expect(desktop).toContain('DSH_DESKTOP_PACKAGE_DIAGNOSTICS')
    expect(desktop).toContain('const diagnosticNodeArgs = diagnosticsEnabled')
    expect(desktop).toContain('...diagnosticNodeArgs, forgeCli, command, staging')
    expect(desktop).not.toContain('NODE_OPTIONS: diagnosticNodeOptions')
    expect(forge).toContain("'packager-copy-complete'")
    expect(preload).toContain("'forge-start'")
    expect(preload).toContain("'asar-crawl-complete'")
    expect(preload).toContain("'asar-insert-complete'")
    expect(preload).toContain("'archive-write-complete'")
    expect(preload).toContain('writeFilesystem')
    expect(workflow).toContain("DSH_DESKTOP_PACKAGE_DIAGNOSTICS: ${{ matrix.platform == 'win32' && '1' || '0' }}")
  })

  it('Forge 清理 .bin 时把 Windows glob 限定在已复制应用目录', async () => {
    const root = join(import.meta.dirname, '..')
    const appRequire = createRequire(join(root, 'apps/desktop/package.json'))
    const forgeCli = appRequire.resolve('@electron-forge/cli/dist/electron-forge.js')
    const forgeRequire = createRequire(forgeCli)
    const coreManifest = forgeRequire.resolve('@electron-forge/core/package.json')
    const forgePackage = await readFile(join(dirname(coreManifest), 'dist/api/package.js'), 'utf8')
    expect(forgePackage).toMatch(
      /fast_glob_1\.default\)\('\*\*\/\.bin\/\*\*\/\*',\s*\{\s*cwd: buildPath,\s*absolute: true/,
    )
    expect(forgePackage).not.toContain("node_path_1.default.join(buildPath, '**/.bin/**/*')")
  })
})
