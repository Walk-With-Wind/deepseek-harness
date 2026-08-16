import { describe, expect, it, vi } from 'vitest'
import { createDesktopMenuTemplate } from '../src/main/menu.ts'

describe('Desktop menu', () => {
  it('macOS/Windows 提供真实应用内检查入口', () => {
    const actions = { checkForUpdates: vi.fn(), openReleasePage: vi.fn(), exportDiagnostics: vi.fn() }
    for (const platform of ['darwin', 'win32'] as const) {
      const text = JSON.stringify(createDesktopMenuTemplate(platform, true, actions))
      expect(text).toContain('检查更新')
      expect(text).not.toContain('查看升级说明')
    }
  })

  it('Linux 只提供发行页说明，不显示假应用内更新按钮', () => {
    const actions = { checkForUpdates: vi.fn(), openReleasePage: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('linux', false, actions))
    expect(text).toContain('查看升级说明')
    expect(text).not.toContain('检查更新')
  })

  it('不暴露无法重新注入 bootstrap 数据端口的原生 reload', () => {
    const actions = { checkForUpdates: vi.fn(), openReleasePage: vi.fn(), exportDiagnostics: vi.fn() }
    const text = JSON.stringify(createDesktopMenuTemplate('darwin', true, actions))
    expect(text).not.toContain('reload')
  })
})
