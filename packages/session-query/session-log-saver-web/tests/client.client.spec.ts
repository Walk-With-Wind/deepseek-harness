// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientCarrier } from '@deepseek-ai/dsh-client-connection/client'
import {
  WebSessionLogSaver,
  apply,
  downloadUrl,
} from '../src/client/index.ts'

const SID = 'web-session-log-saver' as SessionId

afterEach(() => { vi.restoreAllMocks() })

describe('WebSessionLogSaver', () => {
  it('通过显式 carrier HEAD 探测后启动浏览器下载', async () => {
    const fetcher = vi.fn<(
      input: URL | Request, init?: RequestInit,
    ) => Promise<Response>>(() => Promise.resolve(new Response(null, { status: 200 })))
    const saveUrl = vi.fn()
    const saver = new WebSessionLogSaver(fetcher, 'http://dsh.internal', saveUrl)
    const abort = new AbortController()

    await expect(saver.save({ sessionId: SID, suggestedName: 'session.zip', signal: abort.signal }))
      .resolves.toBe('saved')
    const call = fetcher.mock.calls[0]
    expect(call?.[0]).toBeInstanceOf(URL)
    expect((call?.[0] as URL).searchParams.get('sessionId')).toBe(SID)
    expect(call?.[1]).toMatchObject({ method: 'HEAD', signal: abort.signal })
    expect(saveUrl).toHaveBeenCalledWith(
      'http://dsh.internal/api/session.export?sessionId=web-session-log-saver&includeDescendants=true',
      'session.zip',
    )
  })

  it('把 Host 失败转换为 saver rejection，且不启动下载', async () => {
    const saveUrl = vi.fn()
    const saver = new WebSessionLogSaver(
      () => Promise.resolve(new Response('backend unavailable', { status: 503 })),
      'http://dsh.internal',
      saveUrl,
    )
    await expect(saver.save({
      sessionId: SID,
      suggestedName: 'session.zip',
      signal: new AbortController().signal,
    })).rejects.toThrow('Export failed: HTTP 503 backend unavailable')
    expect(saveUrl).not.toHaveBeenCalled()
  })

  it('通过 Cordis service 提供 saver，并保留默认 anchor 行为', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const carrier: ClientCarrier = {
      authority: 'local',
      baseUrl: 'http://dsh.internal',
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
      async *connectDownlink() {},
      close: () => Promise.resolve(),
    }
    const ctx = new Context()
    ctx.provide('clientCarrier', carrier)
    apply(ctx)
    await ctx.sessionLogSaver.save({
      sessionId: SID,
      suggestedName: 'session.zip',
      signal: new AbortController().signal,
    })
    expect(click).toHaveBeenCalledOnce()

    downloadUrl('http://dsh.internal/file', 'manual.zip')
    expect(click).toHaveBeenCalledTimes(2)
  })
})
