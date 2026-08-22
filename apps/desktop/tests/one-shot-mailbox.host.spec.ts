import { describe, expect, it } from 'vitest'
import { OneShotMailbox } from '../src/shared/one-shot-mailbox.ts'

describe('OneShotMailbox', () => {
  it('值先到时由首次领取方取得，并拒绝重复发布与领取', async () => {
    const mailbox = new OneShotMailbox<string>()
    expect(mailbox.publish('ready')).toBe(true)
    expect(mailbox.publish('duplicate')).toBe(false)
    await expect(mailbox.take()).resolves.toBe('ready')
    await expect(mailbox.take()).rejects.toThrow('已经领取')
  })

  it('领取方先等待时接受随后到达的值', async () => {
    const mailbox = new OneShotMailbox<string>()
    const waiting = mailbox.take()
    expect(mailbox.publish('ready')).toBe(true)
    await expect(waiting).resolves.toBe('ready')
    expect(mailbox.publish('duplicate')).toBe(false)
  })
})
