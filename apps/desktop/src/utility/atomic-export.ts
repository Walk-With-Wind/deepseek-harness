/** Utility 侧 Session ZIP 同目录临时写入与原子替换。 */
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { KoffiFunc } from 'koffi'

/**
 * 把 Host 响应流写入 owner-only 临时文件，sync 后原子替换目标。
 * @param response - 现有 Session 导出 handler 返回的响应。
 * @param targetPath - Main 经系统保存对话框批准的绝对路径。
 * @param signal - Renderer/关停取消信号。
 * @param onProgress - 接收累计写入字节数。
 * @param createToken - 临时文件唯一后缀；测试可提供确定值。
 * @returns 成功落盘的总字节数。
 */
export async function writeAtomicResponse(
  response: Response,
  targetPath: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  createToken: () => string = () => crypto.randomUUID(),
): Promise<number> {
  if (!isAbsolute(targetPath)) throw new Error('Session ZIP 目标必须是绝对路径')
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Session ZIP 导出失败：HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail}`}`)
  }
  const parent = dirname(targetPath)
  const tempPath = join(parent, `.${basename(targetPath)}.${createToken()}.tmp`)
  const reader = response.body.getReader()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let committed = false
  let bytes = 0
  try {
    signal.throwIfAborted()
    handle = await open(tempPath, 'wx', 0o600)
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      let offset = 0
      while (offset < chunk.value.byteLength) {
        signal.throwIfAborted()
        const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, null)
        offset += written.bytesWritten
      }
      bytes += chunk.value.byteLength
      onProgress(bytes)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await atomicReplace(tempPath, targetPath)
    committed = true
    await syncDirectory(parent)
    return bytes
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    if (!committed) await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function atomicReplace(source: string, target: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(source, target)
    return
  }
  const koffi = await import('koffi')
  const kernel32 = koffi.load('kernel32.dll')
  const moveFileExW = kernel32.func(
    '__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32'],
  ) as KoffiFunc<(
    sourcePath: string, targetPath: string, flags: number,
  ) => number>
  const getLastError = kernel32.func(
    '__stdcall', 'GetLastError', 'uint32', [],
  ) as KoffiFunc<() => number>
  // REPLACE_EXISTING 保留原子替换语义，WRITE_THROUGH 要求落盘后才返回。
  if (moveFileExW(source, target, 0x1 | 0x8) === 0) {
    throw new Error(`MoveFileExW failed with Win32 error ${String(getLastError())}`)
  }
}
