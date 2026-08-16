/**
 * 统一执行最终安装器的首次安装、卸载、重装与最终清理。
 * @template T
 * @param {{
 *   install(phase: 'initial' | 'reinstall'): T,
 *   smoke(installation: T, phase: 'initial' | 'reinstall'): void,
 *   uninstall(phase: 'initial' | 'reinstall'): void,
 * }} lifecycle - 平台安装器提供的幂等生命周期操作。
 * @returns {void}
 */
export function exerciseInstallerLifecycle(lifecycle) {
  let phase = 'initial'
  try {
    const initialInstallation = lifecycle.install(phase)
    lifecycle.smoke(initialInstallation, phase)
    lifecycle.uninstall(phase)

    phase = 'reinstall'
    const reinstalled = lifecycle.install(phase)
    lifecycle.smoke(reinstalled, phase)
  } finally {
    // 卸载操作必须幂等，才能同时清理由安装失败留下的部分状态和正常重装结果。
    lifecycle.uninstall(phase)
  }
}
