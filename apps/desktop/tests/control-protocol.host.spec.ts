import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_CONFIG,
  parseDesktopConfig,
  parseMainControlFrame,
  parseUtilityControlFrame,
} from '../src/shared/control-protocol.ts'

describe('Desktop control protocol', () => {
  it('严格校验配置范围与未知字段', () => {
    expect(parseDesktopConfig({})).toEqual(DEFAULT_DESKTOP_CONFIG)
    expect(() => parseDesktopConfig({ bootTimeoutMs: 4999 })).toThrow()
    expect(() => parseDesktopConfig({ unknown: true })).toThrow()
    expect(() => parseDesktopConfig({ restartBaseDelayMs: 2000, restartMaxDelayMs: 1000 })).toThrow()
    expect(() => parseDesktopConfig({ restartBaseDelayMs: 1000, restartJitterMs: 1001 })).toThrow()
  })

  it('拒绝错误方向、旧协议与额外字段', () => {
    const hello = {
      type: 'host/hello',
      protocolVersion: 1,
      generation: 2,
      appVersion: '0.1.0',
      homeKey: 'a'.repeat(64),
      config: DEFAULT_DESKTOP_CONFIG,
    }
    expect(parseMainControlFrame(hello)).toEqual(hello)
    expect(() => parseMainControlFrame({ ...hello, protocolVersion: 2 })).toThrow()
    expect(() => parseMainControlFrame({ ...hello, extra: true })).toThrow()
    expect(() => parseUtilityControlFrame(hello)).toThrow()
  })

  it('对 ready 清单和文件操作消息执行深层严格校验', () => {
    const ready = {
      type: 'host/ready',
      protocolVersion: 1,
      generation: 3,
      appVersion: '0.1.0',
      resources: { version: 1, rev: 'abc', resources: [] },
      boot: { rev: 'abc', entries: [] },
    }
    expect(parseUtilityControlFrame(ready)).toEqual(ready)
    expect(() => parseUtilityControlFrame({
      ...ready,
      boot: { rev: 'abc', entries: [{ id: 'x', url: '/x', rev: '1', extra: true }] },
    })).toThrow()
    expect(() => parseMainControlFrame({
      type: 'export/start', generation: 3, operationId: 'op', sessionId: 's', targetPath: 'relative.zip',
    })).toThrow()
  })

  it('只接受带绝对路径和闭合 intent 的原生路径操作帧', () => {
    const open = {
      type: 'path/open', generation: 3, operationId: 'path-1',
      path: '/workspace/file.txt', intent: 'default',
    }
    expect(parseUtilityControlFrame(open)).toEqual(open)
    expect(parseUtilityControlFrame({
      type: 'path/cancel', generation: 3, operationId: 'path-1',
    })).toEqual({ type: 'path/cancel', generation: 3, operationId: 'path-1' })
    expect(parseMainControlFrame({
      type: 'path/result', generation: 3, operationId: 'path-1', outcome: 'opened',
    })).toEqual({ type: 'path/result', generation: 3, operationId: 'path-1', outcome: 'opened' })
    expect(() => parseUtilityControlFrame({ ...open, path: 'relative.txt' })).toThrow()
    expect(() => parseUtilityControlFrame({ ...open, intent: 'shell' })).toThrow()
  })
})
