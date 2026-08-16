/** Desktop 发行身份和远端位置的单一事实源。 */
export const DESKTOP_APPLICATION_ID = 'ai.deepseek.harness'
/** Squirrel NuGet 包名，不含空格。 */
export const DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID = 'DeepSeekHarness'
/** 各平台安装包内的可执行文件名，不含平台扩展名。 */
export const DESKTOP_EXECUTABLE_NAME = 'deepseek-harness'
/** 必须与 Squirrel 生成快捷方式使用的 Windows 应用身份完全一致。 */
export const DESKTOP_WINDOWS_APP_USER_MODEL_ID = `com.squirrel.${DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID}.${DESKTOP_EXECUTABLE_NAME}`
export const DESKTOP_RELEASE_PAGE_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
/** 生产更新源编译进 Main，Renderer、用户设置和运行时环境变量均不能覆盖。 */
export const DESKTOP_UPDATE_ORIGIN = 'https://desktop-updates.deepseek.com'
