/** HTTP/WebSocket 物理载体 adapter；所有浏览器 authority 判断只存在于本文件。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { classifyApiRequest, assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

/** Web adapter 的稳定 Cordis 插件名。 */
export const name = 'client-connection-web'

/** Web adapter 消费 WebServer 和中立 Connection core。 */
export const inject = ['webServer', 'connection']

/** Web 部署的 authority 与请求体资源配置。 */
export interface WebConnectionConfig {
  /** 非 loopback 部署允许服务的规范 authority。 */
  trustedHosts?: string[]
  /** HTTP bridge 缓冲单个请求体的上限。 */
  maxRequestBodyBytes?: number
}

/** Web adapter 配置 schema。 */
export const Config: z<WebConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + 1024 * 1024
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/**
 * 注册 HTTP route 与 WebSocket downlink，并把可信请求交给 Host core。
 * @param ctx - 同时携带 WebServer 与 Connection core 的 Host 上下文。
 * @param config - 已由 schema 解析的 Web authority 配置。
 */
export function apply(ctx: Context, config?: WebConnectionConfig): void {
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)

  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, {
        fetch: (request) => {
          const pathname = new URL(request.url).pathname
          if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
            return Promise.resolve(new Response('upgrade required', {
              status: 426,
              headers: { connection: 'Upgrade', upgrade: 'websocket' },
            }))
          }
          return ctx.connection.dispatch(request, {
            authority: classifyApiRequest(request, trustedHosts),
          })
        },
      }, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: Web /api route')
  ctx.effect(() => ctx.connection.attachAdapter({
    registerChannel: channel => ctx.webServer.register({
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await bridge(req, res, {
          fetch: request => ctx.connection.dispatch(request, {
            authority: classifyApiRequest(request, trustedHosts),
          }),
        }, maxRequestBodyBytes)
      },
    }),
  }), 'client-connection: Web dynamic RPC routes')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (path: string, handle: WebUpgradeRoute['handler']): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
  })
}
