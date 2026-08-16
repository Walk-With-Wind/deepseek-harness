import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DESKTOP_CONFIG } from '../src/shared/control-protocol.ts'
import type { DesktopDiagnosticSnapshot } from '../src/main/diagnostics.ts'

const loadFflate = vi.hoisted(() => vi.fn())

vi.mock('fflate', async (importOriginal) => {
  loadFflate()
  return await importOriginal()
})

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  vi.resetModules()
  loadFflate.mockClear()
})

function snapshot(): DesktopDiagnosticSnapshot {
  return {
    createdAt: '2026-08-16T00:00:00.000Z',
    build: {
      version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z', electronVersion: '43.2.0',
      nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64',
    },
    packaged: true,
    config: DEFAULT_DESKTOP_CONFIG,
    generation: 1,
    phase: 'READY',
    homeKey: 'b'.repeat(64),
    resource: { resourceCount: 1 },
    update: { phase: 'IDLE', supported: true, channel: 'stable', currentVersion: '1.2.3' },
  }
}

describe('Desktop diagnostics lazy compression', () => {
  it('只在用户实际生成诊断包时加载压缩实现', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-desktop-diagnostics-lazy-'))
    const logs = join(root, 'logs')
    mkdirSync(logs)

    const diagnostics = await import('../src/main/diagnostics.ts')
    expect(loadFflate).not.toHaveBeenCalled()

    await diagnostics.createDesktopDiagnosticArchive(snapshot(), logs)
    expect(loadFflate).toHaveBeenCalledTimes(1)
  })
})
