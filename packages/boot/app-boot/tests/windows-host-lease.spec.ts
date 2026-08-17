import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsOwnerListener,
  windowsOwnerPipeSddl,
  type WindowsOwnerPipe,
  type WindowsOwnerPipePlatform,
} from '../src/windows-host-lease.ts'

class MemoryPipe implements WindowsOwnerPipe {
  readonly responses: Uint8Array[] = []
  readonly acknowledgements: Array<Promise<void>> = []
  connectCount = 0
  cancelCount = 0
  disconnectCount = 0
  closeCount = 0
  private connectResolve: (() => void) | undefined

  connect(): Promise<void> {
    this.connectCount += 1
    return new Promise((resolve) => { this.connectResolve = resolve })
  }

  accept(): void {
    this.connectResolve?.()
    this.connectResolve = undefined
  }

  async write(payload: Uint8Array): Promise<void> {
    this.responses.push(payload)
  }

  readAcknowledgement(): Promise<void> {
    const acknowledgement = Promise.resolve()
    this.acknowledgements.push(acknowledgement)
    return acknowledgement
  }

  disconnect(): void {
    this.disconnectCount += 1
  }

  cancel(): void {
    this.cancelCount += 1
    this.connectResolve?.()
    this.connectResolve = undefined
  }

  close(): void {
    this.closeCount += 1
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

describe('Windows HostLease owner listener', () => {
  it('在端点创建时仅授权 SYSTEM 与当前用户', () => {
    expect(windowsOwnerPipeSddl('S-1-5-21-1234')).toBe(
      'D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-1234)',
    )
    expect(() => windowsOwnerPipeSddl('not-a-sid')).toThrow('Windows SID')
  })

  it('先以受保护 DACL 创建 pipe，再逐连接回应身份并等待确认', async () => {
    const pipe = new MemoryPipe()
    const create = vi.fn(() => pipe)
    const platform: WindowsOwnerPipePlatform = { create }
    const listener = await createWindowsOwnerListener({
      address: String.raw`\\.\pipe\dsh-host-test`,
      sid: 'S-1-5-21-1234',
      payload: new TextEncoder().encode('{"owner":"desktop"}\n'),
      platform,
    })

    expect(create).toHaveBeenCalledWith(
      String.raw`\\.\pipe\dsh-host-test`,
      'D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-1234)',
    )
    pipe.accept()
    await eventually(() => pipe.responses.length === 1 && pipe.connectCount === 2)
    expect(new TextDecoder().decode(pipe.responses[0])).toBe('{"owner":"desktop"}\n')
    expect(pipe.disconnectCount).toBe(1)

    await listener.release()
    expect(pipe.cancelCount).toBe(1)
    expect(pipe.closeCount).toBe(1)
  })

  it('连接循环异常时关闭所有权句柄并 fail loud', async () => {
    const failure = new Error('pipe failed')
    const close = vi.fn()
    const onFatal = vi.fn()
    const platform: WindowsOwnerPipePlatform = {
      create: () => ({
        connect: () => Promise.reject(failure),
        write: () => Promise.resolve(),
        readAcknowledgement: () => Promise.resolve(),
        disconnect: vi.fn(),
        cancel: vi.fn(),
        close,
      }),
    }
    const listener = await createWindowsOwnerListener({
      address: String.raw`\\.\pipe\dsh-host-test`,
      sid: 'S-1-5-21-1234',
      payload: new Uint8Array([1]),
      platform,
      onFatal,
    })

    await eventually(() => onFatal.mock.calls.length === 1)
    expect(close).toHaveBeenCalledOnce()
    expect(onFatal).toHaveBeenCalledWith(failure)
    await listener.release()
    expect(close).toHaveBeenCalledOnce()
  })
})
