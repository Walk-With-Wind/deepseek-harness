import { describe, expect, it } from 'vitest'
import { runDesktopExportStress } from './desktop-export-stress.ts'

describe('Desktop export stress', () => {
  it('缩放验证取消清理、成功容量和流式 RSS 上限', async () => {
    await expect(runDesktopExportStress({
      totalBytes: 4 * 1024 * 1024,
      chunkBytes: 256 * 1024,
      cancelAfterBytes: 1024 * 1024,
      maxRssDeltaBytes: 64 * 1024 * 1024,
    })).resolves.toMatchObject({
      totalBytes: 4 * 1024 * 1024,
      chunkBytes: 256 * 1024,
    })
  })

  it('拒绝不完整的容量参数', async () => {
    await expect(runDesktopExportStress({
      totalBytes: 1,
      chunkBytes: 1,
      cancelAfterBytes: 1,
      maxRssDeltaBytes: 1,
    })).rejects.toThrow(/参数必须/)
  })
})
