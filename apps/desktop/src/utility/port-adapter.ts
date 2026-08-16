/** Electron MessagePortMain 到进程中立 IPC port 接口的最小适配。 */
import type { IpcMessagePort } from '@deepseek-ai/dsh-client-connection/ipc-host'

/** 仅暴露 carrier 所需成员，避免共享包导入 Electron。 */
export class ElectronUtilityPortAdapter implements IpcMessagePort {
  private readonly listeners = new Map<
    (event: MessageEvent<unknown>) => void,
    (event: Electron.MessageEvent) => void
  >()

  /** @param port - Utility 接收的 Electron 数据端口。 */
  constructor(private readonly port: Electron.MessagePortMain) {}

  /** @inheritdoc */
  postMessage(message: unknown): void {
    this.port.postMessage(message)
  }

  /** @inheritdoc */
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    const wrapped = (event: Electron.MessageEvent): void => { listener({ data: event.data } as MessageEvent<unknown>) }
    this.listeners.set(listener, wrapped)
    this.port.on('message', wrapped)
  }

  /** @inheritdoc */
  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    const wrapped = this.listeners.get(listener)
    if (wrapped === undefined) return
    this.listeners.delete(listener)
    this.port.off('message', wrapped)
  }

  /** @inheritdoc */
  start(): void {
    this.port.start()
  }

  /** @inheritdoc */
  subscribeClose(listener: () => void): () => void {
    this.port.on('close', listener)
    return () => { this.port.off('close', listener) }
  }

  /** @inheritdoc */
  close(): void {
    this.listeners.clear()
    this.port.close()
  }
}
