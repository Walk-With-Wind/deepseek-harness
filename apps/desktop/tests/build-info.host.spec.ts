import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDesktopBuildInfo } from '../src/main/build-info.ts'

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
    })
  })

  it('拒绝版本不一致和无效源 commit', () => {
    const directory = root = mkdtempSync(join(tmpdir(), 'dsh-desktop-build-info-'))
    const path = join(directory, 'build-info.json')
    const base = {
      version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z', electronVersion: '43.2.0',
      nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64',
    }
    writeFileSync(path, JSON.stringify({ ...base, version: '1.2.4' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/版本不一致/)
    writeFileSync(path, JSON.stringify({ ...base, sourceCommit: '../workspace' }))
    expect(() => readDesktopBuildInfo(directory, '1.2.3')).toThrow(/sourceCommit/)
  })
})
