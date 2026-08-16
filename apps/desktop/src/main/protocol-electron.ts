/** `app://localhost` 纯映射在 Electron protocol API 上的薄适配。 */
import { readFile } from 'node:fs/promises'
import { protocol, session } from 'electron'
import { DESKTOP_CSP, DesktopResourceMap, parseAppResourceRequest } from './protocol.ts'

/** 必须在 Electron ready 前注册 custom scheme 权限。 */
export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  }])
}

/** 安装精确资源 handler 和默认拒绝的 Chromium 权限策略。 */
export function installDesktopProtocol(resources: DesktopResourceMap): () => void {
  protocol.handle('app', async (request) => {
    try {
      const parsed = parseAppResourceRequest(request.url, request.method)
      const path = resources.resolve(parsed.pathname)
      const mime = resources.mime(parsed.pathname)
      const body = parsed.head ? null : await readFile(path)
      const headers = desktopHeaders(parsed.pathname, mime)
      if (body !== null) headers.set('content-length', String(body.byteLength))
      return new Response(body, { status: 200, headers })
    } catch {
      return new Response('Not found', {
        status: request.method === 'GET' || request.method === 'HEAD' ? 404 : 405,
        headers: desktopHeaders('/error.txt', 'text/plain; charset=utf-8'),
      })
    }
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  session.defaultSession.setDevicePermissionHandler(() => false)
  return () => { protocol.unhandle('app') }
}

function desktopHeaders(pathname: string, mime: string): Headers {
  return new Headers({
    'cache-control': pathname === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'content-security-policy': DESKTOP_CSP,
    'content-type': mime,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
}
