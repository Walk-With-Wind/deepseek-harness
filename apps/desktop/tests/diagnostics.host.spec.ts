import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { DEFAULT_DESKTOP_CONFIG } from '../src/shared/control-protocol.ts'
import {
  DESKTOP_DIAGNOSTIC_EXCLUSIONS,
  createDesktopDiagnosticArchive,
  writeDesktopDiagnosticBundle,
  type DesktopDiagnosticSnapshot,
} from '../src/main/diagnostics.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
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
    generation: 2,
    phase: 'READY',
    homeKey: 'b'.repeat(64),
    resource: { revision: '/Users/private/workspace?token=CANARY_SECRET', resourceCount: 17 },
    update: { phase: 'IDLE', supported: true, channel: 'stable', currentVersion: '1.2.3' },
  }
}

describe('Desktop diagnostics', () => {
  it('二次白名单过滤日志，并且不写入路径、正文或凭据 canary', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-desktop-diagnostics-'))
    const logs = join(root, 'logs')
    mkdirSync(logs)
    writeFileSync(join(logs, 'main.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-16T00:00:00.000Z', level: 'info', process: 'main', appVersion: '1.2.3',
        event: 'host ready', generation: 2, secret: 'CANARY_SECRET', path: '/Users/private/workspace',
      }),
      JSON.stringify({ process: 'main', body: '用户会话正文 CANARY_SECRET' }),
      '',
    ].join('\n'))
    const files = unzipSync(await createDesktopDiagnosticArchive(snapshot(), logs))
    const all = Object.values(files).map(value => strFromU8(value)).join('\n')
    const diagnostic = JSON.parse(strFromU8(files['diagnostic.json']!)) as {
      security: { signing: string; fuses: { status: string } }
    }
    expect(all).toContain('HOST_READY')
    expect(all).not.toContain('CANARY_SECRET')
    expect(all).not.toContain('/Users/private/workspace')
    expect(all).toContain(DESKTOP_DIAGNOSTIC_EXCLUSIONS[0])
    expect(diagnostic.security).toMatchObject({
      signing: 'not-runtime-verified',
      fuses: { status: 'configured-not-runtime-verified' },
    })
  })

  it('使用原子写入发布有效 ZIP 且不留下 sibling 临时文件', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-desktop-diagnostics-'))
    const logs = join(root, 'logs')
    mkdirSync(logs)
    const target = join(root, 'diagnostics.zip')
    await writeDesktopDiagnosticBundle(snapshot(), logs, target, new AbortController().signal)
    expect(Object.keys(unzipSync(readFileSync(target))).sort()).toEqual(['contents.json', 'diagnostic.json'])
    expect(readFileSync(target).byteLength).toBeGreaterThan(0)
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([])
  })
})
