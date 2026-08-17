import { describe, expect, it, vi } from 'vitest'
import { requestSystemSessionEnd } from '../src/main/session-end.ts'

describe('Desktop system session end', () => {
  it('可阻止事件先保留进程并接入统一关停原因', () => {
    const target = { canExit: () => false, stop: vi.fn() }
    const event = { preventDefault: vi.fn() }
    expect(requestSystemSessionEnd(target, event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(target.stop).toHaveBeenCalledWith('操作系统会话结束')
  })

  it('已完成关停或缺少 runtime 时不延迟系统结束', () => {
    const target = { canExit: () => true, stop: vi.fn() }
    const event = { preventDefault: vi.fn() }
    expect(requestSystemSessionEnd(target, event)).toBe(false)
    expect(requestSystemSessionEnd(undefined, event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
