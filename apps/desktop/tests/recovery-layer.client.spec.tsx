// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRendererApi, RendererHostState } from '../src/shared/renderer-protocol.ts'
import type { DesktopUpdateState } from '../src/shared/update-protocol.ts'
import { DesktopStatusLayer, RecoveryLayer } from '../src/renderer/recovery-layer.tsx'

function rendererApi(): { readonly api: DesktopRendererApi; readonly invoke: ReturnType<typeof vi.fn<DesktopRendererApi['invoke']>> } {
  const invoke = vi.fn<DesktopRendererApi['invoke']>(async (command) => {
    if (command.type === 'host/retry') return { type: 'host/retry-result', outcome: 'accepted' }
    if (command.type === 'update/check' || command.type === 'update/install') {
      return { type: 'update/action-result', action: command.type === 'update/check' ? 'check' : 'install', outcome: 'accepted' }
    }
    if (command.type === 'diagnostics/export') {
      return { type: 'diagnostics/result', operationId: command.operationId, outcome: 'saved' }
    }
    throw new Error(`快照不执行命令 ${command.type}`)
  })
  return { api: {
    bootstrap: () => Promise.reject(new Error('快照不启动 Renderer')),
    releaseDataPort: () => {},
    invoke,
    onHostState: () => () => {},
    onUpdateState: () => () => {},
  }, invoke }
}

function hostState(
  phase: RendererHostState['phase'],
  extra: Partial<RendererHostState> = {},
): RendererHostState {
  return { phase, generation: 4, ...extra }
}

afterEach(cleanup)

describe('Desktop recovery and update presentation', () => {
  it.each([
    hostState('STARTING'),
    hostState('DEGRADED'),
    hostState('RECOVERING'),
    hostState('FAILED', { code: 'HOST_LEASE_BUSY', message: '另一个 Harness Host 正在使用此 home。' }),
    hostState('CIRCUIT_OPEN', { code: 'HOST_RESTART_BUDGET_EXHAUSTED', message: '自动恢复已暂停。' }),
    hostState('STOPPING'),
  ])('固定 %s 恢复层的语义和可见文案', (state) => {
    const view = render(<RecoveryLayer state={state} api={rendererApi().api} />)
    expect(view.container).toMatchSnapshot()
  })

  it.each<DesktopUpdateState>([
    { phase: 'CHECKING', channel: 'canary', currentVersion: '0.1.0-rc.5' },
    { phase: 'DOWNLOADING', channel: 'canary', currentVersion: '0.1.0-rc.5', targetVersion: '0.1.0-rc.6' },
    { phase: 'READY', channel: 'canary', currentVersion: '0.1.0-rc.5', targetVersion: '0.1.0-rc.6' },
    { phase: 'ERROR', channel: 'canary', currentVersion: '0.1.0-rc.5', code: 'UPDATE_CHECK_START_FAILED', message: '暂时无法完成更新检查，请稍后重试。', retryable: true },
  ])('固定 $phase 更新提示的非阻塞呈现', (updateState) => {
    const view = render(<DesktopStatusLayer hostState={hostState('READY')} updateState={updateState} api={rendererApi().api} />)
    expect(view.container).toMatchSnapshot()
  })

  it('恢复与更新按钮只发送闭合协议动作', async () => {
    const { api, invoke } = rendererApi()
    const failed = render(<RecoveryLayer state={hostState('FAILED')} api={api} />)
    fireEvent.click(failed.getByRole('button', { name: '重新启动运行时' }))
    fireEvent.click(failed.getByRole('button', { name: '导出诊断包' }))
    await waitFor(() => { expect(invoke).toHaveBeenCalledTimes(2) })
    expect(invoke).toHaveBeenNthCalledWith(1, { type: 'host/retry' })
    expect(invoke).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'diagnostics/export' }))
    failed.unmount()

    const update = render(<DesktopStatusLayer hostState={hostState('READY')} updateState={{
      phase: 'READY', channel: 'canary', currentVersion: '0.1.0-rc.5', targetVersion: '0.1.0-rc.6',
    }} api={api} />)
    fireEvent.click(update.getByRole('button', { name: '安装并重启' }))
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith({ type: 'update/install' }) })
  })
})
