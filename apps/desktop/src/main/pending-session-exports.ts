import type { RendererCommandResult } from '../shared/renderer-protocol.ts'

type SessionExportResult = Extract<RendererCommandResult, { type: 'session-log/result' }>
type ExportPhase = 'selecting' | 'running'

/** Main 侧一次 Session 导出的稳定身份与结果。 */
export interface PendingSessionExport {
  readonly operationId: string
  readonly generation: number
  readonly ownerId: number
  readonly result: Promise<SessionExportResult>
}

interface MutableSessionExport extends PendingSessionExport {
  phase: ExportPhase
  cancelled: boolean
  resolve(result: SessionExportResult): void
}

/**
 * 统一管理原生保存对话框与 Utility 导出之间的竞态。
 * 操作在对话框打开前预留，结算只接受仍为当前值的同一对象。
 */
export class PendingSessionExports {
  private readonly pending = new Map<string, MutableSessionExport>()

  /** 预留操作 id；已被占用时返回 undefined。 */
  reserve(operationId: string, generation: number, ownerId: number): PendingSessionExport | undefined {
    if (this.pending.has(operationId)) return undefined
    let resolve!: (result: SessionExportResult) => void
    const result = new Promise<SessionExportResult>((settle) => { resolve = settle })
    const pending: MutableSessionExport = {
      operationId, generation, ownerId, result, resolve,
      phase: 'selecting', cancelled: false,
    }
    this.pending.set(operationId, pending)
    return pending
  }

  /**
   * 取消所属操作。选择路径阶段立即结算；运行阶段要求调用方转发给 Utility。
   */
  cancel(
    operationId: string,
    ownerId: number,
  ): { accepted: boolean; forward: boolean; generation: number | undefined } {
    const pending = this.pending.get(operationId)
    if (pending === undefined || pending.ownerId !== ownerId) {
      return { accepted: false, forward: false, generation: undefined }
    }
    pending.cancelled = true
    if (pending.phase === 'running') {
      return { accepted: true, forward: true, generation: pending.generation }
    }
    this.finish(pending, {
      type: 'session-log/result', operationId, outcome: 'cancelled',
    })
    return { accepted: true, forward: false, generation: pending.generation }
  }

  /** 原生对话框完成后，只有仍有效且未取消的预留才能进入运行阶段。 */
  markRunning(exportOperation: PendingSessionExport): boolean {
    const pending = this.mutableCurrent(exportOperation)
    if (pending === undefined || pending.cancelled || pending.phase !== 'selecting') return false
    pending.phase = 'running'
    return true
  }

  /** 判断异步对话框返回时该预留是否仍属于当前操作。 */
  isCurrent(exportOperation: PendingSessionExport): boolean {
    return this.mutableCurrent(exportOperation) !== undefined
  }

  /** 按预留身份结算，防止迟到结果覆盖复用后的相同 operation id。 */
  settle(exportOperation: PendingSessionExport, result: SessionExportResult): boolean {
    const pending = this.mutableCurrent(exportOperation)
    if (pending === undefined) return false
    this.finish(pending, result)
    return true
  }

  /** 按 Utility 返回的 operation id 与 generation 结算运行中操作。 */
  settleRunning(operationId: string, generation: number, result: SessionExportResult): boolean {
    const pending = this.pending.get(operationId)
    if (pending === undefined || pending.generation !== generation || pending.phase !== 'running') return false
    this.finish(pending, result)
    return true
  }

  /** 关停或代际切换时确定性结算该代际的全部请求。 */
  failGeneration(generation: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.generation !== generation) continue
      this.finish(pending, {
        type: 'session-log/result', operationId: pending.operationId,
        outcome: 'failed', message: '本地运行时已停止，导出结果未知',
      })
    }
  }

  private mutableCurrent(exportOperation: PendingSessionExport): MutableSessionExport | undefined {
    const pending = this.pending.get(exportOperation.operationId)
    return pending === exportOperation ? pending : undefined
  }

  private finish(pending: MutableSessionExport, result: SessionExportResult): void {
    if (this.pending.get(pending.operationId) !== pending) return
    this.pending.delete(pending.operationId)
    pending.resolve(result)
  }
}
