import { describe, expect, it } from 'vitest'
import {
  parseDesktopBootstrap,
  parseRendererCommand,
  parseRendererCommandResult,
} from '../src/shared/renderer-protocol.ts'

describe('Desktop Renderer bridge protocol', () => {
  it('只向 Renderer 暴露不含本机路径的启动清单', () => {
    const manifest = {
      protocolVersion: 1,
      generation: 2,
      nonce: 'n'.repeat(32),
      appVersion: '0.1.0',
      boot: { rev: 'r1', entries: [{ id: 'x', url: '/plugins/x/client.js?rev=1', rev: '1' }] },
    }
    expect(parseDesktopBootstrap(manifest)).toEqual(manifest)
    expect(() => parseDesktopBootstrap({ ...manifest, sourcePath: '/private/plugin.js' })).toThrow()
  })

  it('严格校验 Renderer 可发起的窄命令', () => {
    expect(parseRendererCommand({
      type: 'session-log/save', operationId: 'op-1', sessionId: 's-1', suggestedName: 'session.zip',
    })).toMatchObject({ type: 'session-log/save' })
    expect(() => parseRendererCommand({
      type: 'session-log/save', operationId: 'op-1', sessionId: 's-1',
      suggestedName: '../escape.zip',
    })).toThrow()
    expect(() => parseRendererCommand({ type: 'host/retry', extra: true })).toThrow()
    expect(parseRendererCommand({ type: 'renderer/ready', generation: 3 })).toEqual({
      type: 'renderer/ready', generation: 3,
    })
    expect(parseRendererCommand({
      type: 'renderer/failed', generation: 3, message: 'GUI 启动失败',
    })).toMatchObject({ type: 'renderer/failed' })
    expect(parseRendererCommand({ type: 'update/check' })).toEqual({ type: 'update/check' })
    expect(parseRendererCommand({ type: 'update/install' })).toEqual({ type: 'update/install' })
    expect(parseRendererCommand({ type: 'diagnostics/export', operationId: 'diagnostics-1' }))
      .toEqual({ type: 'diagnostics/export', operationId: 'diagnostics-1' })
  })

  it('只接受不泄露本机路径的闭合命令结果', () => {
    expect(parseRendererCommandResult({
      type: 'session-log/result',
      operationId: 'export-1',
      outcome: 'saved',
    })).toEqual({
      type: 'session-log/result',
      operationId: 'export-1',
      outcome: 'saved',
    })
    expect(parseRendererCommandResult({
      type: 'update/action-result', action: 'check', outcome: 'accepted',
    })).toEqual({ type: 'update/action-result', action: 'check', outcome: 'accepted' })
    expect(parseRendererCommandResult({
      type: 'host/retry-result',
      outcome: 'accepted',
    })).toEqual({
      type: 'host/retry-result',
      outcome: 'accepted',
    })
    expect(parseRendererCommandResult({
      type: 'renderer/status-result',
      outcome: 'accepted',
    })).toEqual({
      type: 'renderer/status-result',
      outcome: 'accepted',
    })
    expect(() => parseRendererCommandResult({
      type: 'session-log/result',
      operationId: 'export-1',
      outcome: 'saved',
      path: '/tmp/private.zip',
    })).toThrow()
  })
})
