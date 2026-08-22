import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetDesktopForgeOutput } from './desktop-forge-output.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('Desktop Forge output', () => {
  it('removes stale Forge products without deleting staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-forge-output-'))
    temporaryRoots.push(root)
    const staleArtifact = join(root, '.artifacts', 'desktop', 'out', 'make', 'stale.dmg')
    const stagedManifest = join(root, '.artifacts', 'desktop', 'staging', 'package.json')
    await mkdir(dirname(staleArtifact), { recursive: true })
    await mkdir(dirname(stagedManifest), { recursive: true })
    await writeFile(staleArtifact, 'stale')
    await writeFile(stagedManifest, '{}')

    await resetDesktopForgeOutput(root)

    expect(existsSync(staleArtifact)).toBe(false)
    expect(existsSync(stagedManifest)).toBe(true)
  })
})
