import { describe, expect, it, vi } from 'vitest'
import {
  DesktopUpdateProvider,
  type NativeUpdateAdapter,
  type NativeUpdateEvent,
} from '../src/main/update-provider.ts'

class FakeNativeUpdater implements NativeUpdateAdapter {
  readonly check = vi.fn()
  readonly quitAndInstall = vi.fn()
  private listener: ((event: NativeUpdateEvent) => void) | undefined

  subscribe(listener: (event: NativeUpdateEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }

  emit(event: NativeUpdateEvent): void {
    this.listener?.(event)
  }
}

function provider(native: FakeNativeUpdater, version = '1.2.3'): DesktopUpdateProvider {
  return new DesktopUpdateProvider({
    platform: 'darwin', arch: 'arm64', currentVersion: version,
    releasePageUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases',
    allowedFeedOrigin: 'https://desktop-updates.deepseek.com', native,
  })
}

describe('DesktopUpdateProvider', () => {
  it('Linux 只给出包管理器指引，不创建假应用内更新入口', () => {
    const update = new DesktopUpdateProvider({
      platform: 'linux', arch: 'x64', currentVersion: '1.2.3',
      releasePageUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases',
      allowedFeedOrigin: 'https://desktop-updates.deepseek.com',
    })
    expect(update.state()).toMatchObject({ phase: 'UNSUPPORTED', supported: false })
    expect(update.check()).toBe(false)
  })

  it('把检查、自动下载、用户批准和 quiescent 后安装分成明确阶段', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native)
    expect(update.check()).toBe(true)
    expect(native.check).toHaveBeenCalledOnce()
    native.emit({ type: 'available' })
    expect(update.state()).toEqual({
      phase: 'DOWNLOADING', supported: true, channel: 'stable', currentVersion: '1.2.3',
    })
    native.emit({ type: 'downloaded', version: '1.3.0', updateUrl: 'https://desktop-updates.deepseek.com/stable/mac.zip' })
    expect(update.state()).toMatchObject({ phase: 'READY', targetVersion: '1.3.0' })
    expect(update.approveInstall()).toBe(true)
    expect(update.state()).toMatchObject({ phase: 'INSTALLING' })
    expect(native.quitAndInstall).not.toHaveBeenCalled()
    update.installAfterQuiescent()
    expect(native.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('拒绝降级、错误通道和非固定 HTTPS 来源', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native)
    update.check()
    native.emit({ type: 'available' })
    native.emit({ type: 'downloaded', version: '1.2.2' })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID', retryable: false })

    update.check()
    native.emit({ type: 'available' })
    native.emit({ type: 'downloaded', version: '1.3.0-rc.1' })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })

    update.check()
    native.emit({ type: 'available' })
    native.emit({ type: 'downloaded', version: '1.3.0', updateUrl: 'http://attacker.invalid/update.zip' })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })
  })

  it('canary 只接受严格递增的 canary 元数据，并拒绝下载中重复检查', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native, '1.3.0-rc.1')
    update.check()
    native.emit({ type: 'available' })
    expect(update.state()).toMatchObject({ phase: 'DOWNLOADING', channel: 'canary' })
    expect(update.check()).toBe(false)
    native.emit({ type: 'downloaded', version: '1.3.0' })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })
  })

  it('原生失败使用稳定错误码且允许有界重试', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native)
    update.check()
    native.emit({ type: 'error', code: 'network timeout / token=secret' })
    expect(update.state()).toMatchObject({
      phase: 'ERROR', code: 'UPDATE_FAILED', retryable: true,
    })
    expect(JSON.stringify(update.state())).not.toContain('secret')
    expect(update.check()).toBe(true)
  })

  it('原生安装启动同步失败时返回 false 并进入可重试错误态', () => {
    const native = new FakeNativeUpdater()
    native.quitAndInstall.mockImplementation(() => { throw new Error('native installer failed') })
    const update = provider(native)
    update.check()
    native.emit({ type: 'available' })
    native.emit({ type: 'downloaded', version: '1.3.0' })
    expect(update.approveInstall()).toBe(true)

    expect(update.installAfterQuiescent()).toBe(false)
    expect(update.state()).toMatchObject({
      phase: 'ERROR', code: 'UPDATE_INSTALL_START_FAILED', retryable: true,
    })
  })
})
