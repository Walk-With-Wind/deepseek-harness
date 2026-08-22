/** 与桌面 Renderer 同包编译的平台能力 provider。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import { DesktopSessionLogSaver } from './session-log-saver.ts'

/** Desktop 平台能力必须在共享连接服务之后挂载。 */
export const inject = ['connection']

/** 等待共享连接控制器完成 unary 探测和两条下行流握手。 */
async function waitForHostReady(source: HostDescriptionSource): Promise<void> {
  if (source.getSnapshot() !== undefined) return
  await new Promise<void>((resolve) => {
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot() === undefined) return
      unsubscribe()
      resolve()
    })
    // 订阅建立后重读一次，避免描述在首次读取与订阅之间完成发布。
    if (source.getSnapshot() !== undefined) {
      unsubscribe()
      resolve()
    }
  })
}

/**
 * 提供仅 Desktop 可用的 Session ZIP 保存能力，并把 Renderer ready 结算推迟到业务载体可达。
 * @param ctx - Desktop Renderer 的客户端 Cordis 上下文。
 * @returns unary 与双下行流完成连接后解决。
 */
export async function apply(ctx: Context): Promise<void> {
  const api = window.dshDesktop
  if (api === undefined) throw new Error('Desktop preload API 不可用')
  ctx.provide('sessionLogSaver', new DesktopSessionLogSaver(api))
  const connection = (ctx as Context & { readonly connection: ConnectionHandle }).connection
  await waitForHostReady(connection.hostDescription)
}
