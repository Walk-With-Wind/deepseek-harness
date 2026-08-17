/** IPC Fetch 描述符的路径、方法和 header 安全校验。 */
import {
  IPC_MAX_HEADER_BYTES,
  IpcTransportError,
  type IpcFailureCode,
} from './protocol.ts'

const INTERNAL_ORIGIN = 'http://dsh.internal'
const METHODS = new Set(['GET', 'HEAD', 'POST'])
const REQUEST_HEADERS = new Set([
  'accept',
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
])
const RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
])
const encoder = new TextEncoder()

function transportError(code: IpcFailureCode, message: string): IpcTransportError {
  return new IpcTransportError(code, message, { phase: 'request', retryable: false })
}

/**
 * 校验并提取 IPC 内部 URL 的 API 相对路径。
 * @param url - 客户端 Fetch URL。
 * @returns 保留查询串的 API 相对路径。
 */
export function requestPath(url: URL): string {
  if (url.origin !== INTERNAL_ORIGIN || url.hash !== '') {
    throw transportError('PROTOCOL_PATH', 'IPC 请求只能访问内部 API origin，且不能包含 fragment')
  }
  const path = `${url.pathname}${url.search}`
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    throw transportError('PROTOCOL_PATH', 'IPC 请求路径包含非法百分号编码')
  }
  if (!url.pathname.startsWith('/api/') || url.pathname.includes('\\')
    || decoded.includes('\\') || decoded.split('/').some(segment => segment === '.' || segment === '..')) {
    throw transportError('PROTOCOL_PATH', 'IPC 请求路径不属于允许的 API 前缀')
  }
  return path
}

/**
 * 校验协议帧携带的相对路径。
 * @param path - 帧内相对路径。
 * @returns 对应的内部 URL。
 */
export function internalUrl(path: string): URL {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('#')) {
    throw transportError('PROTOCOL_PATH', 'IPC 请求帧包含非法路径')
  }
  const url = new URL(path, INTERNAL_ORIGIN)
  requestPath(url)
  return url
}

/**
 * 校验 Fetch method。
 * @param method - 待校验方法。
 * @returns 规范化后的允许方法。
 */
export function requestMethod(method: string): 'GET' | 'HEAD' | 'POST' {
  const normalized = method.toUpperCase()
  if (!METHODS.has(normalized)) {
    throw transportError('PROTOCOL_METHOD', `IPC 请求方法不受支持：${method}`)
  }
  return normalized as 'GET' | 'HEAD' | 'POST'
}

function checkedHeaders(
  headers: Iterable<readonly [string, string]>,
  allowed: ReadonlySet<string>,
): [string, string][] {
  const result: [string, string][] = []
  let bytes = 0
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase()
    if (!allowed.has(name) && !name.startsWith('x-dsh-')) {
      throw transportError('PROTOCOL_HEADER', `IPC header 不在允许集合中：${name}`)
    }
    if (/[^\t\x20-\x7e\x80-\xff]/u.test(value)) {
      throw transportError('PROTOCOL_HEADER', `IPC header 包含非法字符：${name}`)
    }
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength
    if (bytes > IPC_MAX_HEADER_BYTES) {
      throw transportError('LIMIT_HEADERS', 'IPC header 总大小超过限制')
    }
    result.push([name, value])
  }
  return result
}

/**
 * 校验并序列化 Renderer 请求 header。
 * @param headers - Renderer 构造的请求 header。
 * @returns 仅包含请求白名单且受累计字节限制的键值对。
 */
export function requestHeaders(headers: Headers): [string, string][] {
  return checkedHeaders(headers, REQUEST_HEADERS)
}

/**
 * 在 Host 信任边界重新校验 Renderer 原始请求帧的 header。
 * @param headers - 已通过外层结构校验、但仍不可信的键值对。
 * @returns 仅包含请求白名单且受累计字节限制的规范化键值对。
 */
export function requestFrameHeaders(headers: readonly (readonly [string, string])[]): [string, string][] {
  return checkedHeaders(headers, REQUEST_HEADERS)
}

/**
 * 解析并限制请求声明的 Content-Length；Renderer 与 Host 两端使用同一规则。
 * @param headers - 已通过请求 header 白名单校验的 Headers。
 * @param maxRequestBodyBytes - 当前端口允许的请求体累计上限。
 * @returns 未声明时为 undefined，否则为非负安全整数。
 */
export function requestContentLength(headers: Headers, maxRequestBodyBytes: number): number | undefined {
  const raw = headers.get('content-length')
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw transportError('PROTOCOL_HEADER', 'IPC Content-Length 非法')
  }
  if (value > maxRequestBodyBytes) {
    throw transportError('LIMIT_REQUEST_BODY', 'IPC 请求体声明长度超过配置上限')
  }
  return value
}

/**
 * 过滤并序列化 Host 响应 header。
 * @param headers - Host 业务响应 header。
 * @returns 可暴露给 Renderer 且受累计字节限制的键值对。
 */
export function responseHeaders(headers: Headers): [string, string][] {
  const filtered = new Headers()
  for (const [name, value] of headers) {
    if (RESPONSE_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-dsh-')) {
      filtered.append(name, value)
    }
  }
  return checkedHeaders(filtered, RESPONSE_HEADERS)
}

/** IPC Fetch 使用的固定内部 origin。 */
export const IPC_INTERNAL_BASE_URL = INTERNAL_ORIGIN

/**
 * 把取消或关闭原因收敛为可跨进程发送的短文本。
 * @param reason - 本地异常或关闭原因。
 * @returns 不超过协议上限的可显示文本。
 */
export function ipcReasonText(reason: unknown): string {
  let text: string
  if (reason instanceof Error) text = reason.message
  else if (typeof reason === 'string') text = reason
  else if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') text = String(reason)
  else text = '未提供可显示原因'
  return text.slice(0, 512)
}
