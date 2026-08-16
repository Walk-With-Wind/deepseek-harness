/** 客户端通用 Connection 一元 RPC 调用器。 */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'
import { randomUuid } from './random-uuid.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * 使用显式 Fetch 实现创建通用 RPC 调用器。
 * @param fetcher - 产品载体提供的 Fetch 实现。
 * @param baseUrl - 逻辑请求基址或逐调用解析器；IPC 载体可保留默认内部地址。
 * @returns 持有请求关联和响应信封校验的调用器。
 */
export function createConnectionRpc(
  fetcher: (input: URL | Request, init?: RequestInit) => Promise<Response>,
  baseUrl: string | (() => string) = INTERNAL_BASE,
): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await fetcher(
        new URL(`${channel}/${endpoint}`, typeof baseUrl === 'function' ? baseUrl() : baseUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/**
 * 为现有浏览器调用方保留的薄适配器。
 * @returns 使用当前页面 origin 与全局 Fetch 的 RPC 调用器。
 */
export function createWebConnectionRpc(): ClientConnectionRpc {
  return createConnectionRpc((input, init) => globalThis.fetch(input, init), resolveWebBase)
}

function resolveWebBase(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
