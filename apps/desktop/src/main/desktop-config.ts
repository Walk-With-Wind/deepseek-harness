/** 从签名应用资源中读取 Main 的部署可调配置。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDesktopConfig, type DesktopConfig } from '../shared/control-protocol.ts'

/**
 * 读取并验证 app-private Desktop 配置；缺失、损坏或越界时拒绝启动。
 * @param appRoot - Electron app 根目录或测试夹具目录。
 * @returns 补齐默认值且通过全部交叉约束的配置。
 */
export function readDesktopConfig(appRoot: string): DesktopConfig {
  const path = join(appRoot, 'desktop.config.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Desktop 配置无法读取：${path}`, { cause: error })
  }
  return parseDesktopConfig(value)
}
