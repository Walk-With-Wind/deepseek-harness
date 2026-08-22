/** WebServer resource route and HTML boot-manifest injection adapter. */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { injectBootManifest, type ClientModuleRegistry } from './index.ts'

/** Stable Cordis plugin name for the Web adapter. */
export const name = 'client-modules-web'

/** The Web adapter consumes only WebServer and the module-registry core. */
export const inject = ['webServer', 'clientModules']

/**
 * Register the `/plugins` bundle route and index-manifest tap.
 * @param ctx - Host context carrying WebServer and the module-registry core.
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
      // Return an explicit 404 for an unreadable registration so SPA HTML cannot become JavaScript.
      res.writeHead(404)
      res.end()
    }
  }
}
