/** Desktop Session 导出的流式容量验收。 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtomicResponse } from '../../apps/desktop/src/utility/atomic-export.ts'

/** 一次导出容量验收的参数。 */
export interface DesktopExportStressOptions {
  readonly totalBytes: number
  readonly chunkBytes: number
  readonly cancelAfterBytes: number
  readonly maxRssDeltaBytes: number
}

/** 导出容量验收产生的可归档指标。 */
export interface DesktopExportStressResult {
  readonly totalBytes: number
  readonly chunkBytes: number
  readonly maxRssDeltaBytes: number
}

/**
 * 先取消再成功写入同一份合成 Session 流，并验证内存增量与临时文件清理。
 * @param options - 总量、分块、取消点和 RSS 增量上限。
 * @returns 成功导出的容量与进程 RSS 峰值增量。
 */
export async function runDesktopExportStress(
  options: DesktopExportStressOptions,
): Promise<DesktopExportStressResult> {
  validateOptions(options)
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-export-stress-'))
  const target = join(root, 'synthetic-session.zip')
  try {
    const cancel = new AbortController()
    await writeAtomicResponse(
      new Response(syntheticBody(options.totalBytes, options.chunkBytes)),
      target,
      cancel.signal,
      bytes => {
        if (bytes >= options.cancelAfterBytes) cancel.abort(new Error('容量验收主动取消'))
      },
      () => 'cancelled',
    ).then(
      () => { throw new Error('desktop-export-stress: 取消导出意外成功') },
      error => {
        if (!(error instanceof Error) || error.message !== '容量验收主动取消') throw error
      },
    )
    if ((await readdir(root)).length !== 0) {
      throw new Error('desktop-export-stress: 取消导出留下目标或临时文件')
    }

    const baselineRss = process.memoryUsage().rss
    let peakRss = baselineRss
    const written = await writeAtomicResponse(
      new Response(syntheticBody(options.totalBytes, options.chunkBytes)),
      target,
      new AbortController().signal,
      () => { peakRss = Math.max(peakRss, process.memoryUsage().rss) },
      () => 'success',
    )
    const targetStat = await stat(target)
    if (written !== options.totalBytes || targetStat.size !== options.totalBytes) {
      throw new Error('desktop-export-stress: 成功导出字节数与目标容量不一致')
    }
    const maxRssDeltaBytes = Math.max(0, peakRss - baselineRss)
    if (maxRssDeltaBytes > options.maxRssDeltaBytes) {
      throw new Error(
        `desktop-export-stress: RSS 增量 ${String(maxRssDeltaBytes)} 超过 ${String(options.maxRssDeltaBytes)}`,
      )
    }
    if ((await readdir(root)).some(name => name !== 'synthetic-session.zip')) {
      throw new Error('desktop-export-stress: 成功导出留下临时文件')
    }
    return { totalBytes: written, chunkBytes: options.chunkBytes, maxRssDeltaBytes }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function syntheticBody(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(chunkBytes, totalBytes - offset)
      offset += size
      controller.enqueue(new Uint8Array(size))
    },
  }, { highWaterMark: 1 })
}

function validateOptions(options: DesktopExportStressOptions): void {
  if (!Number.isSafeInteger(options.totalBytes) || options.totalBytes <= 0
    || !Number.isSafeInteger(options.chunkBytes) || options.chunkBytes <= 0
    || !Number.isSafeInteger(options.cancelAfterBytes) || options.cancelAfterBytes <= 0
    || options.cancelAfterBytes >= options.totalBytes
    || !Number.isSafeInteger(options.maxRssDeltaBytes) || options.maxRssDeltaBytes <= 0) {
    throw new Error('desktop-export-stress: 参数必须是合法的正整数且取消点位于流内部')
  }
}
