/**
 * 客户端载体约定：业务 API、通用 RPC 与事件下行都只依赖显式注入的传输实现。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CarrierApiClient,
  createConnectionRpc,
  type ClientCarrier,
  type DownlinkKind,
} from '../src/client/index.ts'

function responseBody(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function memoryCarrier(): ClientCarrier & {
  readonly fetches: string[]
  readonly downlinks: DownlinkKind[]
} {
  const fetches: string[] = []
  const downlinks: DownlinkKind[] = []
  return {
    authority: 'local',
    baseUrl: 'http://dsh.internal',
    fetches,
    downlinks,
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init)
      fetches.push(request.url)
      const body = await request.json() as { rpcId: string }
      return responseBody({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: { version: 'test', cwd: '/workspace', attachedSessions: 0, canOpenPath: false },
        },
      })
    },
    async *connectDownlink(kind, _signal, onOpen) {
      downlinks.push(kind)
      onOpen?.()
      yield new TextEncoder().encode(JSON.stringify({
        type: 'server-request',
        rpcId: `${kind}-1`,
        method: kind === 'mux' ? 'session/subscribed' : 'host/remote-event',
        payload: kind === 'mux'
          ? { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 }
          : { type: 'host/remote-event', event: 'commands/change', args: [] },
      }))
    },
    close: vi.fn(() => Promise.resolve()),
  }
}

describe('ClientCarrier', () => {
  it('drives unary API and typed downlinks without reading browser globals', async () => {
    const carrier = memoryCarrier()
    const client = new CarrierApiClient(carrier)
    await expect(client.host.describe({})).resolves.toMatchObject({
      result: { ok: true, value: { canOpenPath: false } },
    })

    const abort = new AbortController()
    const opened = vi.fn()
    const mux = client.events.mux({}, abort.signal, opened)[Symbol.asyncIterator]()
    await expect(mux.next()).resolves.toMatchObject({
      value: { rpcId: 'mux-1', payload: { type: 'session/subscribed' } },
    })
    expect(opened).toHaveBeenCalledOnce()
    expect(carrier.fetches).toEqual(['http://dsh.internal/api/host.describe'])
    expect(carrier.downlinks).toEqual(['mux'])
  })

  it('creates generic RPC calls from the supplied fetch implementation', async () => {
    const carrier = memoryCarrier()
    const rpc = createConnectionRpc(carrier.fetch.bind(carrier))
    await expect(rpc.call('/api', 'goals/create', {})).resolves.toEqual({
      ok: true,
      value: { version: 'test', cwd: '/workspace', attachedSessions: 0, canOpenPath: false },
    })
    expect(carrier.fetches).toEqual(['http://dsh.internal/api/goals/create'])
  })
})
