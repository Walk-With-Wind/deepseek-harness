/** Sandboxed Renderer 的唯一 Electron 适配层。 */
import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_CHANNELS, DESKTOP_DATA_PORT_MESSAGE } from '../shared/channels.ts'
import { OneShotMailbox } from '../shared/one-shot-mailbox.ts'
import {
  parseDesktopBootstrap,
  parseRendererCommand,
  parseRendererCommandResult,
  parseRendererHostState,
  parseRendererUpdateState,
  type DesktopBootstrap,
  type DesktopRendererApi,
  type RendererCommand,
  type RendererHostState,
  type DesktopUpdateState,
} from '../shared/renderer-protocol.ts'

interface PendingBootstrap {
  readonly manifest: DesktopBootstrap
  readonly port: MessagePort
}

let claimed: PendingBootstrap | undefined
const bootstrapMailbox = new OneShotMailbox<PendingBootstrap>()
let latestHostState: RendererHostState | undefined
let latestUpdateState: DesktopUpdateState | undefined

function publishBootstrap(value: PendingBootstrap): void {
  if (!bootstrapMailbox.publish(value)) value.port.close()
}

ipcRenderer.on(DESKTOP_CHANNELS.bootstrap, (event, raw) => {
  if (event.ports.length !== 1) return
  try {
    publishBootstrap({
      manifest: parseDesktopBootstrap(raw),
      port: event.ports[0] as unknown as MessagePort,
    })
  } catch {
    // 畸形启动值不进入主 world；Main 的启动超时会给出稳定失败状态。
    event.ports[0]?.close()
  }
})

ipcRenderer.on(DESKTOP_CHANNELS.hostState, (_event, raw) => {
  try {
    latestHostState = parseRendererHostState(raw)
  } catch {
    // 状态通知不参与业务结算；畸形通知不进入主 world。
  }
})

ipcRenderer.on(DESKTOP_CHANNELS.updateState, (_event, raw) => {
  try {
    latestUpdateState = parseRendererUpdateState(raw)
  } catch {
    // 更新状态不参与业务结算；畸形通知不进入主 world。
  }
})

async function takeBootstrap(): Promise<PendingBootstrap> {
  return bootstrapMailbox.take()
}

const api: DesktopRendererApi = Object.freeze({
  async bootstrap() {
    const value = await takeBootstrap()
    claimed = value
    return value.manifest
  },
  releaseDataPort() {
    const value = claimed
    if (value === undefined) throw new Error('Desktop 数据端口不可用')
    claimed = undefined
    window.postMessage({
      type: DESKTOP_DATA_PORT_MESSAGE,
      protocolVersion: value.manifest.protocolVersion,
      generation: value.manifest.generation,
      nonce: value.manifest.nonce,
    // Electron 隔离 world 的 custom-scheme targetOrigin 兼容性不稳定；主 world 仍校验 source、origin 与一次性 nonce。
    }, '*', [value.port])
  },
  async invoke(command: RendererCommand) {
    const parsed = parseRendererCommand(command)
    return parseRendererCommandResult(await ipcRenderer.invoke(DESKTOP_CHANNELS.command, parsed))
  },
  onHostState(listener: (state: RendererHostState) => void) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      try {
        listener(parseRendererHostState(raw))
      } catch {
        // 状态通知不参与业务结算；畸形通知直接丢弃并等待下一条可信状态。
      }
    }
    ipcRenderer.on(DESKTOP_CHANNELS.hostState, receive)
    if (latestHostState !== undefined) listener(latestHostState)
    return () => { ipcRenderer.removeListener(DESKTOP_CHANNELS.hostState, receive) }
  },
  onUpdateState(listener: (state: DesktopUpdateState) => void) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      try {
        listener(parseRendererUpdateState(raw))
      } catch {
        // 畸形更新状态不进入主 world，等待下一条可信状态。
      }
    }
    ipcRenderer.on(DESKTOP_CHANNELS.updateState, receive)
    if (latestUpdateState !== undefined) listener(latestUpdateState)
    return () => { ipcRenderer.removeListener(DESKTOP_CHANNELS.updateState, receive) }
  },
})

contextBridge.exposeInMainWorld('dshDesktop', api)
