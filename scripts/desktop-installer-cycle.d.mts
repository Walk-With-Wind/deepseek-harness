/** 最终安装器首次安装与重装所处的验收阶段。 */
export type DesktopInstallerPhase = 'initial' | 'reinstall'

/** 最终安装器的平台生命周期操作。 */
export interface DesktopInstallerLifecycle<T> {
  /**
   * 安装最终 maker 产物。
   * @param phase - 当前安装阶段。
   * @returns 平台安装结果，通常为最终可执行文件路径。
   */
  install(phase: DesktopInstallerPhase): T

  /**
   * 对当前安装结果执行阶段对应的 smoke。
   * @param installation - 当前平台安装结果。
   * @param phase - 当前安装阶段。
   */
  smoke(installation: T, phase: DesktopInstallerPhase): void

  /**
   * 幂等卸载当前安装并验证用户可执行文件已移除。
   * @param phase - 当前卸载所清理的安装阶段。
   */
  uninstall(phase: DesktopInstallerPhase): void
}

/**
 * 统一执行最终安装器的首次安装、卸载、重装与最终清理。
 * @param lifecycle - 平台安装器提供的幂等生命周期操作。
 */
export function exerciseInstallerLifecycle<T>(lifecycle: DesktopInstallerLifecycle<T>): void
