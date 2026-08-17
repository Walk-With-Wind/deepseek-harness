/** Electron autoUpdater 的窄适配器与固定生产 feed 解析。 */
import { autoUpdater } from 'electron'
import type { DesktopUpdateChannel } from '../shared/update-protocol.ts'
import {
  assertDesktopReleasePlatform,
  DESKTOP_UPDATE_ORIGIN,
} from '../shared/release-policy.ts'
import type { NativeUpdateAdapter, NativeUpdateEvent } from './update-provider.ts'

export { DESKTOP_UPDATE_ORIGIN }

interface ElectronUpdaterLike {
  setFeedURL(options: { url: string; serverType?: 'json' | 'default'; allowAnyVersion?: boolean }): void
  checkForUpdates(): void
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

/** 根据固定源、平台和发行通道生成原生 updater feed。 */
export function desktopUpdateFeedUrl(
  platform: NodeJS.Platform,
  arch: string,
  channel: DesktopUpdateChannel,
): string {
  assertDesktopReleasePlatform(platform)
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`架构 ${arch} 不支持应用内更新`)
  const suffix = platform === 'darwin' ? 'releases.json' : ''
  return `${DESKTOP_UPDATE_ORIGIN}/harness/${channel}/${platform}-${arch}/${suffix}`
}

/** 把 Electron 的可变事件参数收窄为稳定内部事件。 */
export class ElectronNativeUpdateAdapter implements NativeUpdateAdapter {
  private readonly listeners = new Set<(event: NativeUpdateEvent) => void>()
  private readonly installedListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = []

  /** @param updater - Electron autoUpdater 或测试替身。 */
  constructor(
    private readonly updater: ElectronUpdaterLike,
    feedUrl: string,
    platform: NodeJS.Platform,
  ) {
    updater.setFeedURL({
      url: feedUrl,
      ...(platform === 'darwin' ? { serverType: 'json' as const } : {}),
      ...(platform === 'win32' ? { allowAnyVersion: false } : {}),
    })
    this.bind('checking-for-update', () => { this.emit({ type: 'checking' }) })
    this.bind('update-not-available', () => { this.emit({ type: 'not-available' }) })
    this.bind('update-available', () => { this.emit({ type: 'available' }) })
    this.bind('update-downloaded', (...args) => {
      this.emit({
        type: 'downloaded',
        version: extractReleaseVersion(args[2]),
        ...updateUrl(args[4]),
      })
    })
    this.bind('error', (...args) => {
      const error = args[0]
      const message = error instanceof Error ? error.message : ''
      this.emit({ type: 'error', code: classifyUpdateError(message) })
    })
  }

  /** @inheritdoc */
  subscribe(listener: (event: NativeUpdateEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @inheritdoc */
  check(): void {
    this.updater.checkForUpdates()
  }

  /** @inheritdoc */
  quitAndInstall(): void {
    this.updater.quitAndInstall()
  }

  /** 移除 Electron 事件监听器。 */
  /** @inheritdoc */
  dispose(): void {
    for (const { event, listener } of this.installedListeners) this.updater.off(event, listener)
    this.installedListeners.length = 0
    this.listeners.clear()
  }

  private bind(event: string, listener: (...args: unknown[]) => void): void {
    this.updater.on(event, listener)
    this.installedListeners.push({ event, listener })
  }

  private emit(event: NativeUpdateEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** 为当前进程创建固定源适配器。 */
export function createElectronUpdateAdapter(
  platform: NodeJS.Platform,
  arch: string,
  channel: DesktopUpdateChannel,
): ElectronNativeUpdateAdapter {
  assertDesktopReleasePlatform(platform)
  return new ElectronNativeUpdateAdapter(
    autoUpdater,
    desktopUpdateFeedUrl(platform, arch, channel),
    platform,
  )
}

function extractReleaseVersion(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  const match = /(?:^|[^0-9])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/.exec(text)
  return match?.[1] ?? 'invalid'
}

function updateUrl(value: unknown): { updateUrl?: string } {
  return typeof value === 'string' && value !== '' ? { updateUrl: value } : {}
}

function classifyUpdateError(message: string): string {
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|offline/i.test(message)) return 'UPDATE_NETWORK_UNAVAILABLE'
  if (/signature|checksum|hash|integrity/i.test(message)) return 'UPDATE_INTEGRITY_FAILED'
  if (/disk|space|ENOSPC/i.test(message)) return 'UPDATE_DISK_FULL'
  return 'UPDATE_NATIVE_FAILED'
}
