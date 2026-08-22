/**
 * GUI Connection Host core。根插件只提供标准 Request/Response 分发和逻辑 RPC 注册表；
 * WebServer、Host/Origin 与 WebSocket 由 `@deepseek-ai/dsh-client-connection/web` 适配器拥有。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from './host/dispatch.ts'

export type {
  ClientConnectionRpc,
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionAdapter,
  HostConnectionRpc,
  HostDispatchAuthority,
  HostDispatchContext,
} from './rpc.ts'
export { HostConnectionService } from './host/dispatch.ts'
export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** 稳定 Cordis 插件名。 */
export const name = 'client-connection'

/** Host core 没有物理载体依赖。 */
export const inject: readonly string[] = []

/**
 * 提供进程中立 Host Connection 服务。
 * @param ctx - Host Cordis 上下文。
 */
export function apply(ctx: Context): void {
  new HostConnectionService(ctx)
}
