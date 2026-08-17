import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_INSTALLED_EXPORT_ACCEPTANCE_SWITCH,
  DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE_SWITCH,
  resolveInstalledExportAcceptancePath,
  resolveInstalledUnaryLatencyAcceptance,
} from '../src/main/installed-export-acceptance.ts'

const roots: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-export-acceptance-'))
  roots.push(home)
  return home
}

function privateExportDirectory(home: string): string {
  const directory = join(home, '.desktop-acceptance', 'export')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installed export acceptance path', () => {
  it('只在已打包 CI 的显式开关下返回 Home 内固定目标', () => {
    const home = temporaryHome()
    privateExportDirectory(home)
    const base = {
      argv: [DESKTOP_INSTALLED_EXPORT_ACCEPTANCE_SWITCH],
      ci: true,
      packaged: true,
      home,
    }

    expect(resolveInstalledExportAcceptancePath(base))
      .toBe(join(realpathSync(home), '.desktop-acceptance', 'export', 'session-export.zip'))
    expect(resolveInstalledExportAcceptancePath({ ...base, argv: [] })).toBeUndefined()
    expect(resolveInstalledExportAcceptancePath({ ...base, ci: false })).toBeUndefined()
    expect(resolveInstalledExportAcceptancePath({ ...base, packaged: false })).toBeUndefined()
  })

  it('拒绝缺失、可被其他用户写入或符号链接的验收目录', () => {
    const missingHome = temporaryHome()
    const base = {
      argv: [DESKTOP_INSTALLED_EXPORT_ACCEPTANCE_SWITCH],
      ci: true,
      packaged: true,
    }
    expect(() => resolveInstalledExportAcceptancePath({ ...base, home: missingHome }))
      .toThrow('验收导出目录不存在')

    if (process.platform !== 'win32') {
      const permissiveHome = temporaryHome()
      chmodSync(privateExportDirectory(permissiveHome), 0o777)
      expect(() => resolveInstalledExportAcceptancePath({ ...base, home: permissiveHome }))
        .toThrow('验收导出目录权限不安全')

      const linkedHome = temporaryHome()
      const target = join(linkedHome, 'target')
      mkdirSync(target, { mode: 0o700 })
      mkdirSync(join(linkedHome, '.desktop-acceptance'), { mode: 0o700 })
      symlinkSync(target, join(linkedHome, '.desktop-acceptance', 'export'), 'dir')
      expect(() => resolveInstalledExportAcceptancePath({ ...base, home: linkedHome }))
        .toThrow('验收导出目录不能是符号链接')
    }
  })

  it('只在已打包 CI 的显式开关下启用真实 IPC unary 延迟门禁', () => {
    const base = {
      argv: [DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE_SWITCH],
      ci: true,
      packaged: true,
    }
    expect(resolveInstalledUnaryLatencyAcceptance(base)).toBe(true)
    expect(resolveInstalledUnaryLatencyAcceptance({ ...base, argv: [] })).toBe(false)
    expect(resolveInstalledUnaryLatencyAcceptance({ ...base, ci: false })).toBe(false)
    expect(resolveInstalledUnaryLatencyAcceptance({ ...base, packaged: false })).toBe(false)
  })
})
