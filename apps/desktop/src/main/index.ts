/** DeepSeek Harness Desktop Main 进程入口。 */
import { fileURLToPath } from 'node:url'
import { Menu, app, powerMonitor } from 'electron'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installDesktopProtocol, registerDesktopScheme } from './protocol-electron.ts'
import { DesktopMainRuntime } from './runtime.ts'
import {
  DESKTOP_UPDATE_ORIGIN,
  createElectronUpdateAdapter,
} from './electron-update-adapter.ts'
import { DesktopUpdateProvider, desktopUpdateChannel } from './update-provider.ts'
import { createDesktopMenuTemplate } from './menu.ts'
import { readDesktopBuildInfo } from './build-info.ts'
import {
  assertDesktopReleasePlatform,
  DESKTOP_WINDOWS_APP_USER_MODEL_ID,
} from '../shared/release-policy.ts'
import { shouldExitForSquirrelStartup } from './squirrel-startup.ts'
import { readDesktopConfig } from './desktop-config.ts'
import { requestSystemSessionEnd } from './session-end.ts'
import {
  resolveInstalledExportAcceptancePath,
  resolveInstalledUnaryLatencyAcceptance,
} from './installed-export-acceptance.ts'

if (shouldExitForSquirrelStartup(process.platform)) app.quit()
else startDesktopMain()

function startDesktopMain(): void {
  assertDesktopReleasePlatform(process.platform)
  registerDesktopScheme()

  const hasSingleInstanceLock = app.requestSingleInstanceLock()
  let runtime: DesktopMainRuntime | undefined
  let uninstallProtocol: (() => void) | undefined
  const handleResume = (): void => { runtime?.resume() }
  const handleSystemShutdown = (): void => { requestSystemSessionEnd(runtime) }
  const handleTerminationSignal = (): void => {
    if (runtime === undefined) app.quit()
    else runtime.stop('操作系统终止信号')
  }

  if (!hasSingleInstanceLock) {
    app.quit()
    return
  }
  app.on('second-instance', () => { runtime?.focus() })
  app.on('window-all-closed', () => {
    if (runtime?.shouldStopForAllWindowsClosed()) runtime.stop('主窗口已关闭')
  })
  app.on('before-quit', (event) => {
    if (runtime === undefined || runtime.canExit()) return
    event.preventDefault()
    runtime.stop('应用退出')
  })
  app.on('will-quit', () => {
    powerMonitor.removeListener('resume', handleResume)
    powerMonitor.removeListener('shutdown', handleSystemShutdown)
    process.removeListener('SIGTERM', handleTerminationSignal)
    process.removeListener('SIGINT', handleTerminationSignal)
    runtime?.dispose()
    uninstallProtocol?.()
  })
  void app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId(DESKTOP_WINDOWS_APP_USER_MODEL_ID)
    const rendererRoot = fileURLToPath(new URL('../renderer', import.meta.url))
    const appVersion = app.getVersion()
    const desktopConfig = readDesktopConfig(app.getAppPath())
    const installedExportAcceptancePath = resolveInstalledExportAcceptancePath({
      argv: process.argv,
      ci: process.env.CI === 'true',
      packaged: app.isPackaged,
      home: resolveDshHome(),
    })
    const installedUnaryLatencyAcceptance = resolveInstalledUnaryLatencyAcceptance({
      argv: process.argv,
      ci: process.env.CI === 'true',
      packaged: app.isPackaged,
    })
    const buildInfo = readDesktopBuildInfo(app.getAppPath(), appVersion)
    app.setAboutPanelOptions({
      applicationName: 'DeepSeek Harness',
      applicationVersion: buildInfo.version,
      version: buildInfo.sourceCommit.slice(0, 12),
      copyright: 'Copyright © DeepSeek AI',
      credits: `Electron ${buildInfo.electronVersion} · Node ${buildInfo.nodeVersion}`,
    })
    const nativeUpdater = createElectronUpdateAdapter(
      process.platform, process.arch, desktopUpdateChannel(appVersion),
    )
    const updateProvider = new DesktopUpdateProvider({
      platform: process.platform,
      currentVersion: appVersion,
      allowedFeedOrigin: DESKTOP_UPDATE_ORIGIN,
      native: nativeUpdater,
    })
    runtime = new DesktopMainRuntime(rendererRoot, updateProvider, desktopConfig, {
      ...(installedExportAcceptancePath === undefined ? {} : { installedExportAcceptancePath }),
      ...(installedUnaryLatencyAcceptance ? { installedUnaryLatencyAcceptance: true } : {}),
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate(createDesktopMenuTemplate(
      process.platform,
      {
        checkForUpdates: () => { runtime?.checkForUpdates() },
        exportDiagnostics: () => { runtime?.exportDiagnostics() },
      },
    )))
    powerMonitor.on('resume', handleResume)
    powerMonitor.on('shutdown', handleSystemShutdown)
    process.once('SIGTERM', handleTerminationSignal)
    process.once('SIGINT', handleTerminationSignal)
    uninstallProtocol = installDesktopProtocol(runtime.resources)
    runtime.start()
  })
}
