/** 在一次性 CI runner 上执行 1 GiB Session 导出容量门禁。 */
import { runDesktopExportStress } from './lib/desktop-export-stress.ts'

if (process.env.CI !== 'true') {
  throw new Error('desktop-export-stress: 只允许在一次性 CI runner 上写入 1 GiB 合成数据')
}

const result = await runDesktopExportStress({
  totalBytes: 1024 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  cancelAfterBytes: 128 * 1024 * 1024,
  maxRssDeltaBytes: 128 * 1024 * 1024,
})
console.log(JSON.stringify({ outcome: 'passed', ...result }, null, 2))
