import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

/** 创建一个稳定命名且不产生哈希共享文件的单入口 Node bundle。 */
function companion(entry: string): UserConfig {
  return {
    entry: [entry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
}

export default clientBundle('@deepseek-ai/dsh-client-connection', ['lib/types/index.js'], {
  // 四个公开入口分别闭合，发布清单不依赖不稳定的哈希共享文件名。
  companions: [
    companion('lib/types/invariant.js'),
    companion('lib/types/ipc-host.js'),
    companion('lib/types/web.js'),
  ],
})
