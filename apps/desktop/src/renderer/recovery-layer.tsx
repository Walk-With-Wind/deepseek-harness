/** 独立于 Utility 与插件图的最小启动/恢复界面。 */
import { useState } from 'react'
import type {
  DesktopRendererApi,
  DesktopUpdateState,
  RendererHostState,
} from '../shared/renderer-protocol.ts'
import styles from './recovery-layer.module.css'

const COPY: Record<RendererHostState['phase'], { title: string; summary: string }> = {
  STARTING: { title: '正在建立本地运行时', summary: '正在校验配置并启动隔离的 Utility Host。' },
  READY: { title: '运行时已就绪', summary: '安全数据通道和界面均已连接。' },
  DEGRADED: { title: '连接暂时不可用', summary: '已停止提交新请求，正在确认当前代际状态。' },
  RECOVERING: { title: '正在恢复运行时', summary: '失效代际已隔离；恢复不会自动重放结果未知的请求。' },
  FAILED: { title: '运行时启动失败', summary: '当前代际已安全停止。你可以检查提示后重新尝试。' },
  CIRCUIT_OPEN: { title: '自动恢复已暂停', summary: '短时间内连续失败，已停止自动重启以避免振荡。' },
  STOPPING: { title: '正在安全退出', summary: '正在排空请求、释放资源并关闭本地 Host。' },
}

interface RecoveryLayerProps {
  readonly state: RendererHostState
  readonly api: DesktopRendererApi
}

interface DesktopStatusLayerProps {
  readonly hostState: RendererHostState
  readonly updateState: DesktopUpdateState | undefined
  readonly api: DesktopRendererApi
}

function stepClass(kind: 'pending' | 'complete' | 'active' | 'failed'): string {
  return `${styles.step} ${styles[kind]}`
}

/** 呈现纵向运行时代际轨迹与唯一的显式恢复动作。 */
export function RecoveryLayer({ state, api }: RecoveryLayerProps): React.JSX.Element | null {
  const [retrying, setRetrying] = useState(false)
  const [exporting, setExporting] = useState(false)
  if (state.phase === 'READY') return null
  const copy = COPY[state.phase]
  const isFailure = state.phase === 'FAILED' || state.phase === 'CIRCUIT_OPEN'
  const hostStep = state.phase === 'STARTING' ? 'active' : isFailure ? 'failed' : 'complete'
  const channelStep = state.phase === 'DEGRADED' || state.phase === 'RECOVERING'
    ? 'active'
    : isFailure ? 'pending' : state.phase === 'STOPPING' ? 'complete' : 'pending'

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await api.invoke({ type: 'host/retry' })
    } finally {
      setRetrying(false)
    }
  }

  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true)
    try {
      await api.invoke({ type: 'diagnostics/export', operationId: crypto.randomUUID() })
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className={styles.layer} aria-live="polite" aria-busy={!isFailure}>
      <div className={styles.panel}>
        <p className={styles.eyebrow}>DeepSeek Harness Desktop</p>
        <h1 className={styles.title}>{copy.title}</h1>
        <p className={styles.summary}>{copy.summary}</p>

        <ol className={styles.trace} aria-label="运行时启动轨迹">
          <li className={stepClass('complete')}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.stepLabel}>桌面宿主</span>
            <span className={styles.stepMeta}>verified</span>
          </li>
          <li className={stepClass(hostStep)}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.stepLabel}>Utility Host</span>
            <span className={styles.stepMeta}>{`gen ${state.generation || '—'}`}</span>
          </li>
          <li className={stepClass(channelStep)}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.stepLabel}>安全数据通道</span>
            <span className={styles.stepMeta}>{state.phase.toLowerCase()}</span>
          </li>
          <li className={stepClass('pending')}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.stepLabel}>产品界面</span>
            <span className={styles.stepMeta}>waiting</span>
          </li>
        </ol>

        {state.message === undefined ? null : (
          <p className={styles.detail}>
            {state.code === undefined ? state.message : `${state.code}: ${state.message}`}
          </p>
        )}
        {isFailure ? (
          <div className={styles.actions}>
            <button className={styles.retry} type="button" disabled={retrying} onClick={() => { void retry() }}>
              {retrying ? '正在重试…' : '重新启动运行时'}
            </button>
            <button className={styles.secondaryAction} type="button" disabled={exporting} onClick={() => { void exportDiagnostics() }}>
              {exporting ? '正在导出…' : '导出诊断包'}
            </button>
            <span className={styles.generation}>{`generation ${state.generation}`}</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** 组合恢复遮罩与非阻塞更新提示，避免更新状态侵入通用 GUI。 */
export function DesktopStatusLayer({ hostState, updateState, api }: DesktopStatusLayerProps): React.JSX.Element {
  return (
    <>
      <RecoveryLayer state={hostState} api={api} />
      {hostState.phase === 'READY' ? <UpdateNotice state={updateState} api={api} /> : null}
    </>
  )
}

function UpdateNotice({
  state,
  api,
}: {
  readonly state: DesktopUpdateState | undefined
  readonly api: DesktopRendererApi
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (state === undefined || state.phase === 'IDLE') return null

  const invoke = async (action: 'check' | 'install'): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke({ type: action === 'check' ? 'update/check' : 'update/install' })
    } finally {
      setBusy(false)
    }
  }

  const content = state.phase === 'CHECKING'
    ? { title: '正在检查更新', detail: '正在读取已签名发行通道。' }
    : state.phase === 'DOWNLOADING'
      ? {
        title: state.targetVersion === undefined ? '正在下载可用更新' : `正在下载 ${state.targetVersion}`,
        detail: '当前工作不受影响，下载完成后由你决定何时安装。',
      }
      : state.phase === 'READY'
        ? { title: `${state.targetVersion} 已准备就绪`, detail: '安装前会先安全排空本地 Host，然后重启应用。' }
        : state.phase === 'INSTALLING'
          ? { title: '正在安全退出并安装', detail: '正在等待会话、日志与本地资源完全静止。' }
          : { title: '更新检查未完成', detail: state.message }

  return (
    <aside className={styles.updateNotice} aria-live="polite">
      <span className={styles.updateMark} aria-hidden="true" />
      <div className={styles.updateCopy}>
        <strong>{content.title}</strong>
        <span>{content.detail}</span>
      </div>
      {state.phase === 'READY' ? (
        <button className={styles.updateAction} type="button" disabled={busy} onClick={() => { void invoke('install') }}>
          {busy ? '准备中…' : '安装并重启'}
        </button>
      ) : state.phase === 'ERROR' && state.retryable ? (
        <button className={styles.updateAction} type="button" disabled={busy} onClick={() => { void invoke('check') }}>
          {busy ? '检查中…' : '重试'}
        </button>
      ) : null}
    </aside>
  )
}
