import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 删除一次 Desktop Forge 运行的专属输出，避免重跑混入先前产物。
 * @param root - 仓库根目录。
 */
export async function resetDesktopForgeOutput(root: string): Promise<void> {
  await rm(resolve(root, '.artifacts/desktop/out'), { force: true, recursive: true })
}
