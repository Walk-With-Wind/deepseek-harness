/** Desktop 最终应用路径与发行期 ASAR 工具加载。 */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_PRODUCT_NAME,
} from '../../apps/desktop/src/shared/release-policy.ts'

/** ASAR 内普通文件的定位信息。 */
interface DesktopAsarFile {
  readonly offset: string
  readonly size: number
  readonly unpacked?: boolean
}

/** Desktop 发行脚本使用的最小 ASAR API。 */
export interface DesktopAsarModule {
  listPackage(path: string): string[]
  getRawHeader(path: string): { headerString: string; headerSize: number }
  statFile(path: string, filename: string): DesktopAsarFile
  extractFile(path: string, filename: string): Buffer
}

/** 最终应用、可执行文件和资源目录。 */
export interface DesktopArtifactPaths {
  readonly app: string
  readonly executable: string
  readonly resources: string
}

const root = resolve(import.meta.dirname, '../..')
const appRequire = createRequire(resolve(root, 'apps/desktop/package.json'))

/**
 * 定位当前发行根目录中的原生 packaged 应用。
 * @param platform - 目标操作系统。
 * @param arch - 目标 CPU 架构。
 * @returns 应用根、可执行文件和资源目录。
 */
export function desktopArtifactPaths(platform: NodeJS.Platform, arch: string): DesktopArtifactPaths {
  const product = resolve(root, '.artifacts/desktop/out', `${DESKTOP_PRODUCT_NAME}-${platform}-${arch}`)
  if (platform === 'darwin') {
    const app = join(product, `${DESKTOP_PRODUCT_NAME}.app`)
    return {
      app,
      executable: join(app, 'Contents', 'MacOS', DESKTOP_EXECUTABLE_NAME),
      resources: join(app, 'Contents', 'Resources'),
    }
  }
  return {
    app: product,
    executable: join(product, platform === 'win32'
      ? `${DESKTOP_EXECUTABLE_NAME}.exe`
      : DESKTOP_EXECUTABLE_NAME),
    resources: join(product, 'resources'),
  }
}

/**
 * 从 Forge 已固定的依赖闭包加载 ASAR 实现，不依赖根目录幽灵依赖。
 * @returns 与 Forge packager 相同闭包中的 ASAR API。
 */
export async function loadDesktopAsar(): Promise<DesktopAsarModule> {
  const cliManifest = appRequire.resolve('@electron-forge/cli/package.json')
  const cliRequire = createRequire(cliManifest)
  const coreManifest = cliRequire.resolve('@electron-forge/core/package.json')
  const coreRequire = createRequire(coreManifest)
  const packagerManifest = coreRequire.resolve('@electron/packager/package.json')
  const packagerRequire = createRequire(packagerManifest)
  const path = packagerRequire.resolve('@electron/asar')
  return await import(pathToFileURL(path).href) as DesktopAsarModule
}
