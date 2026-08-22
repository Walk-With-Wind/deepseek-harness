import { describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOWS_APP_USER_MODEL_ID,
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
} from '../src/shared/release-policy.ts'
import { shouldExitForSquirrelStartup } from '../src/main/squirrel-startup.ts'

describe('Squirrel.Windows startup', () => {
  it('只在 Windows 的 Squirrel 维护启动中跳过常规 Host', () => {
    expect(shouldExitForSquirrelStartup('win32', true)).toBe(true)
    expect(shouldExitForSquirrelStartup('win32', false)).toBe(false)
    expect(shouldExitForSquirrelStartup('darwin', true)).toBe(false)
  })

  it('任务栏身份与 Maker 包名和可执行文件一致', () => {
    expect(DESKTOP_WINDOWS_APP_USER_MODEL_ID).toBe(
      `com.squirrel.${DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID}.${DESKTOP_EXECUTABLE_NAME}`,
    )
  })
})
