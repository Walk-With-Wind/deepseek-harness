/** BrowserWindow 构造器必须接收的安全参数。 */
export interface DesktopWindowSecurityPreferences {
  readonly sandbox?: boolean
  readonly contextIsolation?: boolean
  readonly nodeIntegration?: boolean
  readonly nodeIntegrationInWorker?: boolean
  readonly nodeIntegrationInSubFrames?: boolean
  readonly webSecurity?: boolean
  readonly allowRunningInsecureContent?: boolean
  readonly webviewTag?: boolean
}

const EXPECTED_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const satisfies Required<DesktopWindowSecurityPreferences>

/**
 * 在创建 BrowserWindow 前复验显式安全参数，配置漂移时拒绝启动 Renderer。
 * @param actual - 即将传入 Electron 的 WebPreferences。
 */
export function assertDesktopWindowSecurity(actual: DesktopWindowSecurityPreferences): void {
  for (const [name, expected] of Object.entries(EXPECTED_PREFERENCES)) {
    if (actual[name as keyof DesktopWindowSecurityPreferences] !== expected) {
      throw new Error(`Desktop BrowserWindow 安全参数漂移：${name}`)
    }
  }
}
