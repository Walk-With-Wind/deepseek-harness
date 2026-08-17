/** OS session end 到 Desktop 有界关停的公共适配。 */
export interface DesktopShutdownTarget {
  /** 当前是否已经允许进程结束。 */
  canExit(): boolean
  /** 首次原因生效的有界关停入口。 */
  stop(reason: string): void
}

/**
 * 把可阻止或不可阻止的系统结束事件接入同一关停协议。
 * @param target - Main 生命周期所有者。
 * @param event - 可选的 Electron 可阻止事件。
 * @returns 是否新发出了关停请求。
 */
export function requestSystemSessionEnd(
  target: DesktopShutdownTarget | undefined,
  event?: { preventDefault(): void },
): boolean {
  if (target === undefined || target.canExit()) return false
  event?.preventDefault()
  target.stop('操作系统会话结束')
  return true
}
