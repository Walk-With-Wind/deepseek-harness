/** Desktop 更新状态机；平台 updater 只通过该接缝进入 Main。 */
import { EventEmitter } from 'node:events'
import type { DesktopUpdateChannel, DesktopUpdateState } from '../shared/update-protocol.ts'

/** 原生 updater 向状态机报告的、已经过平台适配的事件。 */
export type NativeUpdateEvent =
  | { readonly type: 'checking' }
  | { readonly type: 'available' }
  | { readonly type: 'not-available' }
  | { readonly type: 'downloaded'; readonly version: string; readonly updateUrl?: string }
  | { readonly type: 'error'; readonly code: string }

/** Electron autoUpdater 的最小可替换接口。 */
export interface NativeUpdateAdapter {
  /** 订阅原生更新事件。 */
  subscribe(listener: (event: NativeUpdateEvent) => void): () => void
  /** 触发一次检查；Electron 会自动下载可用更新。 */
  check(): void
  /** 仅在已下载后退出并安装。 */
  quitAndInstall(): void
  /** 移除平台事件监听器。 */
  dispose?(): void
}

export interface DesktopUpdateProviderOptions {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly currentVersion: string
  readonly releasePageUrl: string
  readonly allowedFeedOrigin: string
  readonly native?: NativeUpdateAdapter
}

interface ParsedVersion {
  readonly raw: string
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly (number | string)[]
}

/** Main 拥有的更新 provider；下载与安装批准严格分离。 */
export class DesktopUpdateProvider {
  private readonly emitter = new EventEmitter()
  private readonly channel: DesktopUpdateChannel
  private readonly current: ParsedVersion
  private readonly unsubscribeNative: (() => void) | undefined
  private stateValue: DesktopUpdateState
  private targetVersion: string | undefined
  private disposed = false

  /** @param options - 固定平台、版本、发行源和原生适配器。 */
  constructor(private readonly options: DesktopUpdateProviderOptions) {
    this.current = parseVersion(options.currentVersion)
    this.channel = this.current.prerelease.length === 0 ? 'stable' : 'canary'
    if (options.platform !== 'darwin' && options.platform !== 'win32') {
      this.stateValue = {
        phase: 'UNSUPPORTED', supported: false, channel: this.channel,
        currentVersion: options.currentVersion,
        guidance: '此平台通过系统包管理器或发行页升级，应用不会模拟自动更新。',
        releasePageUrl: options.releasePageUrl,
      }
      this.unsubscribeNative = undefined
      return
    }
    if (options.native === undefined) throw new Error('受支持平台缺少原生更新适配器')
    this.stateValue = this.idleState()
    this.unsubscribeNative = options.native.subscribe((event) => { this.receive(event) })
  }

  /** 当前脱敏状态快照。 */
  state(): DesktopUpdateState {
    return this.stateValue
  }

  /** 订阅状态变化，并立即收到当前值。 */
  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    listener(this.stateValue)
    this.emitter.on('state', listener)
    return () => { this.emitter.off('state', listener) }
  }

  /** 用户或低频调度器发起检查；并发检查被拒绝。 */
  check(): boolean {
    if (this.disposed || !this.stateValue.supported) return false
    if (this.stateValue.phase !== 'IDLE' && this.stateValue.phase !== 'ERROR') return false
    this.setState({
      phase: 'CHECKING', supported: true, channel: this.channel,
      currentVersion: this.options.currentVersion,
    })
    try {
      this.nativeAdapter().check()
      return true
    } catch {
      this.fail('UPDATE_CHECK_START_FAILED', true)
      return false
    }
  }

  /** 标记安装已获用户批准；实际调用必须等宿主 quiescent。 */
  approveInstall(): boolean {
    if (this.disposed || this.stateValue.phase !== 'READY') return false
    this.setState({ ...this.stateValue, phase: 'INSTALLING' })
    return true
  }

  /** quiescent shutdown 完成后调用原生安装器，并报告是否成功接管退出。 */
  installAfterQuiescent(): boolean {
    if (this.disposed || this.stateValue.phase !== 'INSTALLING') {
      throw new Error('更新尚未批准或宿主状态不允许安装')
    }
    try {
      this.nativeAdapter().quitAndInstall()
      return true
    } catch {
      this.fail('UPDATE_INSTALL_START_FAILED', true)
      return false
    }
  }

  /** 正常排空失败时保持当前安装不变，并允许用户稍后重新检查。 */
  abortInstall(): void {
    if (this.disposed || this.stateValue.phase !== 'INSTALLING') return
    this.fail('UPDATE_HOST_NOT_QUIESCENT', true)
  }

  /** 移除原生事件监听器。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeNative?.()
    this.options.native?.dispose?.()
    this.emitter.removeAllListeners()
  }

  private receive(event: NativeUpdateEvent): void {
    if (this.disposed || !this.stateValue.supported) return
    switch (event.type) {
      case 'checking':
        return
      case 'not-available':
        this.targetVersion = undefined
        this.setState(this.idleState())
        return
      case 'available': {
        this.targetVersion = undefined
        this.setState({
          phase: 'DOWNLOADING', supported: true, channel: this.channel,
          currentVersion: this.options.currentVersion,
        })
        return
      }
      case 'downloaded': {
        const target = this.validateTarget(event.version, event.updateUrl)
        if (target === undefined) return
        if (this.targetVersion !== undefined && target.raw !== this.targetVersion) {
          this.fail('UPDATE_VERSION_CHANGED', false)
          return
        }
        this.targetVersion = target.raw
        this.setState({
          phase: 'READY', supported: true, channel: this.channel,
          currentVersion: this.options.currentVersion, targetVersion: target.raw,
        })
        return
      }
      case 'error':
        this.fail(event.code, true)
        return
      default:
        return assertNever(event)
    }
  }

  private validateTarget(version: string, updateUrl: string | undefined): ParsedVersion | undefined {
    let target: ParsedVersion
    try {
      target = parseVersion(version)
      if (compareVersions(target, this.current) <= 0) throw new Error('版本没有递增')
      if (this.channel === 'stable' && target.prerelease.length !== 0) throw new Error('稳定通道拒绝预发布版本')
      if (this.channel === 'canary' && target.prerelease.length === 0) throw new Error('canary 通道拒绝跨通道版本')
      if (updateUrl !== undefined && updateUrl !== '') {
        const expected = new URL(this.options.allowedFeedOrigin)
        const actual = new URL(updateUrl)
        if (actual.protocol !== 'https:' || actual.origin !== expected.origin) throw new Error('更新来源不受信任')
      }
      return target
    } catch {
      this.fail('UPDATE_METADATA_INVALID', false)
      return undefined
    }
  }

  private idleState(): DesktopUpdateState {
    return {
      phase: 'IDLE', supported: true, channel: this.channel,
      currentVersion: this.options.currentVersion,
    }
  }

  /** 返回受支持平台在构造阶段已经验证的原生适配器。 */
  private nativeAdapter(): NativeUpdateAdapter {
    const native = this.options.native
    if (native === undefined) throw new Error('受支持平台缺少原生更新适配器')
    return native
  }

  private fail(code: string, retryable: boolean): void {
    this.targetVersion = undefined
    this.setState({
      phase: 'ERROR', supported: true, channel: this.channel,
      currentVersion: this.options.currentVersion,
      code: stableCode(code),
      message: retryable ? '暂时无法完成更新检查，请稍后重试。' : '更新元数据未通过安全校验，当前版本保持不变。',
      retryable,
    })
  }

  private setState(state: DesktopUpdateState): void {
    this.stateValue = state
    this.emitter.emit('state', state)
  }
}

/** 从应用语义版本选择不可由 Renderer 覆盖的发行通道。 */
export function desktopUpdateChannel(version: string): DesktopUpdateChannel {
  return parseVersion(version).prerelease.length === 0 ? 'stable' : 'canary'
}

function parseVersion(value: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (match === null) throw new Error(`无效语义版本 ${value}`)
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map((entry) => {
    return /^\d+$/.test(entry) ? Number(entry) : entry
  })
  return {
    raw: value,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  }
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left.core[index] - right.core[index]
    if (difference !== 0) return difference
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'number') return l - r
    if (typeof l === 'number') return -1
    if (typeof r === 'number') return 1
    return l.localeCompare(r)
  }
  return 0
}

function stableCode(value: string): string {
  const token = value.toUpperCase().replace(/[^A-Z0-9_.-]/g, '_').slice(0, 128)
  return /^UPDATE_[A-Z0-9_.-]+$/.test(token) ? token : 'UPDATE_FAILED'
}

function assertNever(value: never): never {
  throw new Error(`Desktop updater 收到未处理事件：${JSON.stringify(value)}`)
}
