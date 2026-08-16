/** Desktop Session ZIP 保存适配器；路径选择与文件写入始终留在受信进程。 */
import type {
  SessionLogSaveOutcome,
  SessionLogSaveRequest,
  SessionLogSaver,
} from '@deepseek-ai/dsh-session-log-export/client'
import type { DesktopRendererApi } from '../shared/renderer-protocol.ts'

/** 通过 preload 窄命令实现桌面 Session ZIP 保存能力。 */
export class DesktopSessionLogSaver implements SessionLogSaver {
  /**
   * @param api - contextBridge 暴露的冻结 API。
   * @param createOperationId - 生成单次操作 id；测试可提供确定值。
   */
  constructor(
    private readonly api: DesktopRendererApi,
    private readonly createOperationId: () => string = () => crypto.randomUUID(),
  ) {}

  /** @inheritdoc */
  async save(request: SessionLogSaveRequest): Promise<SessionLogSaveOutcome> {
    if (request.signal.aborted) return 'cancelled'
    const operationId = this.createOperationId()
    const notifyCancellation = (): void => {
      void this.api.invoke({ type: 'operation/cancel', operationId }).catch(() => {
        // 取消通知是尽力而为；原保存命令的结算结果仍是唯一权威。
      })
    }
    request.signal.addEventListener('abort', notifyCancellation, { once: true })
    try {
      const result = await this.api.invoke({
        type: 'session-log/save',
        operationId,
        sessionId: request.sessionId,
        suggestedName: request.suggestedName,
      })
      if (result.type !== 'session-log/result' || result.operationId !== operationId) {
        throw new Error('Desktop 保存命令返回了不匹配的操作结果')
      }
      if (result.outcome === 'failed') {
        throw new Error(result.message ?? 'Session ZIP 保存失败')
      }
      return result.outcome
    } finally {
      request.signal.removeEventListener('abort', notifyCancellation)
    }
  }
}
