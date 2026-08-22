import { describe, expect, it } from 'vitest'
import { assertDesktopRendererSecurity } from '../src/renderer/security.ts'

const secure = {
  origin: 'app://localhost',
  requireType: 'undefined',
  processType: 'undefined',
  bridgeKeys: ['bootstrap', 'invoke', 'onHostState', 'onUpdateState', 'releaseDataPort'],
  bridgeFrozen: true,
}

describe('Desktop Renderer runtime invariant', () => {
  it('接受可信 origin、无 Node 全局和冻结窄桥', () => {
    expect(() => { assertDesktopRendererSecurity(secure) }).not.toThrow()
  })

  it.each([
    { ...secure, origin: 'file://' },
    { ...secure, requireType: 'function' },
    { ...secure, processType: 'object' },
    { ...secure, bridgeKeys: [...secure.bridgeKeys, 'send'] },
    { ...secure, bridgeFrozen: false },
  ])('拒绝 Renderer 权限漂移 %#', (snapshot) => {
    expect(() => { assertDesktopRendererSecurity(snapshot) }).toThrow(/安全不变量/)
  })
})
