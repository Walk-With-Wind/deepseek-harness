import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCommunityDesktopHome } from '../src/host/community-home.ts'

describe('Community Desktop home', () => {
  it('uses an isolated default below the operating-system home', () => {
    expect(resolveCommunityDesktopHome({}, '/Users/example'))
      .toBe(resolve('/Users/example/.deepseek-harness-community'))
  })

  it('preserves an explicit DSH_HOME for intentional CLI/Web sharing', () => {
    expect(resolveCommunityDesktopHome({ DSH_HOME: '/shared/../shared/dsh' }, '/Users/example'))
      .toBe(resolve('/shared/dsh'))
  })

  it('treats a blank DSH_HOME as unset in Main and Utility alike', () => {
    const environment = { DSH_HOME: '   ' }
    const mainHome = resolveCommunityDesktopHome(environment, '/Users/example')
    const utilityHome = resolveCommunityDesktopHome(environment, '/Users/example')
    expect(mainHome).toBe(resolve('/Users/example/.deepseek-harness-community'))
    expect(utilityHome).toBe(mainHome)
  })
})
