import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  apply,
  inject,
  type HostConnectionHandle,
} from '../src/index.ts'

function rpcRequest(path: string, method: string, payload: unknown = {}): Request {
  const body: ClientRequest = {
    type: 'client-request',
    rpcId: RpcId(`test-${method}`),
    method,
    payload,
  }
  return new Request(`http://dsh.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function mounted(): Promise<{ connection: HostConnectionHandle; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    connection: ctx.connection,
    dispose: () => fiber.dispose(),
  }
}

describe('Host dispatch core', () => {
  it('不依赖 WebServer 注册并按显式 authority 执行通道策略', async () => {
    const { connection, dispose } = await mounted()
    const handler = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true } }))
    const remove = connection.rpc.handle('/rpc', handler, { authority: 'loopback' })

    const denied = await connection.dispatch(
      rpcRequest('/rpc/jobs/run', 'jobs/run'),
      { authority: 'remote-trusted' },
    )
    expect(denied.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()

    const allowed = await connection.dispatch(
      rpcRequest('/rpc/jobs/run', 'jobs/run', { id: 1 }),
      { authority: 'local' },
    )
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ result: { ok: true, value: { accepted: true } } })
    expect(handler).toHaveBeenCalledWith('jobs/run', { id: 1 }, expect.any(AbortSignal))

    await remove()
    expect((await connection.dispatch(
      rpcRequest('/rpc/jobs/run', 'jobs/run'),
      { authority: 'local' },
    )).status).toBe(404)
    await dispose()
  })

  it('remote-untrusted 在 core 内也始终拒绝，不能依赖 Web adapter 兜底', async () => {
    const { connection, dispose } = await mounted()
    const handler = vi.fn(() => Promise.resolve({ ok: true as const, value: null }))
    connection.rpc.handle('/rpc', handler, { authority: 'trusted-host' })

    const response = await connection.dispatch(
      rpcRequest('/rpc/read', 'read'),
      { authority: 'remote-untrusted' },
    )
    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    await dispose()
  })

  it('调用方取消标准 Request 时同一 AbortSignal 到达业务 handler', async () => {
    const { connection, dispose } = await mounted()
    let dispatchStarted!: () => void
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve })
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve })
    connection.rpc.handle('/rpc', async (_endpoint, _payload, signal) => {
      dispatchStarted()
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          observedAbort()
          resolve()
          return
        }
        signal.addEventListener('abort', () => {
          observedAbort()
          resolve()
        }, { once: true })
      })
      return { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } }
    }, { authority: 'trusted-host' })
    const abort = new AbortController()
    const request = rpcRequest('/rpc/wait', 'wait')
    const pending = connection.dispatch(new Request(request, { signal: abort.signal }), { authority: 'local' })

    await started
    abort.abort()
    await aborted
    expect((await pending).status).toBe(200)
    await dispose()
  })
})
