import { describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOWS_APP_USER_MODEL_ID,
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
} from '../src/shared/release-policy.ts'
import { handleSquirrelStartup } from '../src/main/squirrel-startup.ts'

describe('Squirrel.Windows startup', () => {
  it.each([
    ['--squirrel-install', '--createShortcut=deepseek-harness-community.exe'],
    ['--squirrel-updated', '--createShortcut=deepseek-harness-community.exe'],
    ['--squirrel-uninstall', '--removeShortcut=deepseek-harness-community.exe'],
  ])('处理 %s 后按固定时限退出，不等待 updater', (event, updaterArgument) => {
    const updaterCalls: string[][] = []
    const deferredQuits: number[] = []
    let immediateQuits = 0

    expect(handleSquirrelStartup(
      'win32',
      ['deepseek-harness-community.exe', event],
      '/install/app-0.1.0/deepseek-harness-community.exe',
      {
        startUpdater(args) { updaterCalls.push([...args]) },
        deferQuit(delayMs) { deferredQuits.push(delayMs) },
        quit() { immediateQuits += 1 },
      },
    )).toBe(true)
    expect(updaterCalls).toEqual([[updaterArgument]])
    expect(deferredQuits).toEqual([1_000])
    expect(immediateQuits).toBe(0)
  })

  it('updater 启动失败仍按固定时限退出', () => {
    const deferredQuits: number[] = []

    expect(handleSquirrelStartup(
      'win32',
      ['deepseek-harness-community.exe', '--squirrel-uninstall'],
      '/install/app-0.1.0/deepseek-harness-community.exe',
      {
        startUpdater() { throw new Error('updater unavailable') },
        deferQuit(delayMs) { deferredQuits.push(delayMs) },
        quit() { throw new Error('unexpected immediate quit') },
      },
    )).toBe(true)
    expect(deferredQuits).toEqual([1_000])
  })

  it('obsolete 事件立即退出，普通启动和非 Windows 平台不处理', () => {
    const calls: string[] = []
    const runtime = {
      startUpdater() { calls.push('updater') },
      deferQuit() { calls.push('deferred') },
      quit() { calls.push('quit') },
    }

    expect(handleSquirrelStartup(
      'win32', ['desktop.exe', '--squirrel-obsolete'], '/install/desktop.exe', runtime,
    )).toBe(true)
    expect(calls).toEqual(['quit'])

    calls.length = 0
    expect(handleSquirrelStartup('win32', ['desktop.exe'], '/install/desktop.exe', runtime)).toBe(false)
    expect(handleSquirrelStartup(
      'darwin', ['desktop', '--squirrel-uninstall'], '/Applications/desktop', runtime,
    )).toBe(false)
    expect(calls).toEqual([])
  })

  it('任务栏身份与 Maker 包名和可执行文件一致', () => {
    expect(DESKTOP_WINDOWS_APP_USER_MODEL_ID).toBe(
      `com.squirrel.${DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID}.${DESKTOP_EXECUTABLE_NAME}`,
    )
  })
})
