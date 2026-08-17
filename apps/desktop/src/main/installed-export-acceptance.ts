import { lstatSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 最终安装应用导出容量门禁使用的显式命令行开关。 */
export const DESKTOP_INSTALLED_EXPORT_ACCEPTANCE_SWITCH = '--dsh-desktop-installed-export-acceptance'

/** 最终安装应用真实 Electron IPC 延迟门禁使用的显式命令行开关。 */
export const DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE_SWITCH = '--dsh-desktop-installed-unary-latency-acceptance'

/** 解析不需要文件目标的安装态门禁所需进程事实。 */
export interface InstalledAcceptanceOptions {
  readonly argv: readonly string[]
  readonly ci: boolean
  readonly packaged: boolean
}

/** 解析最终安装应用容量验收所需的进程事实。 */
export interface InstalledExportAcceptanceOptions extends InstalledAcceptanceOptions {
  readonly home: string
}

/**
 * 只为已打包 CI 进程启用真实 Electron IPC 延迟门禁。
 * @param options - 命令行和运行环境事实。
 * @returns 显式开关处于受控安装态进程时返回 true。
 */
export function resolveInstalledUnaryLatencyAcceptance(
  options: InstalledAcceptanceOptions,
): boolean {
  return options.argv.includes(DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE_SWITCH)
    && options.ci
    && options.packaged
}

/**
 * 只为已打包 CI 进程解析固定的 Home 内导出目标。
 * @param options - 命令行、运行环境和规范 Home。
 * @returns 未启用时返回 undefined；启用时返回私有目录内的固定 ZIP 路径。
 */
export function resolveInstalledExportAcceptancePath(
  options: InstalledExportAcceptanceOptions,
): string | undefined {
  if (!options.argv.includes(DESKTOP_INSTALLED_EXPORT_ACCEPTANCE_SWITCH)) return undefined
  if (!options.ci || !options.packaged) return undefined

  const canonicalHome = realpathSync(resolve(options.home))
  const directory = resolve(canonicalHome, '.desktop-acceptance', 'export')
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(directory)
  } catch {
    throw new Error('Desktop 验收导出目录不存在')
  }
  if (metadata.isSymbolicLink()) throw new Error('Desktop 验收导出目录不能是符号链接')
  if (!metadata.isDirectory()) throw new Error('Desktop 验收导出目标不是目录')
  if (realpathSync(directory) !== directory) throw new Error('Desktop 验收导出目录解析结果不一致')
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Desktop 验收导出目录权限不安全')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && metadata.uid !== uid) throw new Error('Desktop 验收导出目录属主不匹配')
  return join(directory, 'session-export.zip')
}
