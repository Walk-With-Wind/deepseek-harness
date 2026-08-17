/** Desktop 发行身份和远端位置的单一事实源。 */
export const DESKTOP_APPLICATION_ID = 'ai.deepseek.harness'
/** Desktop 发行产物只面向 macOS 和 Windows。 */
export type DesktopReleasePlatform = 'darwin' | 'win32'

/**
 * 拒绝非发行平台，并让调用方获得受支持平台的类型收窄。
 * @param platform - 待校验的 Node 平台标识。
 */
export function assertDesktopReleasePlatform(
  platform: string,
): asserts platform is DesktopReleasePlatform {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Desktop 不支持平台 ${platform}`)
  }
}

/** Squirrel NuGet 包名，不含空格。 */
export const DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID = 'DeepSeekHarness'
/** 各平台安装包内的可执行文件名，不含平台扩展名。 */
export const DESKTOP_EXECUTABLE_NAME = 'deepseek-harness'
/** 必须与 Squirrel 生成快捷方式使用的 Windows 应用身份完全一致。 */
export const DESKTOP_WINDOWS_APP_USER_MODEL_ID = `com.squirrel.${DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID}.${DESKTOP_EXECUTABLE_NAME}`
/** 生产更新源编译进 Main，Renderer、用户设置和运行时环境变量均不能覆盖。 */
export const DESKTOP_UPDATE_ORIGIN = 'https://desktop-updates.deepseek.com'
