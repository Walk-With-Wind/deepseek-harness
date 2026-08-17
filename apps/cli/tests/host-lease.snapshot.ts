import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { acquireHostLease } from '@deepseek-ai/dsh-app-boot'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('host lease conflict snapshot', () => {
  it('host lease conflict', async () => {
    const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dsh-host-conflict-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home)
    const lease = await acquireHostLease({
      home,
      owner: { kind: 'desktop', version: 'fixture-owner' },
    })
    try {
      const result = await execa(process.execPath, [
        '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'conflict-fixture',
      ], {
        cwd: process.cwd(),
        env: { DSH_HOME: home },
        reject: false,
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      const normalized = result.stderr.replace(/pid \d+/, 'pid <PID>') + '\n'
      await expect(normalized).toMatchFileSnapshot(
        join(import.meta.dirname, 'snapshots/host-lease/conflict.expected.txt'),
      )
    } finally {
      await lease.release()
    }
  })
})
