import { describe, expect, it, vi } from 'vitest'
import { createDesktopMenuTemplate } from '../src/main/menu.ts'

describe('Desktop menu', () => {
  it('macOS/Windows 提供真实应用内检查入口', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    for (const platform of ['darwin', 'win32'] as const) {
      const text = JSON.stringify(createDesktopMenuTemplate(platform, actions, { releaseMode: 'signed' }))
      expect(text).toContain('检查更新')
      expect(text).not.toContain('查看升级说明')
    }
  })

  it('拒绝为非发行平台构造产品菜单', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    expect(() => createDesktopMenuTemplate('linux', actions, { releaseMode: 'signed' })).toThrow(/不支持/)
  })

  it('unsigned preview 保留说明性入口但禁止检查更新', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('darwin', actions, {
      releaseMode: 'unsigned-preview',
    }))
    expect(text).toContain('Unsigned Preview 不提供自动更新')
    expect(text).toContain('"enabled":false')
  })

  it('development 构建不冒充 unsigned preview', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('darwin', actions, {
      releaseMode: 'development',
    }))
    expect(text).toContain('开发构建不提供自动更新')
    expect(text).not.toContain('Unsigned Preview')
  })

  it('不暴露无法重新注入 bootstrap 数据端口的原生 reload', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('darwin', actions, { releaseMode: 'signed' }))
    expect(text).not.toContain('reload')
  })
})
