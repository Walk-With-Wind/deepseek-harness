import { describe, expect, it } from 'vitest'
import { desktopNativeVersions } from '../src/shared/release-policy.ts'

describe('Desktop native versions', () => {
  it('keeps product SemVer separate from numeric platform versions', () => {
    expect(desktopNativeVersions('0.1.0-rc.8', 1)).toEqual({
      appVersion: '0.1.0',
      buildVersion: '1.0.1',
    })
    expect(desktopNativeVersions('2.4.7', 10_000)).toEqual({
      appVersion: '2.4.7',
      buildVersion: '2.0.0',
    })
  })

  it('rejects invalid product versions and out-of-range build sequences', () => {
    expect(() => desktopNativeVersions('1.2.3.4', 1)).toThrow(/版本/)
    expect(() => desktopNativeVersions('1.2.3', 0)).toThrow(/构建序列/)
    expect(() => desktopNativeVersions('1.2.3', 99_990_000)).toThrow(/构建序列/)
  })
})
