/** Utility 侧桌面控制能力：控制帧与业务数据端口严格分离。 */
import type { Context } from '@deepseek-ai/cordis'
import { IpcHostBridge } from '@deepseek-ai/dsh-client-connection/ipc-host'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { DirectoryPickerNativeCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { writeAtomicResponse } from './atomic-export.ts'
import { ElectronUtilityPortAdapter } from './port-adapter.ts'
import type {
  DesktopConfig,
  DesktopPathOpenIntent,
  MainControlFrame,
  UtilityControlFrame,
} from '../shared/control-protocol.ts'

/** Desktop Utility provider 可调用的 Main 原生能力。 */
interface DesktopHostControl {
  /** 请求 Main 为当前窗口打开目录选择器。 */
  readonly pickDirectory: DirectoryPickerNativeCapability['pick']
  /** 请求 Main 按指定意图打开 Utility 已授权的规范路径。 */
  openPath(path: string, intent: DesktopPathOpenIntent, signal: AbortSignal): Promise<void>
  /** 返回当前 Utility 私有资源计数，不包含路径、请求 id 或正文。 */
  resourceSnapshot(): DesktopUtilityResourceSnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Utility 私有 provider 使用的 Main 控制端口。 */
    desktopHost: DesktopHostControl
  }
}

interface DeferredPath {
  resolve(path: string | null): void
  reject(error: Error): void
}

interface DeferredNativePath {
  resolve(): void
  reject(error: Error): void
}

interface ExportOperation {
  readonly abort: AbortController
  readonly done: Promise<void>
}

/** Utility 耐久诊断比较的有界资源计数。 */
export interface DesktopUtilityResourceSnapshot {
  readonly bridges: number
  readonly inFlightRequests: number
  readonly requestReaders: number
  readonly responseReaders: number
  readonly exports: number
  readonly directoryDialogs: number
  readonly nativePaths: number
}

/** 当前 generation 的控制面与数据端口所有者。 */
export class DesktopUtilityControl implements DesktopHostControl {
  private readonly directories = new Map<string, DeferredPath>()
  private readonly nativePaths = new Map<string, DeferredNativePath>()
  private readonly exports = new Map<string, ExportOperation>()
  private readonly bridges = new Set<IpcHostBridge>()
  private ctx: Context | undefined
  private disposed = false

  /**
   * @param generation - Utility 代际。
   * @param config - 已校验传输上限。
   * @param send - 向 Main 发送严格控制帧。
   */
  constructor(
    private readonly generation: number,
    private readonly config: DesktopConfig,
    private readonly send: (frame: UtilityControlFrame) => void,
  ) {}

  /** Profile stable 后绑定 Host Context。 */
  attachContext(ctx: Context): void {
    if (this.ctx !== undefined) throw new Error('Desktop Utility Context 已绑定')
    this.ctx = ctx
  }

  /** @inheritdoc */
  pickDirectory(signal: AbortSignal): Promise<string | null> {
    if (this.disposed) return Promise.reject(new Error('Desktop Utility 已关闭'))
    signal.throwIfAborted()
    const operationId = crypto.randomUUID()
    return new Promise<string | null>((resolve, reject) => {
      const abort = (): void => {
        this.directories.delete(operationId)
        reject(errorReason(signal.reason, new DOMException('目录选择已取消', 'AbortError')))
      }
      this.directories.set(operationId, {
        resolve: (path) => {
          signal.removeEventListener('abort', abort)
          resolve(path)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      this.send({ type: 'dialog/open-directory', generation: this.generation, operationId })
    })
  }

  /** @inheritdoc */
  openPath(path: string, intent: DesktopPathOpenIntent, signal: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Desktop Utility 已关闭'))
    signal.throwIfAborted()
    const operationId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        if (!this.nativePaths.delete(operationId)) return
        this.send({ type: 'path/cancel', generation: this.generation, operationId })
        reject(errorReason(signal.reason, new DOMException('路径打开已取消', 'AbortError')))
      }
      this.nativePaths.set(operationId, {
        resolve: () => {
          signal.removeEventListener('abort', abort)
          resolve()
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      this.send({ type: 'path/open', generation: this.generation, operationId, path, intent })
    })
  }

  /** @inheritdoc */
  resourceSnapshot(): DesktopUtilityResourceSnapshot {
    let inFlightRequests = 0
    let requestReaders = 0
    let responseReaders = 0
    for (const bridge of this.bridges) {
      const snapshot = bridge.resourceSnapshot()
      inFlightRequests += snapshot.inFlightRequests
      requestReaders += snapshot.requestReaders
      responseReaders += snapshot.responseReaders
    }
    return {
      bridges: this.bridges.size,
      inFlightRequests,
      requestReaders,
      responseReaders,
      exports: this.exports.size,
      directoryDialogs: this.directories.size,
      nativePaths: this.nativePaths.size,
    }
  }

  /** 处理 Main 已通过 schema 校验且属于当前代际的控制帧。 */
  receive(frame: MainControlFrame, ports: readonly Electron.MessagePortMain[]): void {
    if (this.disposed || frame.generation !== this.generation) return
    switch (frame.type) {
      case 'host/health':
        this.send({ type: 'host/healthy', generation: this.generation, operationId: frame.operationId })
        return
      case 'data/attach':
        if (ports.length !== 1 || ports[0] === undefined) {
          throw new Error('data/attach 必须携带一个 MessagePort')
        }
        this.attachDataPort(ports[0])
        return
      case 'dialog/result': {
        const pending = this.directories.get(frame.operationId)
        if (pending === undefined) return
        this.directories.delete(frame.operationId)
        pending.resolve(frame.path)
        return
      }
      case 'path/result': {
        const pending = this.nativePaths.get(frame.operationId)
        if (pending === undefined) return
        this.nativePaths.delete(frame.operationId)
        if (frame.outcome === 'opened') pending.resolve()
        else pending.reject(new Error(frame.message ?? '无法使用系统应用打开该路径'))
        return
      }
      case 'export/start':
        this.startExport(frame.operationId, frame.sessionId, frame.targetPath)
        return
      case 'export/cancel':
        this.exports.get(frame.operationId)?.abort.abort(new DOMException('用户取消导出', 'AbortError'))
        return
      case 'host/hello':
      case 'host/shutdown':
        throw new Error(`Utility 控制器收到阶段错误的 ${frame.type}`)
      default:
        return assertNever(frame)
    }
  }

  /** 拒绝新工作并清理当前代际的全部端口与操作。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('Desktop Utility 已关闭')
    for (const pending of this.directories.values()) pending.reject(error)
    this.directories.clear()
    for (const pending of this.nativePaths.values()) pending.reject(error)
    this.nativePaths.clear()
    const exports = [...this.exports.values()]
    for (const operation of exports) operation.abort.abort(error)
    await Promise.allSettled(exports.map(operation => operation.done))
    await Promise.all([...this.bridges].map(bridge => bridge.close(error)))
    this.bridges.clear()
  }

  private attachDataPort(port: Electron.MessagePortMain): void {
    const ctx = this.ctx
    if (ctx === undefined) throw new Error('Desktop Utility 尚未完成 Host 启动')
    const bridge = new IpcHostBridge(new ElectronUtilityPortAdapter(port), {
      generation: this.generation,
      maxInFlightRequests: this.config.maxInFlightRequests,
      maxRequestBodyBytes: this.config.maxRequestBodyBytes,
      dispatch: request => ctx.connection.dispatch(request, { authority: 'local' }),
    })
    this.bridges.add(bridge)
    void bridge.closed.then(() => { this.bridges.delete(bridge) })
  }

  private startExport(operationId: string, sessionId: string, targetPath: string): void {
    if (this.exports.has(operationId)) {
      this.send({
        type: 'export/result', generation: this.generation, operationId,
        outcome: 'failed', message: '导出操作 id 重复',
      })
      return
    }
    const abort = new AbortController()
    const operation: ExportOperation = {
      abort,
      done: this.runExport(operationId, sessionId, targetPath, abort.signal).finally(() => {
        if (this.exports.get(operationId) === operation) this.exports.delete(operationId)
      }),
    }
    this.exports.set(operationId, operation)
  }

  private async runExport(
    operationId: string,
    sessionId: string,
    targetPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const ctx = this.ctx
    if (ctx === undefined) throw new Error('Desktop Utility 尚未完成 Host 启动')
    try {
      const url = new URL('/api/session.export', 'http://dsh.internal')
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'true')
      const response = await ctx.connection.dispatch(new Request(url, { method: 'GET', signal }), { authority: 'local' })
      await writeAtomicResponse(response, targetPath, signal, (bytes) => {
        this.send({ type: 'export/progress', generation: this.generation, operationId, bytes })
      })
      this.send({ type: 'export/result', generation: this.generation, operationId, outcome: 'saved' })
    } catch {
      this.send({
        type: 'export/result', generation: this.generation, operationId,
        outcome: signal.aborted ? 'cancelled' : 'failed',
        ...(signal.aborted ? {} : { message: 'Session ZIP 导出失败，请检查目标磁盘后重试' }),
      })
    }
  }
}

function assertNever(frame: never): never {
  throw new Error(`Utility 收到未处理的控制帧：${JSON.stringify(frame)}`)
}

/** 把不受类型保证的取消原因收敛为 Error。 */
function errorReason(reason: unknown, fallback: Error): Error {
  return reason instanceof Error ? reason : fallback
}
