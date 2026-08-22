import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_RELEASE_DOWNLOAD_BASE_URL,
  DESKTOP_UPDATE_BASE_URL,
} from '../src/shared/release-policy.ts'
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
      .toBe(`${DESKTOP_UPDATE_ORIGIN}/deepseek-harness/desktop-updates/canary/darwin-arm64/releases.json`)
    expect(desktopUpdateFeedUrl('win32', 'x64', 'stable'))
      .toBe(`${DESKTOP_UPDATE_ORIGIN}/deepseek-harness/desktop-updates/stable/win32-x64/`)
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
    const releaseUrl = `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/1.4.0/DeepSeek-Harness-Community-1.4.0-darwin-arm64.zip`
    updater.emit('update-downloaded', {}, 'notes', 'DeepSeek Harness Community Build 1.4.0', new Date(), releaseUrl)
    updater.emit('error', new Error('request failed: token=CANARY_SECRET'))
    expect(events).toEqual([
      { type: 'available' },
      { type: 'downloaded', version: '1.4.0', updateUrl: releaseUrl },
      { type: 'error', code: 'UPDATE_NATIVE_FAILED' },
    ])
    expect(JSON.stringify(events)).not.toContain('CANARY_SECRET')
  })

  it('配置 macOS JSON feed，且 dispose 后不再转发事件', () => {
    const updater = new FakeElectronUpdater()
    const feed = `${DESKTOP_UPDATE_BASE_URL}/stable/darwin-arm64/releases.json`
    const adapter = new ElectronNativeUpdateAdapter(updater, feed, 'darwin')
    const listener = vi.fn()
    adapter.subscribe(listener)
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: feed, serverType: 'json',
    })
    adapter.dispose()
    updater.emit('update-not-available')
    expect(listener).not.toHaveBeenCalled()
  })

  it('Windows 在调用原生自动下载前拒绝非 Community Release 地址', async () => {
    const updater = new FakeElectronUpdater()
    const feed = desktopUpdateFeedUrl('win32', 'x64', 'stable')
    const readFeed = vi.fn().mockResolvedValue(
      `${'a'.repeat(40)}  https://github.com/deepseek-ai/deepseek-harness/releases/download/dsh-v1.4.0/update.nupkg 42\n`,
    )
    const adapter = new ElectronNativeUpdateAdapter(updater, feed, 'win32', readFeed)
    const listener = vi.fn()
    adapter.subscribe(listener)

    adapter.check()
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith({
        type: 'error', code: 'UPDATE_METADATA_INVALID', retryable: false,
      })
    })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    readFeed.mockResolvedValue(
      `${'b'.repeat(40)}  ${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.4.0/update.nupkg 42\n`,
    )
    adapter.check()
    await vi.waitFor(() => { expect(updater.checkForUpdates).toHaveBeenCalledOnce() })
  })

  it('macOS 在调用原生自动下载前拒绝非 Community Release 地址', async () => {
    const updater = new FakeElectronUpdater()
    const feed = desktopUpdateFeedUrl('darwin', 'arm64', 'canary')
    const readFeed = vi.fn().mockResolvedValue(JSON.stringify({
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/download/dsh-v1.4.0/update.zip',
      name: '1.4.0',
    }))
    const adapter = new ElectronNativeUpdateAdapter(updater, feed, 'darwin', readFeed)
    const listener = vi.fn()
    adapter.subscribe(listener)

    adapter.check()
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith({
        type: 'error', code: 'UPDATE_METADATA_INVALID', retryable: false,
      })
    })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    readFeed.mockResolvedValue(JSON.stringify({
      url: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.4.0/update.zip`,
      name: '1.4.0',
    }))
    adapter.check()
    await vi.waitFor(() => { expect(updater.checkForUpdates).toHaveBeenCalledOnce() })
  })
})
