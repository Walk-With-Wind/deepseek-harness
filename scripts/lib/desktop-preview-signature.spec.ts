/** 无签名 Preview 的平台签名状态解析。 */
import { describe, expect, it } from 'vitest'
import {
  assertMacAdHocSignature,
  assertWindowsUnsignedSignature,
} from './desktop-preview-signature.ts'

describe('Desktop unsigned Preview signatures', () => {
  it('只接受通过 codesign 校验的 ad-hoc 应用身份', () => {
    expect(() => { assertMacAdHocSignature('Signature=adhoc\nTeamIdentifier=not set\n') }).not.toThrow()
    expect(() => { assertMacAdHocSignature('Authority=Developer ID Application: Example\n') })
      .toThrow(/ad-hoc/)
    expect(() => { assertMacAdHocSignature('Signature=adhoc\nAuthority=Example\n') })
      .toThrow(/发行签名/)
  })

  it('只接受 Authenticode 的 NotSigned 状态', () => {
    expect(() => { assertWindowsUnsignedSignature('NotSigned\r\n') }).not.toThrow()
    expect(() => { assertWindowsUnsignedSignature('Valid\r\n') }).toThrow(/NotSigned/)
  })
})
