import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAtomicResponse } from '../src/utility/atomic-export.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-export-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('writeAtomicResponse', () => {
  it('同目录写入并原子替换目标，且报告累计字节', async () => {
    const root = await tempRoot()
    const target = join(root, 'session.zip')
    await writeFile(target, 'old')
    const progress = vi.fn()

    await expect(writeAtomicResponse(
      new Response(new Blob(['new-', 'archive'])),
      target,
      new AbortController().signal,
      progress,
      () => 'fixed',
    )).resolves.toBe(11)
    expect(await readFile(target, 'utf8')).toBe('new-archive')
    expect(progress).toHaveBeenLastCalledWith(11)
    expect(await readdir(root)).toEqual(['session.zip'])
  })

  it('取消后删除临时文件并保留已有目标', async () => {
    const root = await tempRoot()
    const target = join(root, 'session.zip')
    await writeFile(target, 'stable')
    const abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        abort.abort(new Error('用户取消'))
      },
    })

    await expect(writeAtomicResponse(
      new Response(body), target, abort.signal, () => undefined, () => 'cancelled',
    )).rejects.toThrow('用户取消')
    expect(await readFile(target, 'utf8')).toBe('stable')
    expect(await readdir(root)).toEqual(['session.zip'])
  })

  it('拒绝没有可读 body 的非成功响应', async () => {
    const root = await tempRoot()
    await expect(writeAtomicResponse(
      new Response('not found', { status: 404 }),
      join(root, 'session.zip'),
      new AbortController().signal,
      () => undefined,
      () => 'failed',
    )).rejects.toThrow('HTTP 404')
    expect(await readdir(root)).toEqual([])
  })
})
