/** Desktop 构建身份；发行脚本生成，开发模式使用明确占位值。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DISTRIBUTION,
  DESKTOP_PUBLISHER,
  DESKTOP_REPOSITORY,
  desktopNativeVersions,
} from '../shared/release-policy.ts'

export interface DesktopBuildInfo {
  readonly distribution: typeof DESKTOP_DISTRIBUTION
  readonly repository: typeof DESKTOP_REPOSITORY
  readonly applicationId: typeof DESKTOP_APPLICATION_ID
  readonly publisher: typeof DESKTOP_PUBLISHER
  readonly version: string
  readonly sourceCommit: string
  readonly sourceDate: string
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly releaseMode: 'development' | 'unsigned-preview' | 'signed'
}

/** 从 app 根读取构建身份并严格校验；缺失时返回开发身份。 */
export function readDesktopBuildInfo(appRoot: string, appVersion: string): DesktopBuildInfo {
  const path = join(appRoot, 'build-info.json')
  if (!existsSync(path)) {
    const electronVersion = Reflect.get(process.versions, 'electron')
    return {
      distribution: DESKTOP_DISTRIBUTION,
      repository: DESKTOP_REPOSITORY,
      applicationId: DESKTOP_APPLICATION_ID,
      publisher: DESKTOP_PUBLISHER,
      version: appVersion,
      sourceCommit: 'development',
      sourceDate: new Date(0).toISOString(),
      electronVersion: typeof electronVersion === 'string' ? electronVersion : 'development',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      releaseMode: 'development',
    }
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const required = [
    'distribution', 'repository', 'applicationId', 'publisher',
    'version', 'sourceCommit', 'sourceDate', 'electronVersion', 'nodeVersion', 'platform', 'arch',
    'releaseMode',
  ] as const
  for (const field of required) {
    if (typeof value[field] !== 'string' || value[field] === '' || value[field].length > 128) {
      throw new Error(`Desktop build-info 缺少有效 ${field}`)
    }
  }
  if (value.distribution !== DESKTOP_DISTRIBUTION
    || value.repository !== DESKTOP_REPOSITORY
    || value.applicationId !== DESKTOP_APPLICATION_ID
    || value.publisher !== DESKTOP_PUBLISHER) {
    throw new Error('Desktop build-info 发行身份无效')
  }
  if (value.version !== appVersion
    && desktopNativeVersions(value.version as string, 1).appVersion !== appVersion) {
    throw new Error('Desktop build-info 与应用版本不一致')
  }
  if (value.sourceCommit !== 'development' && !/^[a-f0-9]{40}$/.test(value.sourceCommit as string)) {
    throw new Error('Desktop build-info sourceCommit 无效')
  }
  if (value.releaseMode !== 'development'
    && value.releaseMode !== 'unsigned-preview'
    && value.releaseMode !== 'signed') {
    throw new Error('Desktop build-info releaseMode 无效')
  }
  if (!Number.isFinite(Date.parse(value.sourceDate as string))) throw new Error('Desktop build-info sourceDate 无效')
  return value as unknown as DesktopBuildInfo
}
