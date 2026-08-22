/** `app://localhost` 的确定资源映射和路径防护。 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import {
  parseClientResourceManifest,
} from '@deepseek-ai/dsh-client-modules'

/** 可由 `app://` 提供的静态 MIME。 */
const DESKTOP_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

/** Renderer 文档的固定 CSP；业务网络只允许 Utility 发起。 */
export const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

/** 已校验的协议请求。 */
export interface AppResourceRequest {
  readonly method: 'GET' | 'HEAD'
  readonly pathname: string
  readonly head: boolean
}

/** 校验 scheme、authority、method 与仍保留编码信息的原始路径。 */
export function parseAppResourceRequest(rawUrl: string, rawMethod: string): AppResourceRequest {
  if (rawMethod !== 'GET' && rawMethod !== 'HEAD') throw new Error('app protocol: method not allowed')
  const authorityStart = 'app://'.length
  const pathStart = rawUrl.indexOf('/', authorityStart)
  const rawPathWithQuery = pathStart === -1 ? '/' : rawUrl.slice(pathStart)
  const rawPath = rawPathWithQuery.split(/[?#]/, 1)[0] ?? ''
  if (/%(?:2f|5c|00)/i.test(rawPath)) throw new Error('app protocol: encoded separator or NUL is not allowed')
  let decodedRawPath: string
  try {
    decodedRawPath = decodeURIComponent(rawPath)
  } catch {
    throw new Error('app protocol: malformed percent encoding')
  }
  if (decodedRawPath.includes('\\') || decodedRawPath.includes('\0')
    || decodedRawPath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('app protocol: path traversal is not allowed')
  }
  const url = new URL(rawUrl)
  if (url.protocol !== 'app:' || url.hostname !== 'localhost' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('app protocol: invalid authority')
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  if (!pathname.startsWith('/') || pathname.includes('\\')) throw new Error('app protocol: invalid path')
  return { method: rawMethod, pathname, head: rawMethod === 'HEAD' }
}

/** 某一 Utility 代际对应的只读核心资源与插件 bundle 映射。 */
export class DesktopResourceMap {
  private readonly rendererRoot: string
  private plugins = new Map<string, string>()
  private rev: string | undefined

  /**
   * @param rendererRoot - 构建后 Renderer 根目录的真实绝对路径。
   */
  constructor(rendererRoot: string) {
    if (!isAbsolute(rendererRoot)) throw new Error('desktop resources: renderer root must be absolute')
    this.rendererRoot = realpathSync(rendererRoot)
  }

  /** 原子校验并替换当前 Utility 代际的插件资源。 */
  replacePlugins(value: unknown): void {
    const manifest = parseClientResourceManifest(value)
    const next = new Map<string, string>()
    for (const resource of manifest.resources) {
      const sourcePath = strictRealFile(resource.sourcePath)
      if (sourcePath !== resource.sourcePath) {
        throw new Error(`desktop resources: plugin ${resource.id} source path is not canonical`)
      }
      next.set(resource.urlPath, sourcePath)
      if (existsSync(resource.sourceMapPath)) {
        const sourceMapPath = strictRealFile(resource.sourceMapPath)
        if (sourceMapPath !== resource.sourceMapPath) {
          throw new Error(`desktop resources: plugin ${resource.id} source map path is not canonical`)
        }
        next.set(`${resource.urlPath}.map`, sourceMapPath)
      }
    }
    this.plugins = next
    this.rev = manifest.rev
  }

  /** 当前已安装的插件资源代际。 */
  revision(): string | undefined {
    return this.rev
  }

  /** 返回不含源路径的诊断摘要。 */
  summary(): { readonly revision?: string; readonly resourceCount: number } {
    return {
      ...(this.rev === undefined ? {} : { revision: this.rev }),
      resourceCount: this.plugins.size,
    }
  }

  /** 把已校验 pathname 解析成一个真实普通文件。 */
  resolve(pathname: string): string {
    const plugin = this.plugins.get(pathname)
    if (plugin !== undefined) return plugin
    if (pathname.startsWith('/plugins/')) throw new Error('desktop resources: unknown plugin resource')
    if (pathname !== '/index.html' && !pathname.startsWith('/assets/')) {
      throw new Error('desktop resources: unknown core resource')
    }
    const candidate = strictRealFile(join(this.rendererRoot, `.${pathname}`))
    assertInside(this.rendererRoot, candidate)
    return candidate
  }

  /** 取得资源 MIME；未知扩展 fail closed。 */
  mime(pathname: string): string {
    const mime = DESKTOP_MIME_TYPES[extname(pathname).toLowerCase()]
    if (mime === undefined) throw new Error('desktop resources: unknown MIME type')
    return mime
  }
}

function strictRealFile(path: string): string {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('desktop resources: resource is not a regular file')
  return realpathSync(path)
}

function assertInside(root: string, candidate: string): void {
  const child = relative(root, candidate)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('desktop resources: resource escapes renderer root')
  }
}
