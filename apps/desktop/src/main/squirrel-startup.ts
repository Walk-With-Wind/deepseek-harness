/** Squirrel.Windows 安装、更新与卸载事件必须在常规 Desktop 启动前完成。 */
import squirrelStartup from 'electron-squirrel-startup'

/** 测试可注入检测结果；生产默认值来自官方 Squirrel 启动处理器。 */
export function shouldExitForSquirrelStartup(
  platform: NodeJS.Platform,
  handled: boolean = squirrelStartup,
): boolean {
  return platform === 'win32' && handled
}
