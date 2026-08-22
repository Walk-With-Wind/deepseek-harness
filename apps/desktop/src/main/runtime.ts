/** Electron 副作用驱动：执行纯 Supervisor 命令并拥有窗口、Utility 与操作 registry。 */
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  BrowserWindow,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  utilityProcess,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type SaveDialogOptions,
  type UtilityProcess,
} from 'electron'
import { canonicalizeHostHome } from '@deepseek-ai/dsh-app-boot'
import { openNativePath, openNativeTextFile } from '@deepseek-ai/dsh-host-apiproxy'
import { DesktopJsonlLogger } from '../host/logging.ts'
import { DesktopResourceMap } from './protocol.ts'
import { createDesktopWindow } from './window.ts'
import { isTrustedRendererUrl } from './navigation.ts'
import {
  initialSupervisorState,
  reduceSupervisor,
  type SupervisorEffect,
  type SupervisorEvent,
  type SupervisorState,
} from './supervisor.ts'
import { DESKTOP_CHANNELS } from '../shared/channels.ts'
import {
  DESKTOP_CONTROL_PROTOCOL_VERSION,
  parseDesktopConfig,
  parseUtilityControlFrame,
  type DesktopConfig,
  type MainControlFrame,
  type UtilityControlFrame,
} from '../shared/control-protocol.ts'
import {
  DESKTOP_RENDERER_PROTOCOL_VERSION,
  parseRendererCommand,
  type DesktopBootstrap,
  type RendererCommand,
  type RendererCommandResult,
  type RendererHostState,
} from '../shared/renderer-protocol.ts'
import { DesktopUpdateProvider } from './update-provider.ts'
import { readDesktopBuildInfo, type DesktopBuildInfo } from './build-info.ts'
import { DESKTOP_PRODUCT_NAME } from '../shared/release-policy.ts'
import { resolveCommunityDesktopHome } from '../host/community-home.ts'
import {
  DESKTOP_DIAGNOSTIC_CATEGORIES,
  DESKTOP_DIAGNOSTIC_EXCLUSIONS,
  writeDesktopDiagnosticBundle,
} from './diagnostics.ts'
import {
  PendingSessionExports,
  type PendingSessionExport,
} from './pending-session-exports.ts'
import { requestSystemSessionEnd } from './session-end.ts'
import { DesktopNativePathOperations } from './native-path-operations.ts'

/** Main 进程唯一的 Desktop 生命周期所有者。 */
export class DesktopMainRuntime {
  readonly resources: DesktopResourceMap
  private readonly config: DesktopConfig
  private readonly logger: DesktopJsonlLogger
  private readonly rendererCrashLogger: DesktopJsonlLogger
  private readonly home: string
  private readonly homeKey: string
  private readonly buildInfo: DesktopBuildInfo
  private readonly preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  private readonly utilityPath = fileURLToPath(new URL('./utility.js', import.meta.url))
  private state: SupervisorState = initialSupervisorState()
  private queue: Promise<void> = Promise.resolve()
  private utility: UtilityProcess | undefined
  private utilityGeneration = 0
  private window: BrowserWindow | undefined
  private boot: DesktopBootstrap['boot'] | undefined
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private rendererTimer: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private healthTimer: ReturnType<typeof setTimeout> | undefined
  private healthOperationId: string | undefined
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined
  private terminateTimer: ReturnType<typeof setTimeout> | undefined
  private statusCode: string | undefined
  private statusMessage: string | undefined
  private readonly pendingExports = new PendingSessionExports()
  private readonly pendingDirectories = new Set<string>()
  private readonly nativePaths = new DesktopNativePathOperations({
    openDefault: openNativePath,
    openTextFile: openNativeTextFile,
  })
  private readonly pendingDiagnostics = new Set<string>()
  private ipcInstalled = false
  private exiting = false
  private pendingUpdateInstall = false
  private updateQuiescent = false
  private rendererReplacementPending = false
  private readonly unsubscribeUpdate: () => void
  private readonly installedExportAcceptancePath: string | undefined
  private readonly installedUnaryLatencyAcceptance: boolean

  /**
   * @param rendererRoot - 已构建且随应用打包的 Renderer 根目录。
   * @param updateProvider - 当前平台的闭合更新状态机。
   * @param configValue - 发行配置值；进入状态机前严格校验并补齐默认值。
   * @param options - 只由入口解析的安装态验收能力；普通运行为空。
   */
  constructor(
    rendererRoot: string,
    private readonly updateProvider: DesktopUpdateProvider,
    configValue: unknown,
    options: {
      readonly installedExportAcceptancePath?: string
      readonly installedUnaryLatencyAcceptance?: boolean
    } = {},
  ) {
    this.resources = new DesktopResourceMap(rendererRoot)
    this.config = parseDesktopConfig(configValue)
    this.home = resolveCommunityDesktopHome()
    this.homeKey = canonicalizeHostHome(this.home).key
    this.buildInfo = readDesktopBuildInfo(app.getAppPath(), app.getVersion())
    this.logger = new DesktopJsonlLogger(
      this.home, 'main', this.buildInfo.version, this.config.logMaxBytes, this.config.logMaxFiles,
    )
    this.rendererCrashLogger = new DesktopJsonlLogger(
      this.home, 'renderer-crash', this.buildInfo.version, this.config.logMaxBytes, this.config.logMaxFiles,
    )
    this.installedExportAcceptancePath = options.installedExportAcceptancePath
    this.installedUnaryLatencyAcceptance = options.installedUnaryLatencyAcceptance === true
    this.unsubscribeUpdate = this.updateProvider.subscribe(() => { this.publishUpdateState() })
    this.log('info', 'runtime_constructed')
  }

  /** 安装唯一 IPC handler 并启动第一代 Utility。 */
  start(): void {
    if (this.ipcInstalled) throw new Error('Desktop Main 已启动')
    this.ipcInstalled = true
    ipcMain.handle(DESKTOP_CHANNELS.command, (event, raw) => this.handleRendererCommand(event, raw))
    this.dispatch({ type: 'start', at: Date.now() })
  }

  /** 请求有界 quiescent shutdown。 */
  stop(reason: string): void {
    this.dispatch({ type: 'stop', reason, at: Date.now() })
  }

  /** 聚焦当前窗口。 */
  focus(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** OS 从休眠恢复后先停止新操作，对当前 Utility 代际执行有界健康探测。 */
  resume(): void {
    this.dispatch({ type: 'health-check', generation: this.state.generation, at: Date.now() })
  }

  /** 由可信原生菜单触发一次更新检查。 */
  checkForUpdates(): void {
    this.updateProvider.check()
  }

  /** Electron 的全部窗口关闭事件当前是否代表用户主动退出。 */
  shouldStopForAllWindowsClosed(): boolean {
    return !this.rendererReplacementPending
  }

  /** 由可信原生菜单打开诊断内容确认与保存流程。 */
  exportDiagnostics(): void {
    void this.exportDiagnosticBundle(0, crypto.randomUUID())
  }

  /** 最终退出阶段允许 before-quit 继续。 */
  canExit(): boolean {
    return this.exiting || this.state.phase === 'STOPPED'
  }

  /** 清理 Main 自身 handler 与 timer；进程结束前调用。 */
  dispose(): void {
    ipcMain.removeHandler(DESKTOP_CHANNELS.command)
    this.clearTimers()
    this.unsubscribeUpdate()
    this.updateProvider.dispose()
  }

  private dispatch(event: SupervisorEvent): void {
    this.queue = this.queue.then(() => {
      const transition = reduceSupervisor(this.state, event, this.config)
      this.state = transition.state
      this.log('info', `event_${event.type}`, 'OK')
      if (event.type === 'host-failed' || event.type === 'renderer-failed') {
        this.statusCode = event.code
      } else if (event.type === 'retry' || event.type === 'renderer-ready') {
        this.statusCode = undefined
        this.statusMessage = undefined
      }
      this.publishState()
      for (const effect of transition.effects) this.execute(effect)
    }).catch((error: unknown) => {
      this.statusCode = 'MAIN_RUNTIME_FAILED'
      this.statusMessage = '桌面宿主发生内部错误，请查看本地诊断日志。'
      this.log('error', 'dispatch_failed', error instanceof Error ? error.name : 'UNKNOWN_ERROR')
      this.publishState()
    })
  }

  private execute(effect: SupervisorEffect): void {
    switch (effect.type) {
      case 'spawn-utility':
        this.spawnUtility(effect.generation)
        return
      case 'arm-boot-timeout':
        this.clearTimer('boot')
        this.bootTimer = setTimeout(() => {
          this.dispatch({ type: 'boot-timeout', generation: effect.generation, at: Date.now() })
        }, effect.delayMs)
        return
      case 'cancel-boot-timeout':
        this.clearTimer('boot')
        return
      case 'show-main-window':
        this.replaceWindow(true)
        return
      case 'replace-renderer':
        this.rendererReplacementPending = true
        this.replaceWindow(true)
        return
      case 'arm-renderer-timeout':
        if (this.rendererTimer !== undefined) clearTimeout(this.rendererTimer)
        this.rendererTimer = setTimeout(() => {
          this.rendererTimer = undefined
          this.dispatch({ type: 'renderer-timeout', generation: effect.generation, at: Date.now() })
        }, effect.delayMs)
        return
      case 'cancel-renderer-timeout':
        if (this.rendererTimer !== undefined) clearTimeout(this.rendererTimer)
        this.rendererTimer = undefined
        return
      case 'replace-with-recovery':
        this.statusCode = effect.code
        // 恢复窗口必须替换已崩溃但 BrowserWindow 对象仍存活的旧文档。
        this.replaceWindow(false)
        return
      case 'close-data-ports':
        this.failPendingOperations(effect.generation)
        if (this.utilityGeneration === effect.generation) this.utility?.kill()
        return
      case 'schedule-restart':
        this.clearTimer('restart')
        this.restartTimer = setTimeout(() => {
          this.dispatch({ type: 'restart-due', at: Date.now() })
        }, effect.delayMs)
        return
      case 'send-health-probe': {
        this.clearHealthTimer()
        const operationId = crypto.randomUUID()
        this.healthOperationId = operationId
        this.sendUtility({ type: 'host/health', generation: effect.generation, operationId })
        return
      }
      case 'arm-health-timeout':
        if (this.healthTimer !== undefined) clearTimeout(this.healthTimer)
        this.healthTimer = setTimeout(() => {
          this.dispatch({ type: 'health-failed', generation: effect.generation, at: Date.now() })
        }, effect.delayMs)
        return
      case 'cancel-health-timeout':
        this.clearHealthTimer()
        return
      case 'begin-shutdown':
        this.beginShutdown(effect.generation, effect.reason, effect.delayMs)
        return
      case 'terminate-utility':
        this.utility?.kill()
        this.terminateTimer = setTimeout(() => {
          this.dispatch({ type: 'terminate-timeout', at: Date.now() })
        }, this.config.terminateGraceMs)
        return
      case 'kill-utility':
        if (this.utility?.pid !== undefined) {
          try { process.kill(this.utility.pid, 'SIGKILL') } catch { /* 进程已退出即满足目标。 */ }
        }
        return
      case 'finish-stop':
        this.finishStop(effect.generation)
        return
      default:
        return assertNever(effect)
    }
  }

  private spawnUtility(generation: number): void {
    this.utilityGeneration = generation
    this.boot = undefined
    const child = utilityProcess.fork(this.utilityPath, [], {
      serviceName: `${DESKTOP_PRODUCT_NAME} Utility Host`,
      stdio: ['ignore', 'pipe', 'pipe'],
      allowLoadingUnsignedLibraries: false,
    })
    this.utility = child
    child.stdout?.resume()
    child.stderr?.resume()
    child.on('spawn', () => {
      if (this.utility !== child || this.utilityGeneration !== generation) return
      this.log('info', 'utility_spawned', 'OK', child.pid)
      const home = canonicalizeHostHome(resolveCommunityDesktopHome())
      const hello: MainControlFrame = {
        type: 'host/hello',
        protocolVersion: DESKTOP_CONTROL_PROTOCOL_VERSION,
        generation,
        appVersion: app.getVersion(),
        homeKey: home.key,
        config: this.config,
      }
      child.postMessage(hello)
    })
    child.on('message', (raw) => { this.receiveUtility(child, generation, raw) })
    child.on('exit', (code) => {
      if (this.utility === child) this.utility = undefined
      this.log(code === 0 ? 'info' : 'error', 'utility_exited', code === 0 ? 'OK' : `EXIT_${String(code)}`)
      this.failPendingOperations(generation)
      this.dispatch({ type: 'utility-exit', generation, at: Date.now() })
    })
  }

  private receiveUtility(child: UtilityProcess, generation: number, raw: unknown): void {
    let frame: UtilityControlFrame
    try {
      frame = parseUtilityControlFrame(raw)
    } catch {
      this.dispatch({
        type: 'host-failed', generation,
        code: 'CONTROL_PROTOCOL_INVALID', at: Date.now(),
      })
      return
    }
    if (this.utility !== child || frame.generation !== generation || generation !== this.state.generation) return
    this.log(
      frame.type === 'host/failed' ? 'error' : 'debug',
      `utility_${frame.type}`,
      frame.type === 'host/failed' ? frame.code : 'OK',
    )
    switch (frame.type) {
      case 'host/ready':
        try {
          if (frame.appVersion !== app.getVersion()) throw new Error('Main 与 Utility 版本不一致')
          this.resources.replacePlugins(frame.resources)
          this.boot = frame.boot
          this.dispatch({ type: 'host-ready', generation, at: Date.now() })
        } catch {
          this.dispatch({ type: 'host-failed', generation, code: 'RESOURCE_MANIFEST_INVALID', at: Date.now() })
        }
        return
      case 'host/failed':
        this.statusMessage = frame.message
        this.dispatch({ type: 'host-failed', generation, code: frame.code, at: Date.now() })
        return
      case 'host/quiescent':
        if (this.pendingUpdateInstall) this.updateQuiescent = true
        this.dispatch({ type: 'host-quiescent', generation, at: Date.now() })
        return
      case 'host/healthy':
        if (frame.operationId !== this.healthOperationId) return
        this.dispatch({ type: 'health-ready', generation, at: Date.now() })
        return
      case 'dialog/open-directory':
        void this.openDirectory(frame.operationId, generation)
        return
      case 'path/open':
        void this.nativePaths.open(frame, (result) => { this.sendUtility(result) })
        return
      case 'path/cancel':
        this.nativePaths.cancel(generation, frame.operationId)
        return
      case 'export/progress':
        return
      case 'export/result':
        this.settleExport(frame)
        return
      default:
        return assertNever(frame)
    }
  }

  private replaceWindow(withBootstrap: boolean): void {
    const old = this.window
    const generation = this.state.generation
    const window = createDesktopWindow({
      preloadPath: this.preloadPath,
      onRendererGone: () => {
        // Electron 可能先关闭崩溃窗口再执行异步状态机，必须同步抑制正常退出路径。
        this.rendererReplacementPending = true
        this.rendererCrashLogger.write({
          level: 'error', event: 'renderer_process_gone', generation,
          phase: this.state.phase, stableCode: 'RENDERER_PROCESS_GONE',
        })
        if (this.window === window) this.dispatch({ type: 'renderer-gone', generation, at: Date.now() })
      },
      onLoaded: (loaded) => {
        if (this.window !== loaded) return
        if (!withBootstrap) this.rendererReplacementPending = false
        this.log('debug', 'renderer_document_loaded', 'OK')
        this.publishState()
        if (withBootstrap) this.attachRenderer(loaded, generation)
      },
    })
    this.window = window
    // 先登记替代窗口再销毁旧窗口，避免代际切换瞬间触发全窗口关闭流程。
    old?.destroy()
    window.on('query-session-end', (event) => { requestSystemSessionEnd(this, event) })
    window.on('session-end', () => { requestSystemSessionEnd(this) })
    window.on('closed', () => {
      if (this.window !== window) return
      this.window = undefined
      if (this.rendererReplacementPending) return
      if (this.state.phase !== 'STOPPING' && this.state.phase !== 'STOPPED') app.quit()
    })
  }

  private attachRenderer(window: BrowserWindow, generation: number): void {
    const child = this.utility
    const boot = this.boot
    if (child === undefined || boot === undefined || generation !== this.utilityGeneration) return
    const nonce = randomBytes(32).toString('base64url')
    const bootstrap: DesktopBootstrap = {
      protocolVersion: DESKTOP_RENDERER_PROTOCOL_VERSION,
      generation,
      nonce,
      appVersion: app.getVersion(),
      boot,
      ...(this.installedUnaryLatencyAcceptance ? { installedUnaryLatencyAcceptance: true } : {}),
    }
    const { port1, port2 } = new MessageChannelMain()
    this.log('debug', 'renderer_port_attached', 'OK')
    child.postMessage({
      type: 'data/attach', generation, connectionId: crypto.randomUUID(),
    } satisfies MainControlFrame, [port2])
    window.webContents.postMessage(DESKTOP_CHANNELS.bootstrap, bootstrap, [port1])
  }

  private async handleRendererCommand(
    event: IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<RendererCommandResult> {
    if (!this.trustedSender(event)) throw new Error('不可信的 Renderer sender')
    const command = parseRendererCommand(raw)
    switch (command.type) {
      case 'host/retry': {
        const accepted = this.state.phase === 'FAILED' || this.state.phase === 'CIRCUIT_OPEN'
        if (accepted) this.dispatch({ type: 'retry', at: Date.now() })
        return { type: 'host/retry-result', outcome: accepted ? 'accepted' : 'ignored' }
      }
      case 'update/check': {
        const accepted = this.updateProvider.check()
        return { type: 'update/action-result', action: 'check', outcome: accepted ? 'accepted' : 'ignored' }
      }
      case 'update/install': {
        const accepted = this.state.phase === 'READY' && this.updateProvider.approveInstall()
        if (accepted) {
          this.pendingUpdateInstall = true
          this.updateQuiescent = false
          this.stop('安装已下载更新')
        }
        return { type: 'update/action-result', action: 'install', outcome: accepted ? 'accepted' : 'ignored' }
      }
      case 'diagnostics/export':
        return this.exportDiagnosticBundle(event.sender.id, command.operationId)
      case 'renderer/ready': {
        const accepted = command.generation === this.state.generation
          && (this.state.phase === 'STARTING'
            || (this.state.phase === 'DEGRADED' && this.state.degradedBy === 'renderer'))
        if (accepted) {
          this.rendererReplacementPending = false
          this.dispatch({ type: 'renderer-ready', generation: command.generation, at: Date.now() })
        }
        return { type: 'renderer/status-result', outcome: accepted ? 'accepted' : 'ignored' }
      }
      case 'renderer/failed': {
        const accepted = command.generation === this.state.generation
          && (this.state.phase === 'STARTING'
            || (this.state.phase === 'DEGRADED' && this.state.degradedBy === 'renderer'))
        if (accepted) {
          this.rendererReplacementPending = true
          this.statusMessage = command.message
          this.dispatch({
            type: 'renderer-failed', generation: command.generation,
            code: 'GUI_BOOT_FAILED', at: Date.now(),
          })
        }
        return { type: 'renderer/status-result', outcome: accepted ? 'accepted' : 'ignored' }
      }
      case 'operation/cancel': {
        const cancellation = this.pendingExports.cancel(command.operationId, event.sender.id)
        if (cancellation.forward && cancellation.generation !== undefined) {
          this.sendUtility({
            type: 'export/cancel', generation: cancellation.generation, operationId: command.operationId,
          })
        }
        return { type: 'operation/cancel-result', operationId: command.operationId, outcome: 'accepted' }
      }
      case 'session-log/save':
        return this.saveSessionLog(event.sender.id, command)
      default:
        return assertNever(command)
    }
  }

  private async saveSessionLog(
    ownerId: number,
    command: Extract<RendererCommand, { type: 'session-log/save' }>,
  ): Promise<RendererCommandResult> {
    const window = this.window
    const generation = this.state.generation
    if (this.state.phase !== 'READY' || window === undefined || window.isDestroyed()) {
      return {
        type: 'session-log/result', operationId: command.operationId,
        outcome: 'failed', message: '本地运行时当前不可用',
      }
    }
    const pending = this.pendingExports.reserve(command.operationId, generation, ownerId)
    if (pending === undefined) {
      return {
        type: 'session-log/result', operationId: command.operationId,
        outcome: 'failed', message: '导出操作 id 重复',
      }
    }
    void this.selectAndStartSessionExport(window, pending, command)
    return pending.result
  }

  private async selectAndStartSessionExport(
    window: BrowserWindow,
    pending: PendingSessionExport,
    command: Extract<RendererCommand, { type: 'session-log/save' }>,
  ): Promise<void> {
    try {
      // 安装态容量门禁只能选择已验证的临时 Home 固定路径；普通运行始终使用原生保存对话框。
      const selection = this.installedExportAcceptancePath === undefined
        ? await dialog.showSaveDialog(window, {
          title: '保存 Session 诊断包',
          defaultPath: command.suggestedName,
          buttonLabel: '保存',
          filters: [{ name: 'ZIP 归档', extensions: ['zip'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        })
        : { canceled: false, filePath: this.installedExportAcceptancePath }
      if (!this.pendingExports.isCurrent(pending)) return
      if (selection.canceled || selection.filePath === '') {
        this.pendingExports.settle(pending, {
          type: 'session-log/result', operationId: command.operationId, outcome: 'cancelled',
        })
        return
      }
      if (!this.isReadyGeneration(pending.generation)) {
        this.pendingExports.settle(pending, {
          type: 'session-log/result', operationId: command.operationId,
          outcome: 'failed', message: '运行时代际已变化，请重新导出',
        })
        return
      }
      if (!this.pendingExports.markRunning(pending)) return
      this.sendUtility({
        type: 'export/start', generation: pending.generation, operationId: command.operationId,
        sessionId: command.sessionId, targetPath: selection.filePath,
      })
    } catch {
      this.pendingExports.settle(pending, {
        type: 'session-log/result', operationId: command.operationId,
        outcome: 'failed', message: '无法打开保存对话框，请重试',
      })
    }
  }

  private settleExport(frame: Extract<UtilityControlFrame, { type: 'export/result' }>): void {
    this.pendingExports.settleRunning(frame.operationId, frame.generation, {
      type: 'session-log/result',
      operationId: frame.operationId,
      outcome: frame.outcome,
      ...(frame.message === undefined ? {} : { message: frame.message }),
    })
  }

  private async openDirectory(operationId: string, generation: number): Promise<void> {
    if (this.pendingDirectories.has(operationId)) return
    this.pendingDirectories.add(operationId)
    try {
      const window = this.window
      const result = window === undefined || window.isDestroyed()
        ? { canceled: true, filePaths: [] }
        : await dialog.showOpenDialog(window, {
          title: '选择工作目录',
          buttonLabel: '选择目录',
          properties: ['openDirectory', 'createDirectory'],
        })
      if (generation !== this.state.generation) return
      this.sendUtility({
        type: 'dialog/result', generation, operationId,
        path: result.canceled ? null : result.filePaths[0] ?? null,
      })
    } finally {
      this.pendingDirectories.delete(operationId)
    }
  }

  private async exportDiagnosticBundle(
    _ownerId: number,
    operationId: string,
  ): Promise<RendererCommandResult> {
    if (this.pendingDiagnostics.has(operationId)) {
      return { type: 'diagnostics/result', operationId, outcome: 'failed', message: '诊断操作 id 重复' }
    }
    this.pendingDiagnostics.add(operationId)
    try {
      const window = this.window
      const confirmationOptions: MessageBoxOptions = {
        type: 'info',
        title: '导出 Desktop 诊断包',
        message: '诊断包只包含以下本地运行信息',
        detail: [
          ...DESKTOP_DIAGNOSTIC_CATEGORIES.map(item => `• ${item}`),
          '',
          '明确排除：',
          ...DESKTOP_DIAGNOSTIC_EXCLUSIONS.map(item => `• ${item}`),
        ].join('\n'),
        buttons: ['继续选择保存位置', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }
      const confirmation = window === undefined || window.isDestroyed()
        ? await dialog.showMessageBox(confirmationOptions)
        : await dialog.showMessageBox(window, confirmationOptions)
      if (confirmation.response !== 0) {
        return { type: 'diagnostics/result', operationId, outcome: 'cancelled' }
      }
      const date = new Date().toISOString().slice(0, 10)
      const saveOptions: SaveDialogOptions = {
        title: '保存 Desktop 诊断包',
        defaultPath: `DeepSeek-Harness-Diagnostics-${date}.zip`,
        buttonLabel: '保存诊断包',
        filters: [{ name: 'ZIP 归档', extensions: ['zip'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      }
      const selection = window === undefined || window.isDestroyed()
        ? await dialog.showSaveDialog(saveOptions)
        : await dialog.showSaveDialog(window, saveOptions)
      if (selection.canceled || selection.filePath === '') {
        return { type: 'diagnostics/result', operationId, outcome: 'cancelled' }
      }
      await writeDesktopDiagnosticBundle({
        createdAt: new Date().toISOString(),
        build: this.buildInfo,
        packaged: app.isPackaged,
        config: this.config,
        generation: this.state.generation,
        phase: this.state.phase,
        homeKey: this.homeKey,
        resource: this.resources.summary(),
        update: this.updateProvider.state(),
      }, join(this.home, 'logs', 'desktop'), selection.filePath, new AbortController().signal)
      return { type: 'diagnostics/result', operationId, outcome: 'saved' }
    } catch {
      return {
        type: 'diagnostics/result', operationId, outcome: 'failed',
        message: '诊断包导出失败，请检查目标磁盘后重试。',
      }
    } finally {
      this.pendingDiagnostics.delete(operationId)
    }
  }

  private sendUtility(frame: MainControlFrame): void {
    if (this.utilityGeneration !== frame.generation) return
    this.utility?.postMessage(frame)
  }

  private trustedSender(event: IpcMainInvokeEvent): boolean {
    const window = this.window
    return window !== undefined
      && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url)
  }

  /** 在异步原生对话框返回后重新读取当前运行时代际和阶段。 */
  private isReadyGeneration(generation: number): boolean {
    return this.state.generation === generation && this.state.phase === 'READY'
  }

  private publishState(): void {
    const window = this.window
    if (this.rendererReplacementPending || window === undefined || window.isDestroyed()) return
    if (this.state.phase === 'COLD' || this.state.phase === 'STOPPED') return
    const value: RendererHostState = {
      phase: this.state.phase,
      generation: this.state.generation,
      ...(this.statusCode === undefined ? {} : { code: this.statusCode }),
      ...(this.statusMessage === undefined ? {} : { message: this.statusMessage }),
    }
    window.webContents.send(DESKTOP_CHANNELS.hostState, value)
    this.publishUpdateState()
  }

  private publishUpdateState(): void {
    const window = this.window
    if (this.rendererReplacementPending || window === undefined || window.isDestroyed()) return
    window.webContents.send(DESKTOP_CHANNELS.updateState, this.updateProvider.state())
  }

  private beginShutdown(generation: number, reason: string, delayMs: number): void {
    this.clearTimer('boot')
    this.clearTimer('restart')
    this.failPendingOperations(generation)
    if (this.utility === undefined || this.utilityGeneration !== generation) {
      this.finishStop(generation)
      return
    }
    this.sendUtility({ type: 'host/shutdown', generation, deadline: Date.now() + delayMs, reason })
    this.shutdownTimer = setTimeout(() => {
      this.dispatch({ type: 'shutdown-timeout', at: Date.now() })
    }, delayMs)
  }

  private finishStop(generation: number): void {
    this.clearTimers()
    this.failPendingOperations(generation)
    const window = this.window
    this.window = undefined
    window?.destroy()
    this.utility = undefined
    this.rendererReplacementPending = false
    this.exiting = true
    this.dispatch({ type: 'stopped', at: Date.now() })
    if (this.pendingUpdateInstall) {
      const canInstall = this.updateQuiescent
      this.pendingUpdateInstall = false
      this.updateQuiescent = false
      if (canInstall) {
        if (this.updateProvider.installAfterQuiescent()) return
      } else {
        this.updateProvider.abortInstall()
      }
    }
    app.quit()
  }

  private failPendingOperations(generation: number): void {
    this.pendingExports.failGeneration(generation)
    this.nativePaths.failGeneration(generation)
  }

  private clearTimer(kind: 'boot' | 'restart'): void {
    const timer = kind === 'boot' ? this.bootTimer : this.restartTimer
    if (timer !== undefined) clearTimeout(timer)
    if (kind === 'boot') this.bootTimer = undefined
    else this.restartTimer = undefined
  }

  private clearTimers(): void {
    this.clearTimer('boot')
    this.clearTimer('restart')
    if (this.shutdownTimer !== undefined) clearTimeout(this.shutdownTimer)
    if (this.terminateTimer !== undefined) clearTimeout(this.terminateTimer)
    this.shutdownTimer = undefined
    if (this.rendererTimer !== undefined) clearTimeout(this.rendererTimer)
    this.rendererTimer = undefined
    this.terminateTimer = undefined
    this.clearHealthTimer()
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== undefined) clearTimeout(this.healthTimer)
    this.healthTimer = undefined
    this.healthOperationId = undefined
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    stableCode = 'OK',
    pid?: number,
  ): void {
    this.logger.write({
      level,
      event,
      generation: this.state.generation,
      phase: this.state.phase,
      stableCode,
      ...(pid === undefined ? {} : { pid }),
    })
  }
}

function assertNever(value: never): never {
  throw new Error(`Desktop Main 收到未处理值：${JSON.stringify(value)}`)
}
