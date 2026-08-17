import { describe, expect, it, vi } from 'vitest'
import { createDesktopMenuTemplate } from '../src/main/menu.ts'

describe('Desktop menu', () => {
  it('macOS/Windows 提供真实应用内检查入口', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    for (const platform of ['darwin', 'win32'] as const) {
      const text = JSON.stringify(createDesktopMenuTemplate(platform, actions))
      expect(text).toContain('检查更新')
      expect(text).not.toContain('查看升级说明')
    }
  })

  it('拒绝为非发行平台构造产品菜单', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    expect(() => createDesktopMenuTemplate('linux', actions)).toThrow(/不支持/)
  })

  it('不暴露无法重新注入 bootstrap 数据端口的原生 reload', () => {
    const actions = { checkForUpdates: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('darwin', actions))
    expect(text).not.toContain('reload')
  })
})
