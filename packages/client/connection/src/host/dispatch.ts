/** 标准 Request/Response Host 分发核心，不依赖 WebServer 或 Electron。 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH } from '../api-path.ts'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionAdapter,
  HostConnectionHandle,
  HostConnectionRpc,
  HostDispatchContext,
} from '../rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** 即使 Web trustedHosts 放行，仍只允许本机访问的方法。 */
const PRIVILEGED_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

interface ConnectionRpcRegistration {
  readonly fetchHandler: (request: Request) => Promise<Response>
  readonly options: ConnectionRpcHandlerOptions
}

interface ConnectionRpcInterceptor extends ConnectionRpcRegistration {
  readonly matches: ConnectionRpcEndpointMatcher
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 物理 adapter 共用的 Host Connection 分发与 RPC 注册表。 */
    connection: HostConnectionHandle
  }
}

/** Host Connection 服务：拥有逻辑注册表、权限策略与 API fallback。 */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly registrations = new Map<string, ConnectionRpcRegistration>()
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly adapters = new Map<HostConnectionAdapter, Map<string, () => void>>()

  /**
   * 提供进程中立 Host Connection core。
   * @param ctx - 拥有注册表生命周期的 Cordis 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  /** 逻辑 RPC 注册按调用方 fiber 自动释放。 */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /** @inheritdoc */
  dispatch(request: Request, context: HostDispatchContext): Promise<Response> {
    if (context.authority === 'remote-untrusted') {
      return Promise.resolve(new Response('forbidden', { status: 403 }))
    }
    const pathname = new URL(request.url).pathname
    const registration = this.registrationFor(pathname)
    if (registration !== undefined) {
      if (!allows(registration.value.options, context)) {
        return Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      return registration.value.fetchHandler(request)
    }
    if (pathname === API_PATH || pathname.startsWith(`${API_PATH}/`)) {
      return this.dispatchApi(request, pathname, context)
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }

  /** @inheritdoc */
  attachAdapter(adapter: HostConnectionAdapter): () => void {
    if (this.adapters.has(adapter)) throw new Error('connection: Host adapter already attached')
    const routes = new Map<string, () => void>()
    try {
      for (const channel of this.registrations.keys()) {
        routes.set(channel, adapter.registerChannel(channel))
      }
    } catch (error) {
      for (const dispose of routes.values()) dispose()
      throw error
    }
    this.adapters.set(adapter, routes)
    return () => {
      if (!this.adapters.delete(adapter)) return
      for (const dispose of routes.values()) dispose()
      routes.clear()
    }
  }

  private dispatchApi(request: Request, pathname: string, context: HostDispatchContext): Promise<Response> {
    const endpoint = endpointFromPath(API_PATH, pathname)
    const interceptor = this.interceptors.get(API_PATH)
    if (endpoint !== undefined && interceptor !== undefined && interceptor.matches(endpoint)) {
      if (!allows(interceptor.options, context)) {
        return Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      return interceptor.fetchHandler(request)
    }
    if (endpoint !== undefined && PRIVILEGED_METHODS.has(endpoint) && context.authority !== 'local') {
      return Promise.resolve(new Response('forbidden', { status: 403 }))
    }
    const apiProxy = this.ctx.get('apiProxy')
    if (apiProxy === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    return toFetchHandler(apiProxy).fetch(request)
  }

  private registrationFor(pathname: string): { channel: string; value: ConnectionRpcRegistration } | undefined {
    for (const [channel, value] of this.registrations) {
      if (pathname === channel || pathname.startsWith(`${channel}/`)) return { channel, value }
    }
    return undefined
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const registration: ConnectionRpcRegistration = {
      fetchHandler: rpcFetchHandler(channel, handler),
      options,
    }
    return owner.effect(() => {
      if (this.registrations.has(channel)) {
        throw new Error(`connection: RPC channel ${JSON.stringify(channel)} already registered`)
      }
      this.registrations.set(channel, registration)
      const routes: Array<readonly [Map<string, () => void>, () => void]> = []
      try {
        for (const [adapter, adapterRoutes] of this.adapters) {
          const dispose = adapter.registerChannel(channel)
          adapterRoutes.set(channel, dispose)
          routes.push([adapterRoutes, dispose])
        }
      } catch (error) {
        this.registrations.delete(channel)
        for (const [adapterRoutes, dispose] of routes) {
          adapterRoutes.delete(channel)
          dispose()
        }
        throw error
      }
      return () => {
        this.registrations.delete(channel)
        for (const adapterRoutes of this.adapters.values()) {
          const dispose = adapterRoutes.get(channel)
          adapterRoutes.delete(channel)
          dispose?.()
        }
      }
    }, `client-connection: ${channel} rpc channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
      options,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => { this.interceptors.delete(channel) }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function allows(options: ConnectionRpcHandlerOptions, context: HostDispatchContext): boolean {
  return options.authority === 'trusted-host' || context.authority === 'local'
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
    if (request.method !== 'POST' || endpoint === undefined) {
      return new Response('not found', { status: 404 })
    }
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const envelope = clientRequestSchema.safeParse(body)
    if (!envelope.success) return invalidEnvelopeResponse(body, envelope.error.issues)
    const message: ClientRequest = envelope.data
    if (message.method !== endpoint) {
      return errorResponse(message.rpcId, {
        code: 'bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] },
      })
    }
    try {
      return fullResponse(message.rpcId, await handler(endpoint, message.payload, request.signal))
    } catch {
      // 业务异常的详细信息只进入所属服务日志，传输响应不暴露本机或凭据细节。
      return new Response('handler failure', { status: 500 })
    }
  }
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: RpcServerResponse['result']): Response {
  const body: RpcServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === API_PATH) {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
