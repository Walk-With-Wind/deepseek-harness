/** 浏览器 Session ZIP 保存 provider。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {
  SessionLogSaveRequest,
  SessionLogSaver,
} from '@deepseek-ai/dsh-session-log-export/client'

/**
 * 把同源导出 URL 交给浏览器下载管理器。
 * @param url - 已由当前载体解析的同源导出 URL。
 * @param filename - 浏览器建议保存的 ZIP 文件名。
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

/** 使用显式 ClientCarrier 执行 HEAD 探测并启动浏览器下载。 */
export class WebSessionLogSaver implements SessionLogSaver {
  /**
   * @param fetcher - 产品载体的显式 Fetch 实现。
   * @param baseUrl - 产品载体在启动时固定的逻辑基址。
   * @param saveUrl - 浏览器下载入口，测试可替换。
   */
  constructor(
    private readonly fetcher: (input: URL | Request, init?: RequestInit) => Promise<Response>,
    private readonly baseUrl: string,
    private readonly saveUrl: (url: string, filename: string) => void = downloadUrl,
  ) {}

  /**
   * 探测导出入口可用后，把同源 URL 交给浏览器下载管理器。
   * @param request - 会话、建议文件名和取消信号。
   * @returns 浏览器下载已启动后解决为 `saved`。
   */
  async save(request: SessionLogSaveRequest): Promise<'saved'> {
    const url = new URL('/api/session.export', this.baseUrl)
    url.searchParams.set('sessionId', request.sessionId)
    url.searchParams.set('includeDescendants', 'true')
    const response = await this.fetcher(url, { method: 'HEAD', signal: request.signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Export failed: HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail}`}`)
    }
    this.saveUrl(url.toString(), request.suggestedName)
    return 'saved'
  }
}

/** Web provider 消费 AppGuiEntry 注入的 clientCarrier。 */
export const inject = ['clientCarrier']

/**
 * 提供浏览器 SessionLogSaver。
 * @param ctx - 已注入产品 ClientCarrier 的 GUI 上下文。
 */
export function apply(ctx: Context): void {
  const carrier = ctx.clientCarrier
  ctx.provide('sessionLogSaver', new WebSessionLogSaver(
    carrier.fetch.bind(carrier),
    carrier.baseUrl,
  ))
}
