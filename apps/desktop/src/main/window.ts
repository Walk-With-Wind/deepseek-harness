/** 安全 BrowserWindow 工厂与导航/权限基线。 */
import { BrowserWindow, shell, type WebPreferences } from 'electron'
import { isAllowedExternalUrl, isTrustedRendererUrl } from './navigation.ts'
import { assertDesktopWindowSecurity } from './window-security.ts'
import { DESKTOP_PRODUCT_NAME } from '../shared/release-policy.ts'

export interface CreateDesktopWindowOptions {
  /** 单一 CJS preload 产物。 */
  readonly preloadPath: string
  /** Renderer 异常退出通知。 */
  readonly onRendererGone: () => void
  /** 主文档完成加载通知。 */
  readonly onLoaded: (window: BrowserWindow) => void
}

const DESKTOP_WINDOW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const satisfies WebPreferences

/** 创建关闭 Node、启用 sandbox/contextIsolation 的产品窗口。 */
export function createDesktopWindow(options: CreateDesktopWindowOptions): BrowserWindow {
  // BrowserWindow 只能使用这一份已复验配置，避免构造参数在调用点分叉。
  assertDesktopWindowSecurity(DESKTOP_WINDOW_WEB_PREFERENCES)
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f8fa',
    title: DESKTOP_PRODUCT_NAME,
    webPreferences: { ...DESKTOP_WINDOW_WEB_PREFERENCES, preload: options.preloadPath },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  window.webContents.on('render-process-gone', () => { options.onRendererGone() })
  window.webContents.once('did-finish-load', () => { options.onLoaded(window) })
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  void window.loadURL('app://localhost/index.html')
  return window
}
