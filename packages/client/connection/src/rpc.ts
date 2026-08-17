/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Host dispatch 已在物理 adapter 处判定的调用权限来源。 */
export type HostDispatchAuthority = 'local' | 'remote-trusted' | 'remote-untrusted'

/** 标准 Request 进入 Host core 时携带的显式权限事实。 */
export interface HostDispatchContext {
  /** 权限由端口或 Web authority adapter 判定，不读取 Renderer 可伪造字段。 */
  readonly authority: HostDispatchAuthority
}

/** 物理 Host adapter 对动态逻辑通道的注册接口。 */
export interface HostConnectionAdapter {
  /**
   * 暴露一个逻辑通道的物理入口。
   * @param channel - 已通过 core 校验的绝对通道前缀。
   * @returns 删除物理入口的同步 disposer。
   */
  registerChannel(channel: string): () => void
}

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /**
   * 在无物理传输假设的 core 中分发标准 Fetch 请求。
   * @param request - adapter 构造并拥有取消信号的请求。
   * @param context - adapter 判定的权限来源。
   * @returns 标准业务或 carrier Response。
   */
  dispatch(request: Request, context: HostDispatchContext): Promise<Response>
  /**
   * 挂载一个物理 adapter，并同步投影现有及后续逻辑通道。
   * @param adapter - WebServer 或其他物理入口实现。
   * @returns 删除该 adapter 全部物理入口的 disposer。
   */
  attachAdapter(adapter: HostConnectionAdapter): () => void
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
