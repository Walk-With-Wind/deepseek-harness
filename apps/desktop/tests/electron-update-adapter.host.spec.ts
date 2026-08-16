import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_UPDATE_ORIGIN,
  ElectronNativeUpdateAdapter,
  desktopUpdateFeedUrl,
} from '../src/main/electron-update-adapter.ts'
import type { NativeUpdateEvent } from '../src/main/update-provider.ts'

class FakeElectronUpdater extends EventEmitter {
  readonly setFeedURL = vi.fn()
  readonly checkForUpdates = vi.fn()
  readonly quitAndInstall = vi.fn()
}

describe('ElectronNativeUpdateAdapter', () => {
  it('只从固定 HTTPS 源构造平台与通道 feed', () => {
    expect(desktopUpdateFeedUrl('darwin', 'arm64', 'canary'))
      .toBe(`${DESKTOP_UPDATE_ORIGIN}/harness/canary/darwin-arm64/releases.json`)
    expect(desktopUpdateFeedUrl('win32', 'x64', 'stable'))
      .toBe(`${DESKTOP_UPDATE_ORIGIN}/harness/stable/win32-x64/`)
    expect(() => desktopUpdateFeedUrl('linux', 'x64', 'stable')).toThrow(/不支持/)
  })

  it('把 Electron 事件收窄为不含原始错误内容的稳定事件', () => {
    const updater = new FakeElectronUpdater()
    const adapter = new ElectronNativeUpdateAdapter(
      updater, desktopUpdateFeedUrl('darwin', 'arm64', 'stable'), 'darwin',
    )
    const events: NativeUpdateEvent[] = []
    adapter.subscribe((event) => { events.push(event) })
    updater.emit('update-available')
    updater.emit('update-downloaded', {}, 'notes', 'DeepSeek Harness 1.4.0', new Date(), `${DESKTOP_UPDATE_ORIGIN}/artifact.zip`)
    updater.emit('error', new Error('request failed: token=CANARY_SECRET'))
    expect(events).toEqual([
      { type: 'available' },
      { type: 'downloaded', version: '1.4.0', updateUrl: `${DESKTOP_UPDATE_ORIGIN}/artifact.zip` },
      { type: 'error', code: 'UPDATE_NATIVE_FAILED' },
    ])
    expect(JSON.stringify(events)).not.toContain('CANARY_SECRET')
  })

  it('配置 macOS JSON feed，且 dispose 后不再转发事件', () => {
    const updater = new FakeElectronUpdater()
    const adapter = new ElectronNativeUpdateAdapter(updater, 'https://desktop-updates.deepseek.com/feed', 'darwin')
    const listener = vi.fn()
    adapter.subscribe(listener)
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://desktop-updates.deepseek.com/feed', serverType: 'json',
    })
    adapter.dispose()
    updater.emit('update-not-available')
    expect(listener).not.toHaveBeenCalled()
  })
})
