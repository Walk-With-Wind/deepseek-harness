import { describe, expect, it } from 'vitest'
import type { ClientCarrier } from '@deepseek-ai/dsh-client-connection/client'
import {
  DESKTOP_INSTALLED_UNARY_BYTES,
  measureInstalledUnaryLatency,
} from '../src/renderer/installed-unary-latency.ts'

function testCarrier(fetch: ClientCarrier['fetch']): ClientCarrier {
  return {
    authority: 'local',
    baseUrl: 'http://dsh.internal',
    fetch,
    async *connectDownlink() { throw new Error('测试未使用下行流') },
    close: () => Promise.resolve(),
  }
}

describe('installed unary latency acceptance', () => {
  it('发送固定 1 KiB 请求并减去同一 Utility handler 的 p95 耗时', async () => {
    const requests: Request[] = []
    const requestBytes: number[] = []
    const carrier = testCarrier(async (input: URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const body = await request.arrayBuffer()
      requestBytes.push(body.byteLength)
      return new Response(body, {
        headers: { 'x-dsh-acceptance-dispatch-ms': '0.25' },
      })
    })

    const result = await measureInstalledUnaryLatency(carrier, {
      warmupRequests: 2,
      sampleRequests: 4,
      now: (() => {
        let value = 0
        return () => { value += 1; return value }
      })(),
    })

    expect(result).toMatchObject({
      requestBytes: DESKTOP_INSTALLED_UNARY_BYTES,
      responseBytes: DESKTOP_INSTALLED_UNARY_BYTES,
      sampleRequests: 4,
      directDispatchP95Ms: 0.25,
      ipcRoundTripP95Ms: 1,
      extraRoundTripP95Ms: 0.75,
    })
    expect(requests).toHaveLength(6)
    expect(requestBytes).toEqual(Array.from({ length: 6 }, () => DESKTOP_INSTALLED_UNARY_BYTES))
  })

  it('拒绝错误响应容量或缺失 Utility 直连耗时', async () => {
    const badSize = testCarrier(() => Promise.resolve(new Response(new Uint8Array(2), {
      headers: { 'x-dsh-acceptance-dispatch-ms': '0.1' },
    })))
    await expect(measureInstalledUnaryLatency(badSize, {
      warmupRequests: 0, sampleRequests: 1,
    })).rejects.toThrow('响应体不是 1024 字节')

    const missingTiming = testCarrier(() => Promise.resolve(
      new Response(new Uint8Array(DESKTOP_INSTALLED_UNARY_BYTES)),
    ))
    await expect(measureInstalledUnaryLatency(missingTiming, {
      warmupRequests: 0, sampleRequests: 1,
    })).rejects.toThrow('缺少 Utility 直连耗时')
  })
})
