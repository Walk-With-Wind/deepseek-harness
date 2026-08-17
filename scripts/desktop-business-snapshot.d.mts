/** 共享业务快照中的文件或符号链接摘要。 */
export interface DesktopBusinessEntry {
  readonly path: string
  readonly kind: 'file' | 'symlink'
  readonly digest: string
}

/**
 * 记录租约失败方不得修改的共享业务数据。
 * @param home - 已由 Desktop Host 使用的 DSH_HOME。
 * @returns 稳定排序且不含文件正文的快照。
 */
export function snapshotDesktopBusinessData(home: string): DesktopBusinessEntry[]

/**
 * 断言竞争 Host 退出前后没有共享业务数据写入。
 * @param before - 竞争启动前快照。
 * @param after - 竞争退出后快照。
 */
export function assertDesktopBusinessDataUnchanged(
  before: readonly DesktopBusinessEntry[],
  after: readonly DesktopBusinessEntry[],
): void
