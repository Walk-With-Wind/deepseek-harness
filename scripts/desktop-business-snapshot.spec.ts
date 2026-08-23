import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDesktopBusinessDataUnchanged,
  isExpectedDesktopLeaseConflict,
  snapshotDesktopBusinessData,
} from './desktop-business-snapshot.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Desktop business-data snapshot', () => {
  it('稳定记录共享业务文件并忽略日志与 profile 维护数据', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-business-snapshot-'))
    roots.push(home)
    await mkdir(join(home, 'sessions'))
    await mkdir(join(home, 'logs'))
    await mkdir(join(home, 'profiles'))
    await writeFile(join(home, 'sessions', 'one.jsonl'), 'session\n')
    await writeFile(join(home, 'settings.yaml'), 'locale: zh-CN\n')
    const before = snapshotDesktopBusinessData(home)

    await writeFile(join(home, 'logs', 'main.jsonl'), 'log\n')
    await writeFile(join(home, 'profiles', 'desktop.json'), '{}\n')
    const after = snapshotDesktopBusinessData(home)

    expect(after).toEqual(before)
    expect(before.map(entry => entry.path)).toEqual(['sessions/one.jsonl', 'settings.yaml'])
    expect(() => { assertDesktopBusinessDataUnchanged(before, after) }).not.toThrow()
  })

  it('拒绝共享业务文件的新增、删除或内容变化', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-business-snapshot-'))
    roots.push(home)
    await mkdir(join(home, 'storages'))
    await writeFile(join(home, 'storages', 'workspace.json'), '{"revision":1}\n')
    const before = snapshotDesktopBusinessData(home)

    await writeFile(join(home, 'storages', 'workspace.json'), '{"revision":2}\n')
    const after = snapshotDesktopBusinessData(home)

    expect(() => { assertDesktopBusinessDataUnchanged(before, after) })
      .toThrow('竞争 Host 修改了共享业务数据')
  })
})

describe('Desktop lease contention acceptance', () => {
  it('接受详细 owner 与安全的泛化 live Host 冲突信息', () => {
    expect(isExpectedDesktopLeaseConflict(
      1,
      'dsh: Harness home is already in use by desktop Host pid 42 (version 0.1.0-rc.8). Close that Host and retry; the competing process was not modified.',
    )).toBe(true)
    expect(isExpectedDesktopLeaseConflict(
      1,
      'dsh: Harness home is already in use by another live Host. Close that Host and retry; the competing process was not modified.',
    )).toBe(true)
  })

  it('拒绝错误退出码、其他 Host 类型或不完整提示', () => {
    const desktopConflict = 'Harness home is already in use by desktop Host pid 42 (version 0.1.0-rc.8). Close that Host and retry; the competing process was not modified.'
    expect(isExpectedDesktopLeaseConflict(0, desktopConflict)).toBe(false)
    expect(isExpectedDesktopLeaseConflict(1, desktopConflict.replace('desktop Host', 'web Host'))).toBe(false)
    expect(isExpectedDesktopLeaseConflict(1, 'Harness home is already in use by another live Host.')).toBe(false)
  })
})
