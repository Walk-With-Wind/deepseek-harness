/** Session ZIP 保存能力，由 Web 或 Desktop 产品 provider 实现。 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** 一次 Session ZIP 保存请求。 */
export interface SessionLogSaveRequest {
  /** 导出树的根 Session。 */
  readonly sessionId: SessionId
  /** 产品保存界面使用的安全建议文件名。 */
  readonly suggestedName: string
  /** UI 生命周期或关停触发的取消信号。 */
  readonly signal: AbortSignal
}

/** 保存操作的明确结算状态。 */
export type SessionLogSaveOutcome = 'saved' | 'cancelled'

/** 平台保存 Session ZIP 的能力接口。 */
export interface SessionLogSaver {
  /**
   * 保存 Host 生成的 Session ZIP。
   * @param request - Session、建议文件名与取消信号。
   * @returns 用户确认保存或主动取消；失败通过 rejection 报告。
   */
  save(request: SessionLogSaveRequest): Promise<SessionLogSaveOutcome>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前 GUI 产品提供的 Session ZIP 保存能力。 */
    sessionLogSaver: SessionLogSaver
  }
}
