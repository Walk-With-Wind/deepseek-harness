import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateDesktopUpdateMetadata,
  verifyDesktopUpdateMetadata,
} from './desktop-update-metadata.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function directory(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-desktop-update-metadata-'))
  return root
}

describe('Desktop update metadata', () => {
  it('macOS 元数据固定应用身份、canary 通道、字节哈希和 HTTPS 发行源', async () => {
    const artifactRoot = directory()
    writeFileSync(join(artifactRoot, 'DeepSeek-Harness.zip'), 'zip')
    writeFileSync(join(artifactRoot, 'DeepSeek-Harness.dmg'), 'dmg')
    await generateDesktopUpdateMetadata({
      artifactRoot, platform: 'darwin', arch: 'arm64', version: '1.2.3-rc.1', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
    })
    const manifest = JSON.parse(readFileSync(join(artifactRoot, 'update-manifest-darwin-arm64.json'), 'utf8'))
    expect(manifest).toMatchObject({
      distribution: 'community',
      repository: 'https://github.com/Walk-With-Wind/deepseek-harness',
      publisher: 'Walk-With-Wind',
      applicationId: 'io.github.walk-with-wind.deepseek-harness',
      channel: 'canary', platform: 'darwin', arch: 'arm64',
    })
    const feed = JSON.parse(readFileSync(join(artifactRoot, 'releases-darwin-arm64.json'), 'utf8'))
    expect(feed.url).toBe(
      'https://github.com/Walk-With-Wind/deepseek-harness/releases/download/dsh-v1.2.3-rc.1/DeepSeek-Harness.zip',
    )
    await expect(verifyDesktopUpdateMetadata({
      artifactRoot, platform: 'darwin', arch: 'arm64', version: '1.2.3-rc.1', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
    })).resolves.toBeUndefined()
  })

  it('拒绝不完整的平台 artifact 集合', async () => {
    const artifactRoot = directory()
    writeFileSync(join(artifactRoot, 'DeepSeek-Harness-Community-Setup.exe'), 'setup')
    await expect(generateDesktopUpdateMetadata({
      artifactRoot, platform: 'win32', arch: 'x64', version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
    })).rejects.toThrow(/nupkg/)
  })

  it('发现 maker 字节被替换', async () => {
    const artifactRoot = directory()
    mkdirSync(join(artifactRoot, 'squirrel'))
    writeFileSync(join(artifactRoot, 'squirrel', 'DeepSeek-Harness-Community-Setup.exe'), 'setup')
    writeFileSync(join(artifactRoot, 'squirrel', 'DeepSeek-Harness.nupkg'), 'nupkg')
    writeFileSync(join(artifactRoot, 'squirrel', 'RELEASES'), 'releases')
    const options = {
      artifactRoot, platform: 'win32' as const, arch: 'x64' as const,
      version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
    }
    await generateDesktopUpdateMetadata(options)
    writeFileSync(join(artifactRoot, 'squirrel', 'DeepSeek-Harness-Community-Setup.exe'), 'tampered')
    await expect(verifyDesktopUpdateMetadata(options)).rejects.toThrow(/不一致/)
  })

  it('拒绝为非发行平台生成安装包元数据', async () => {
    const artifactRoot = directory()
    mkdirSync(join(artifactRoot, 'deb'))
    mkdirSync(join(artifactRoot, 'rpm'))
    writeFileSync(join(artifactRoot, 'deb', 'harness.deb'), 'deb')
    writeFileSync(join(artifactRoot, 'rpm', 'harness.rpm'), 'rpm')
    await expect(generateDesktopUpdateMetadata({
      artifactRoot, platform: 'linux' as never, arch: 'x64', version: '1.2.3',
      sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
    })).rejects.toThrow(/不支持/)
  })
})
