/** Desktop Host 进程共用的字段白名单 JSONL 日志。 */
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** 可写入本地诊断日志的有限字段。 */
export interface DesktopLogEvent {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly event: string
  readonly generation?: number
  readonly phase?: string
  readonly stableCode?: string
  readonly durationMs?: number
  readonly pid?: number
}

/** 按大小与保留数量轮转单进程 JSONL 日志。 */
export class DesktopJsonlLogger {
  private readonly path: string | undefined

  /**
   * @param home - 已解析的 DSH_HOME。
   * @param processName - 固定进程名。
   * @param appVersion - 应用版本。
   * @param maxBytes - 单文件字节上限。
   * @param maxFiles - 包含当前文件的保留数量。
   */
  constructor(
    home: string,
    private readonly processName: 'main' | 'utility' | 'renderer-crash',
    private readonly appVersion: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    try {
      const directory = join(home, 'logs', 'desktop')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.path = join(directory, `${processName}.jsonl`)
    } catch {
      // 诊断 sink 不可用时不能改变宿主的启动或关停结果。
      this.path = undefined
    }
  }

  /** 只序列化声明的诊断字段，丢弃调用方对象上的额外值。 */
  write(value: DesktopLogEvent): void {
    const path = this.path
    if (path === undefined) return
    const record = {
      timestamp: new Date().toISOString(),
      level: value.level,
      process: this.processName,
      appVersion: this.appVersion,
      event: stableToken(value.event, 'UNKNOWN_EVENT'),
      ...(value.generation === undefined ? {} : { generation: value.generation }),
      ...(value.phase === undefined ? {} : { phase: stableToken(value.phase, 'UNKNOWN') }),
      ...(value.stableCode === undefined ? {} : { stableCode: stableToken(value.stableCode, 'UNKNOWN') }),
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
      ...(value.pid === undefined ? {} : { pid: value.pid }),
    }
    const line = `${JSON.stringify(record)}\n`
    try {
      this.rotateIfNeeded(path, Buffer.byteLength(line))
      const fd = openSync(path, 'a', 0o600)
      try {
        chmodSync(path, 0o600)
        writeSync(fd, line)
      } finally {
        closeSync(fd)
      }
    } catch {
      // 磁盘满、权限改变或轮转竞态只降级诊断，不打断业务状态机。
    }
  }

  private rotateIfNeeded(path: string, incomingBytes: number): void {
    if (!existsSync(path) || statSync(path).size + incomingBytes <= this.maxBytes) return
    const last = `${path}.${String(this.maxFiles - 1)}`
    rmSync(last, { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      const source = `${path}.${String(index)}`
      if (existsSync(source)) renameSync(source, `${path}.${String(index + 1)}`)
    }
    renameSync(path, `${path}.1`)
  }
}

function stableToken(value: string, fallback: string): string {
  const token = value.toUpperCase().replace(/[^A-Z0-9_.-]/g, '_').slice(0, 128)
  return token === '' ? fallback : token
}
