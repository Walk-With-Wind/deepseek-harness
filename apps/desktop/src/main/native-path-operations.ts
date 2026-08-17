/** Main 进程原生路径操作 registry：一次性 id、取消与代际清理集中在此。 */
import type { DesktopPathOpenIntent, MainControlFrame } from '../shared/control-protocol.ts'

interface DesktopPathOpenRequest {
  readonly generation: number
  readonly operationId: string
  readonly path: string
  readonly intent: DesktopPathOpenIntent
}

interface DesktopNativePathOpeners {
  readonly openDefault: (path: string, signal: AbortSignal) => Promise<void>
  readonly openTextFile: (path: string, signal: AbortSignal) => Promise<void>
}

interface PendingNativePath {
  readonly generation: number
  readonly abort: AbortController
}

type PathResultFrame = Extract<MainControlFrame, { type: 'path/result' }>

/** Main 当前进程持有的原生路径操作集合。 */
export class DesktopNativePathOperations {
  private readonly pending = new Map<string, PendingNativePath>()

  /** @param openers - 不经过 shell 字符串拼接的跨平台原生打开器。 */
  constructor(private readonly openers: DesktopNativePathOpeners) {}

  /** 执行一次路径打开；只有仍为当前项的操作才回送结果。 */
  async open(request: DesktopPathOpenRequest, send: (frame: PathResultFrame) => void): Promise<void> {
    const duplicate = this.pending.get(request.operationId)
    if (duplicate !== undefined) {
      this.pending.delete(request.operationId)
      duplicate.abort.abort(new Error('路径操作 id 重复'))
      send({
        type: 'path/result', generation: request.generation, operationId: request.operationId,
        outcome: 'failed', message: '路径操作 id 重复',
      })
      return
    }
    const operation: PendingNativePath = {
      generation: request.generation,
      abort: new AbortController(),
    }
    this.pending.set(request.operationId, operation)
    try {
      const open = request.intent === 'text-editor' ? this.openers.openTextFile : this.openers.openDefault
      await open(request.path, operation.abort.signal)
      if (this.pending.get(request.operationId) !== operation) return
      send({
        type: 'path/result', generation: request.generation, operationId: request.operationId,
        outcome: 'opened',
      })
    } catch {
      if (this.pending.get(request.operationId) !== operation) return
      send({
        type: 'path/result', generation: request.generation, operationId: request.operationId,
        outcome: 'failed', message: '无法使用系统应用打开该路径',
      })
    } finally {
      if (this.pending.get(request.operationId) === operation) this.pending.delete(request.operationId)
    }
  }

  /** 取消一个仍属于指定代际的操作。 */
  cancel(generation: number, operationId: string): void {
    const operation = this.pending.get(operationId)
    if (operation === undefined || operation.generation !== generation) return
    this.pending.delete(operationId)
    operation.abort.abort(new DOMException('路径打开已取消', 'AbortError'))
  }

  /** 终止一个失效 Utility 代际留下的全部原生操作。 */
  failGeneration(generation: number): void {
    for (const [operationId, operation] of this.pending) {
      if (operation.generation !== generation) continue
      this.pending.delete(operationId)
      operation.abort.abort(new Error('Desktop Utility 代际已失效'))
    }
  }
}
