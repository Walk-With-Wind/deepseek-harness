/** Desktop 导航与外链的闭合 URL 策略。 */

/** Renderer 主文档必须来自固定的安全 custom origin。 */
export function isTrustedRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'app:'
      && url.hostname === 'localhost'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && (url.pathname === '/' || url.pathname === '/index.html')
  } catch {
    return false
  }
}

/** 只有产品文档与仓库自身的 HTTPS 页面可交给系统浏览器。 */
export function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
    if (url.hostname === 'api-docs.deepseek.com') return true
    return url.hostname === 'github.com'
      && (url.pathname === '/deepseek-ai/deepseek-harness'
        || url.pathname.startsWith('/deepseek-ai/deepseek-harness/'))
  } catch {
    return false
  }
}
