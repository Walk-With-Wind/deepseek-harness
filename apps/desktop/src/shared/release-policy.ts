/** Desktop 发行身份和远端位置的单一事实源。 */
export const DESKTOP_PRODUCT_NAME = 'DeepSeek Harness Community Build'
/** DMG 卷标受 macOS Alias 27 字符上限约束，不改变应用产品名。 */
export const DESKTOP_DMG_VOLUME_NAME = 'DeepSeek Harness Community'
/** 社区发行者；签名、安装器和 About 信息必须使用同一值。 */
export const DESKTOP_PUBLISHER = 'Walk-With-Wind'
/** 社区发行使用的独立 macOS bundle 与跨平台应用身份。 */
export const DESKTOP_APPLICATION_ID = 'io.github.walk-with-wind.deepseek-harness'
/** 社区发行的源码和不可变 Release 资产仓库。 */
export const DESKTOP_REPOSITORY = 'https://github.com/Walk-With-Wind/deepseek-harness'
/** 发行材料中的稳定分发类型。 */
export const DESKTOP_DISTRIBUTION = 'community'

/**
 * 把产品 SemVer 映射为平台资源接受的纯数字版本和单调构建号。
 * @param productVersion - 保留预发布标识的产品 SemVer。
 * @param buildSequence - CI 为每次原生构建分配的正整数序列。
 * @returns 三段产品版本和满足 Apple 段长约束的单调构建版本。
 */
export function desktopNativeVersions(
  productVersion: string,
  buildSequence: number,
): { readonly appVersion: string; readonly buildVersion: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(productVersion)
  if (match === null) throw new Error(`Desktop 产品版本无效 ${productVersion}`)
  if (!Number.isSafeInteger(buildSequence) || buildSequence < 1 || buildSequence > 99_989_999) {
    throw new Error(`Desktop 原生构建序列无效 ${String(buildSequence)}`)
  }
  const first = Math.floor(buildSequence / 10_000) + 1
  const second = Math.floor(buildSequence / 100) % 100
  const third = buildSequence % 100
  return {
    appVersion: `${match[1]}.${match[2]}.${match[3]}`,
    buildVersion: `${String(first)}.${String(second)}.${String(third)}`,
  }
}
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
export const DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID = 'DeepSeekHarnessCommunity'
/** Squirrel 交付给测试者和最终用户的安装器文件名。 */
export const DESKTOP_WINDOWS_SETUP_EXE = 'DeepSeek-Harness-Community-Setup.exe'
/** 各平台安装包内的可执行文件名，不含平台扩展名。 */
export const DESKTOP_EXECUTABLE_NAME = 'deepseek-harness-community'
/** 必须与 Squirrel 生成快捷方式使用的 Windows 应用身份完全一致。 */
export const DESKTOP_WINDOWS_APP_USER_MODEL_ID = `com.squirrel.${DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID}.${DESKTOP_EXECUTABLE_NAME}`
/** 生产更新源编译进 Main，Renderer、用户设置和运行时环境变量均不能覆盖。 */
export const DESKTOP_UPDATE_ORIGIN = 'https://walk-with-wind.github.io'
/** GitHub Pages 上按通道和平台投影的更新元数据根目录。 */
export const DESKTOP_UPDATE_BASE_URL = `${DESKTOP_UPDATE_ORIGIN}/deepseek-harness/desktop-updates`
/** 所有版本化更新资产必须来自 fork 的 GitHub Releases。 */
export const DESKTOP_RELEASE_DOWNLOAD_BASE_URL = `${DESKTOP_REPOSITORY}/releases/download`

/**
 * 验证更新资产只来自 Community fork 的不可变版本 Release。
 * @param value - 更新元数据中的绝对资产地址。
 * @param version - 已知目标产品版本；省略时从 tag 验证任一合法 SemVer。
 */
export function assertDesktopReleaseDownloadUrl(value: string, version?: string): void {
  const expected = new URL(`${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/`)
  const actual = new URL(value)
  const prefix = expected.pathname.split('/').filter(Boolean)
  const parts = actual.pathname.split('/').filter(Boolean)
  const matchesPrefix = prefix.every((part, index) => parts[index] === part)
  const tag = parts[prefix.length]
  const asset = parts[prefix.length + 1]
  const validTag = version === undefined
    ? /^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')
    : tag === desktopReleaseTag(version)
  if (actual.protocol !== 'https:'
    || actual.origin !== expected.origin
    || actual.username !== ''
    || actual.password !== ''
    || actual.search !== ''
    || actual.hash !== ''
    || !matchesPrefix
    || parts.length !== prefix.length + 2
    || !validTag
    || asset === undefined
    || asset === '') {
    throw new Error('更新资产不属于当前 fork Release')
  }
}
/**
 * Map the shared dsh semantic version to the official release-family tag.
 * @param version - Valid dsh semantic version without the tag prefix.
 * @returns GitHub Release tag shared with the official dsh release family.
 */
export function desktopReleaseTag(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Desktop 发行版本无效 ${version}`)
  }
  return `dsh-v${version}`
}
