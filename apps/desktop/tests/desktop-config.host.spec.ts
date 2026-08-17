import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DESKTOP_CONFIG } from '../src/shared/control-protocol.ts'
import { readDesktopConfig } from '../src/main/desktop-config.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('Desktop app-private config', () => {
  it('从随包 JSON 读取部署覆盖并补齐默认值', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    writeFileSync(join(root, 'desktop.config.json'), JSON.stringify({ bootTimeoutMs: 75_000 }))
    expect(readDesktopConfig(root)).toEqual({ ...DEFAULT_DESKTOP_CONFIG, bootTimeoutMs: 75_000 })
  })

  it('缺失、损坏或越界配置均拒绝启动', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    expect(() => readDesktopConfig(root!)).toThrow(/无法读取/)
    writeFileSync(join(root, 'desktop.config.json'), '{')
    expect(() => readDesktopConfig(root!)).toThrow(/无法读取/)
    writeFileSync(join(root, 'desktop.config.json'), JSON.stringify({ maxInFlightRequests: 0 }))
    expect(() => readDesktopConfig(root!)).toThrow()
  })
})
