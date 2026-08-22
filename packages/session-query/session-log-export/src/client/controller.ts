/** Session 导出状态，由 Header 按钮与 `/export` 命令共享。 */

import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionLogSaver } from './saver.ts'

/** Download phases presented by the shared modal. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'cancelled' | 'error'

/** One Session's current download-dialog state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

const INITIAL: SessionLogDownloadState = { bySession: {} }

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每个 Session 只保留一个在途保存操作，并发布统一 modal 状态。 */
export class SessionLogDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param saver - 当前产品提供的保存能力。
   */
  constructor(private readonly saver: SessionLogSaver) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after the browser save starts, an error state is published, or a late post-disposal request is ignored.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const outcome = await this.saver.save({
        sessionId,
        suggestedName: sessionLogZipFilename(sessionId),
        signal,
      })
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, outcome === 'saved'
        ? { open, status: 'success', error: null }
        : { open: false, status: 'cancelled', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
