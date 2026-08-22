import { describe, expect, it, vi } from 'vitest'
import {
  DesktopUpdateProvider,
  type NativeUpdateAdapter,
  type NativeUpdateEvent,
} from '../src/main/update-provider.ts'
import {
  DESKTOP_RELEASE_DOWNLOAD_BASE_URL,
} from '../src/shared/release-policy.ts'

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
    platform: 'darwin', currentVersion: version,
    native, updatesEnabled: true,
  })
}

describe('DesktopUpdateProvider', () => {
  it('拒绝为非发行平台创建更新状态机', () => {
    expect(() => new DesktopUpdateProvider({
      platform: 'linux', currentVersion: '1.2.3',
      native: new FakeNativeUpdater(), updatesEnabled: true,
    })).toThrow(/不支持/)
  })

  it('unsigned preview 不订阅或调用原生更新器', () => {
    const native = new FakeNativeUpdater()
    const update = new DesktopUpdateProvider({
      platform: 'darwin', currentVersion: '1.2.3-rc.4', native,
      updatesEnabled: false,
    })

    expect(update.check()).toBe(false)
    expect(native.check).not.toHaveBeenCalled()
    native.emit({ type: 'available' })
    expect(update.state()).toEqual({
      phase: 'IDLE', channel: 'canary', currentVersion: '1.2.3-rc.4',
    })

    const withoutNative = new DesktopUpdateProvider({
      platform: 'darwin', currentVersion: '1.2.3-rc.4', updatesEnabled: false,
    })
    expect(() => { withoutNative.dispose() }).not.toThrow()
  })

  it('把检查、自动下载、用户批准和 quiescent 后安装分成明确阶段', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native)
    expect(update.check()).toBe(true)
    expect(native.check).toHaveBeenCalledOnce()
    native.emit({ type: 'available' })
    expect(update.state()).toEqual({
      phase: 'DOWNLOADING', channel: 'stable', currentVersion: '1.2.3',
    })
    native.emit({
      type: 'downloaded',
      version: '1.3.0',
      updateUrl: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.3.0/DeepSeek-Harness-Community-1.3.0-darwin-arm64.zip`,
    })
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

    update.check()
    native.emit({ type: 'available' })
    native.emit({
      type: 'downloaded',
      version: '1.3.0',
      updateUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases/download/1.3.0/update.zip',
    })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })

    update.check()
    native.emit({ type: 'available' })
    native.emit({
      type: 'downloaded',
      version: '1.3.0',
      updateUrl: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.4.0/update.zip`,
    })
    expect(update.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })
  })

  it('canary 接受同版本线 final 晋级，并拒绝跨版本线或下载中重复检查', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native, '1.3.0-rc.1')
    update.check()
    native.emit({ type: 'available' })
    expect(update.state()).toMatchObject({ phase: 'DOWNLOADING', channel: 'canary' })
    expect(update.check()).toBe(false)
    native.emit({
      type: 'downloaded',
      version: '1.3.0',
      updateUrl: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.3.0/DeepSeek-Harness-Community-1.3.0-darwin-arm64.zip`,
    })
    expect(update.state()).toMatchObject({ phase: 'READY', targetVersion: '1.3.0' })

    const differentNative = new FakeNativeUpdater()
    const differentCore = provider(differentNative, '1.3.0-rc.1')
    differentCore.check()
    differentNative.emit({ type: 'available' })
    differentNative.emit({
      type: 'downloaded',
      version: '1.4.0',
      updateUrl: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.4.0/DeepSeek-Harness-Community-1.4.0-darwin-arm64.zip`,
    })
    expect(differentCore.state()).toMatchObject({ phase: 'ERROR', code: 'UPDATE_METADATA_INVALID' })
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

  it('把原生元数据拒绝保持为不可重试错误', () => {
    const native = new FakeNativeUpdater()
    const update = provider(native)
    update.check()
    native.emit({ type: 'error', code: 'UPDATE_METADATA_INVALID', retryable: false })
    expect(update.state()).toMatchObject({
      phase: 'ERROR', code: 'UPDATE_METADATA_INVALID', retryable: false,
    })
  })

  it('原生安装启动同步失败时返回 false 并进入可重试错误态', () => {
    const native = new FakeNativeUpdater()
    native.quitAndInstall.mockImplementation(() => { throw new Error('native installer failed') })
    const update = provider(native)
    update.check()
    native.emit({ type: 'available' })
    native.emit({
      type: 'downloaded',
      version: '1.3.0',
      updateUrl: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/dsh-v1.3.0/DeepSeek-Harness-Community-1.3.0-darwin-arm64.zip`,
    })
    expect(update.approveInstall()).toBe(true)

    expect(update.installAfterQuiescent()).toBe(false)
    expect(update.state()).toMatchObject({
      phase: 'ERROR', code: 'UPDATE_INSTALL_START_FAILED', retryable: true,
    })
  })
})
