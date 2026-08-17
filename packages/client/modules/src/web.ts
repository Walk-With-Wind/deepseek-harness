/** WebServer 资源 route 与 HTML boot manifest 注入 adapter。 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebBootGraph } from './client/manifest.ts'
import type { ClientModuleRegistry } from './index.ts'

/** Web adapter 的稳定 Cordis 插件名。 */
export const name = 'client-modules-web'

/** Web adapter 只消费 WebServer 与模块注册 core。 */
export const inject = ['webServer', 'clientModules']

/**
 * 把启动图注入 index.html 的第一个 head script，并转义可结束 script 标签的字符。
 * @param html - Web index 源文本。
 * @param graph - core 生成的启动图。
 * @returns 注入启动图后的 HTML。
 */
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

/**
 * 注册 `/plugins` bundle route 与 index manifest tap。
 * @param ctx - 同时携带 WebServer 与模块注册 core 的 Host 上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugins',
    handler: createBundleHandler(ctx.clientModules),
  }), 'client-modules: Web bundle route')
  ctx.effect(
    () => ctx.webServer.tapIndex(html => injectBootManifest(html, ctx.clientModules.graph())),
    'client-modules: Web boot manifest injection',
  )
}

function createBundleHandler(registry: ClientModuleRegistry) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    const prefix = '/plugins/'
    const mapSuffix = '/client.js.map'
    const bundleSuffix = '/client.js'
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    const clientPath = pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? registry.clientPath(pathname.slice(prefix.length, -suffix.length))
      : undefined
    const path = clientPath === undefined ? undefined : `${clientPath}${isSourceMap ? '.map' : ''}`
    if (path === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      // 已注册但当前不可读时返回明确 404，避免落入 SPA HTML fallback。
      res.writeHead(404)
      res.end()
    }
  }
}
