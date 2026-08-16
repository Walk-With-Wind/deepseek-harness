import { describe, expect, it } from 'vitest'
import { assertDesktopWindowSecurity } from '../src/main/window-security.ts'

const secure = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
}

describe('Desktop BrowserWindow runtime invariant', () => {
  it('接受最终窗口的精确最小权限参数', () => {
    expect(() => { assertDesktopWindowSecurity(secure) }).not.toThrow()
  })

  it.each(Object.keys(secure))('拒绝安全参数 %s 漂移', (name) => {
    expect(() => {
      assertDesktopWindowSecurity({ ...secure, [name]: !secure[name as keyof typeof secure] })
    }).toThrow(/安全参数/)
  })
})
