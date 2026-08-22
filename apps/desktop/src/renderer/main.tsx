/** Desktop Renderer 入口：领取端口后把通用 GUI 入口与桌面平台 provider 组装起来。 */
import { createRoot } from 'react-dom/client'
import { IpcClientCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/bootstrap'
import { AppGuiEntry } from '@deepseek-ai/dsh-client-web'
import * as DesktopPlatform from './platform-plugin.ts'
import { DesktopStatusLayer } from './recovery-layer.tsx'
import { DESKTOP_DATA_PORT_MESSAGE } from '../shared/channels.ts'
import { assertDesktopRendererSecurity } from './security.ts'
import { runInstalledUnaryLatencyAcceptance } from './installed-unary-latency.ts'
import type {
  DesktopBootstrap,
  DesktopUpdateState,
  RendererHostState,
} from '../shared/renderer-protocol.ts'

const appElement = document.getElementById('root')
const statusElement = document.getElementById('desktop-status')
const api = window.dshDesktop
if (appElement === null || statusElement === null) throw new Error('Desktop 页面缺少挂载点')
if (api === undefined) throw new Error('Desktop preload API 不可用')
assertDesktopRendererSecurity({
  origin: window.location.origin,
  requireType: typeof Reflect.get(globalThis, 'require'),
  processType: typeof Reflect.get(globalThis, 'process'),
  bridgeKeys: Object.keys(api),
  bridgeFrozen: Object.isFrozen(api),
})
const appMount = appElement
const desktopApi = api

const statusRoot = createRoot(statusElement)
let hostState: RendererHostState = { phase: 'STARTING', generation: 0 }
let updateState: DesktopUpdateState | undefined
const renderStatus = (): void => {
  statusRoot.render(<DesktopStatusLayer hostState={hostState} updateState={updateState} api={desktopApi} />)
}
renderStatus()
const unsubscribeState = api.onHostState((state) => {
  hostState = state
  renderStatus()
})
const unsubscribeUpdate = api.onUpdateState((state) => {
  updateState = state
  renderStatus()
})

function waitForDataPort(bootstrap: DesktopBootstrap): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const receive = (event: MessageEvent<unknown>): void => {
      // Electron 隔离 world 转交的事件不保证暴露同一个 WindowProxy；origin、代际与一次性 nonce 共同鉴权。
      const [port] = event.ports
      if (event.origin !== 'app://localhost') return
      if (typeof event.data !== 'object' || event.data === null) return
      const data = event.data as Record<string, unknown>
      if (data.type !== DESKTOP_DATA_PORT_MESSAGE
        || data.protocolVersion !== bootstrap.protocolVersion
        || data.generation !== bootstrap.generation
        || data.nonce !== bootstrap.nonce
        || event.ports.length !== 1
        || port === undefined) return
      window.removeEventListener('message', receive)
      resolve(port)
    }
    window.addEventListener('message', receive)
    window.addEventListener('unload', () => {
      window.removeEventListener('message', receive)
      reject(new Error('Desktop 页面在数据端口交付前退出'))
    }, { once: true })
  })
}

let entry: AppGuiEntry | undefined
let carrier: IpcClientCarrier | undefined

async function boot(): Promise<void> {
  const bootstrap = await desktopApi.bootstrap()
  hostState = { phase: 'STARTING', generation: bootstrap.generation }
  renderStatus()
  const portPromise = waitForDataPort(bootstrap)
  desktopApi.releaseDataPort()
  const port = await portPromise
  carrier = new IpcClientCarrier(port, { generation: bootstrap.generation })
  await carrier.ready()
  if (bootstrap.installedUnaryLatencyAcceptance === true) {
    await runInstalledUnaryLatencyAcceptance(carrier)
  }
  entry = new AppGuiEntry(appMount, {
    manifest: parseBootManifest(bootstrap.boot),
    carrier,
    platformCapabilities: { kind: 'desktop' },
    staticPlugins: [{
      id: '@deepseek-ai/dsh-desktop-platform',
      module: DesktopPlatform,
    }],
  })
  const result = await entry.run()
  if (result.outcome === 'ready') {
    await desktopApi.invoke({ type: 'renderer/ready', generation: bootstrap.generation })
  } else {
    await desktopApi.invoke({
      type: 'renderer/failed',
      generation: bootstrap.generation,
      message: result.message,
    })
  }
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  hostState = {
    phase: 'FAILED',
    generation: hostState.generation,
    code: 'RENDERER_BOOT_FAILED',
    message,
  }
  renderStatus()
  if (hostState.generation > 0) {
    void desktopApi.invoke({
      type: 'renderer/failed',
      generation: hostState.generation,
      message,
    })
  }
})

window.addEventListener('unload', () => {
  unsubscribeState()
  unsubscribeUpdate()
  void entry?.dispose()
  void carrier?.close('Renderer 页面退出')
  statusRoot.unmount()
}, { once: true })
