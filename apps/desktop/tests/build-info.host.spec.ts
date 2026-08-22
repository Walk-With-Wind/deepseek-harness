import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDesktopBuildInfo } from '../src/main/build-info.ts'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_PUBLISHER,
  DESKTOP_REPOSITORY,
} from '../src/shared/release-policy.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('Desktop build info', () => {
  it('开发目录缺少构建身份时使用明确占位值', () => {
    const directory = root = mkdtempSync(join(tmpdir(), 'dsh-desktop-build-info-'))
    expect(readDesktopBuildInfo(directory, '1.2.3')).toMatchObject({
      version: '1.2.3', sourceCommit: 'development',
      releaseMode: 'development',
      distribution: 'community',
      repository: DESKTOP_REPOSITORY,
      applicationId: DESKTOP_APPLICATION_ID,
      publisher: DESKTOP_PUBLISHER,
    })
  })

  it('拒绝版本不一致和无效源 commit', () => {
    const directory = root = mkdtempSync(join(tmpdir(), 'dsh-desktop-build-info-'))
    const path = join(directory, 'build-info.json')
    const base = {
      version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z', electronVersion: '43.2.0',
      nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64',
      releaseMode: 'signed',
      distribution: 'community', repository: DESKTOP_REPOSITORY,
      applicationId: DESKTOP_APPLICATION_ID, publisher: DESKTOP_PUBLISHER,
    }
    writeFileSync(path, JSON.stringify({ ...base, version: '1.2.4' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/版本不一致/)
    writeFileSync(path, JSON.stringify({ ...base, sourceCommit: '../workspace' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/sourceCommit/)
    writeFileSync(path, JSON.stringify({ ...base, applicationId: 'ai.deepseek.harness' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/发行身份/)
    writeFileSync(path, JSON.stringify({ ...base, releaseMode: 'unsigned' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/releaseMode/)
    const { releaseMode: _releaseMode, ...withoutReleaseMode } = base
    writeFileSync(path, JSON.stringify(withoutReleaseMode))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/releaseMode/)
  })

  it('允许原生三段版本承载同一产品预发布版本', () => {
    const directory = root = mkdtempSync(join(tmpdir(), 'dsh-desktop-build-info-'))
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({
      version: '1.2.3-rc.4', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z',
      electronVersion: '43.2.0', nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64',
      releaseMode: 'unsigned-preview',
      distribution: 'community', repository: DESKTOP_REPOSITORY,
      applicationId: DESKTOP_APPLICATION_ID, publisher: DESKTOP_PUBLISHER,
    }))
    expect(readDesktopBuildInfo(directory, '1.2.3')).toMatchObject({
      version: '1.2.3-rc.4', releaseMode: 'unsigned-preview',
    })
    expect(readDesktopBuildInfo(directory, '1.2.3-rc.4')).toMatchObject({
      version: '1.2.3-rc.4', releaseMode: 'unsigned-preview',
    })
  })
})
