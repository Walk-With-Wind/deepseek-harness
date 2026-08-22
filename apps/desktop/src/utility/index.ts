/** Electron Utility Process 入口：启动共享 Profile Host 并管理有界关停。 */
import { fileURLToPath } from 'node:url'
import { bootProfileRuntime, canonicalizeHostHome } from '@deepseek-ai/dsh-app-boot'
import { guiAppResourceOverlays } from '@deepseek-ai/dsh-gui-app'
import { DesktopJsonlLogger } from '../host/logging.ts'
import {
  parseMainControlFrame,
  parseUtilityControlFrame,
  type MainControlFrame,
  type UtilityControlFrame,
} from '../shared/control-protocol.ts'
import { DesktopUtilityControl } from './control.ts'
import { resolveCommunityDesktopHome } from '../host/community-home.ts'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const parentPort = Reflect.get(process, 'parentPort') as Electron.ParentPort | undefined
if (parentPort === undefined) throw new Error('Desktop Utility 必须由 Electron Utility Process 启动')
const utilityParentPort = parentPort

let generation: number | undefined
let control: DesktopUtilityControl | undefined
let runtime: Awaited<ReturnType<typeof bootProfileRuntime>> | undefined
let logger: DesktopJsonlLogger | undefined
let bootTask: Promise<void> | undefined
let stopping: Promise<void> | undefined
let booting = false
let shutdownRequested = false

function send(frame: UtilityControlFrame): void {
  utilityParentPort.postMessage(parseUtilityControlFrame(frame))
}

async function start(frame: Extract<MainControlFrame, { type: 'host/hello' }>): Promise<void> {
  if (booting || runtime !== undefined) throw new Error('Desktop Utility 重复收到 host/hello')
  booting = true
  generation = frame.generation
  const home = resolveCommunityDesktopHome()
  const canonicalHome = canonicalizeHostHome(home)
  if (canonicalHome.key !== frame.homeKey) throw new Error('Main 与 Utility 的 DSH_HOME 不一致')
  const utilityLogger = new DesktopJsonlLogger(
    canonicalHome.path, 'utility', frame.appVersion, frame.config.logMaxBytes, frame.config.logMaxFiles,
  )
  logger = utilityLogger
  utilityLogger.write({
    level: 'info', event: 'boot_started', generation: frame.generation,
    phase: 'STARTING', stableCode: 'OK', pid: process.pid,
  })
  const utilityControl = new DesktopUtilityControl(frame.generation, frame.config, send)
  control = utilityControl
  try {
    const bootedRuntime = await bootProfileRuntime({
      binName: 'dsh-desktop',
      profileName: 'desktop',
      installAnchor,
      home: canonicalHome.path,
      owner: { kind: 'desktop', version: frame.appVersion },
      // 以 Utility 产物文件作为 Node 裸包名解析的 parent URL。
      bareModuleBaseUrl: import.meta.url,
      // Electron Utility 不开放 Node internals；用户 patch 在受控重启时重新加载。
      watchUserPatches: false,
      // Web、CLI 与 Desktop 共用 GUI bundle 随安装交付的只读 Agent Preset roster。
      extendOverlays: rows => guiAppResourceOverlays(rows),
      prepare(ctx) {
        ctx.provide('desktopHost', utilityControl)
      },
    })
    runtime = bootedRuntime
    utilityControl.attachContext(bootedRuntime.ctx)
    if (shutdownRequested) return
    const resources = bootedRuntime.ctx.clientModules.resourceManifest()
    utilityLogger.write({
      level: 'info', event: 'boot_ready', generation: frame.generation,
      phase: 'READY', stableCode: 'OK', pid: process.pid,
    })
    send({
      type: 'host/ready',
      protocolVersion: frame.protocolVersion,
      generation: frame.generation,
      appVersion: frame.appVersion,
      resources: { ...resources, resources: [...resources.resources] },
      boot: bootedRuntime.ctx.clientModules.graph(),
    })
  } catch (error) {
    utilityLogger.write({
      level: 'error', event: 'boot_failed', generation: frame.generation,
      phase: 'FAILED', stableCode: stableFailureCode(error), pid: process.pid,
    })
    send({
      type: 'host/failed',
      generation: frame.generation,
      code: stableFailureCode(error),
      message: stableFailureMessage(error),
    })
  }
}

function stop(currentGeneration: number): Promise<void> {
  shutdownRequested = true
  stopping ??= (async () => {
    // 若关停与启动并发，先等待 Profile 确定结果，再释放已创建的资源。
    await bootTask
    await control?.dispose()
    await runtime?.ctx.fiber.dispose()
    logger?.write({
      level: 'info', event: 'shutdown_quiescent', generation: currentGeneration,
      phase: 'STOPPING', stableCode: 'OK', pid: process.pid,
    })
    send({ type: 'host/quiescent', generation: currentGeneration })
    // Main 以真实 exit 事件作为关停完成条件；此时所有业务资源和数据端口均已释放。
    setImmediate(() => { process.exit(0) })
  })()
  return stopping
}

function stableFailureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 128)
  }
  return 'UTILITY_BOOT_FAILED'
}

function stableFailureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'HOST_LEASE_CONFLICT') {
    return '当前 DSH_HOME 已由另一个 Host 使用，请先关闭对应 CLI、Web 或 Desktop 实例。'
  }
  return '本地运行时启动失败，请检查 Desktop 日志后重试。'
}

utilityParentPort.on('message', (event) => {
  let frame: MainControlFrame
  try {
    frame = parseMainControlFrame(event.data)
  } catch {
    if (generation !== undefined) {
      send({
        type: 'host/failed', generation,
        code: 'CONTROL_PROTOCOL_INVALID', message: 'Main 发送了无效的控制消息。',
      })
    }
    return
  }
  if (generation !== undefined && frame.generation !== generation) return
  if (frame.type === 'host/hello') {
    bootTask = start(frame)
    return
  }
  if (frame.type === 'host/shutdown') {
    void stop(frame.generation)
    return
  }
  try {
    control?.receive(frame, event.ports)
  } catch {
    send({
      type: 'host/failed', generation: frame.generation,
      code: 'CONTROL_OPERATION_FAILED', message: '本地运行时控制操作失败。',
    })
  }
})
