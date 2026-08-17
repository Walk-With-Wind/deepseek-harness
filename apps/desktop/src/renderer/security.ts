/** Renderer 主 world 启动时可观测的最小权限状态。 */
export interface DesktopRendererSecuritySnapshot {
  readonly origin: string
  readonly requireType: string
  readonly processType: string
  readonly bridgeKeys: readonly string[]
  readonly bridgeFrozen: boolean
}

const DESKTOP_BRIDGE_KEYS = [
  'bootstrap', 'invoke', 'onHostState', 'onUpdateState', 'releaseDataPort',
] as const

/**
 * 拒绝不可信 origin、Node 全局或扩张后的 Preload 桥进入 GUI bootstrap。
 * @param snapshot - Renderer 主 world 在执行产品代码前采集的权限状态。
 */
export function assertDesktopRendererSecurity(snapshot: DesktopRendererSecuritySnapshot): void {
  const keys = [...snapshot.bridgeKeys].sort()
  if (snapshot.origin !== 'app://localhost'
    || snapshot.requireType !== 'undefined'
    || snapshot.processType !== 'undefined'
    || JSON.stringify(keys) !== JSON.stringify(DESKTOP_BRIDGE_KEYS)
    || !snapshot.bridgeFrozen) {
    throw new Error('Desktop Renderer 安全不变量不满足')
  }
}
