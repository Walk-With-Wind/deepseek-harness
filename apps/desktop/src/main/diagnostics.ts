/** 用户主动导出的 Desktop 诊断包；只接受显式白名单输入。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopConfig } from '../shared/control-protocol.ts'
import type { DesktopUpdateState } from '../shared/update-protocol.ts'
import type { DesktopBuildInfo } from './build-info.ts'
import { writeAtomicResponse } from '../utility/atomic-export.ts'

/** 导出确认框按此顺序展示内容类别。 */
export const DESKTOP_DIAGNOSTIC_CATEGORIES = Object.freeze([
  '应用版本、源 commit、平台与架构',
  '签名运行时未验证状态与 Electron fuse 构建配置摘要',
  '桌面配置字段和数值（不含环境变量）',
  '客户端资源数量与不可逆代际摘要',
  '最近的字段白名单结构化日志与崩溃事件',
  'Host 租约状态与 DSH_HOME 不可逆摘要',
  '更新状态与稳定错误码',
])

/** 诊断包明确排除的用户数据类别。 */
export const DESKTOP_DIAGNOSTIC_EXCLUSIONS = Object.freeze([
  '会话正文、模型请求与响应',
  '凭据、Authorization、Cookie 与完整环境变量',
  '工作区文件、用户插件源码与本机绝对路径',
])

export interface DesktopDiagnosticSnapshot {
  readonly createdAt: string
  readonly build: DesktopBuildInfo
  readonly packaged: boolean
  readonly config: DesktopConfig
  readonly generation: number
  readonly phase: string
  readonly homeKey: string
  readonly resource: { readonly revision?: string; readonly resourceCount: number }
  readonly update: DesktopUpdateState
}

/**
 * 从受控快照与 Desktop 日志目录生成内存 ZIP，压缩实现只在用户触发导出后加载。
 * @param snapshot - 已按白名单构造的 Desktop 运行快照。
 * @param logDirectory - 只包含 Desktop 结构化日志的目录。
 * @returns 可原子写入目标文件的 ZIP 字节。
 */
export async function createDesktopDiagnosticArchive(
  snapshot: DesktopDiagnosticSnapshot,
  logDirectory: string,
): Promise<Uint8Array> {
  const { zipSync } = await import('fflate')
  const manifest = {
    formatVersion: 1,
    createdAt: snapshot.createdAt,
    build: snapshot.build,
    security: {
      packaged: snapshot.packaged,
      signing: snapshot.packaged ? 'not-runtime-verified' : 'development-build',
      fuses: {
        status: 'configured-not-runtime-verified',
        expected: {
          runAsNode: false,
          nodeOptions: false,
          nodeCliInspect: false,
          embeddedAsarIntegrity: true,
          onlyLoadAppFromAsar: true,
        },
      },
    },
    config: Object.fromEntries(Object.entries(snapshot.config).sort(([left], [right]) => left.localeCompare(right))),
    runtime: {
      generation: snapshot.generation,
      phase: stableToken(snapshot.phase),
      homeKey: snapshot.homeKey,
      lease: snapshot.phase === 'READY' ? 'held-by-current-utility' : 'not-confirmed',
    },
    resource: {
      resourceCount: snapshot.resource.resourceCount,
      ...(snapshot.resource.revision === undefined ? {} : { revisionDigest: digestToken(snapshot.resource.revision) }),
    },
    update: snapshot.update,
  }
  const files: Record<string, Uint8Array> = {
    'contents.json': jsonBytes({
      categories: DESKTOP_DIAGNOSTIC_CATEGORIES,
      excluded: DESKTOP_DIAGNOSTIC_EXCLUSIONS,
    }),
    'diagnostic.json': jsonBytes(manifest),
  }
  for (const processName of ['main', 'utility', 'renderer-crash'] as const) {
    const records = readSafeLogRecords(logDirectory, processName)
    if (records.length !== 0) files[`logs/${processName}.jsonl`] = textBytes(`${records.join('\n')}\n`)
  }
  return zipSync(files, { level: 6 })
}

/**
 * 通过 owner-only sibling temp 原子发布诊断 ZIP。
 * @param snapshot - 已按白名单构造的 Desktop 运行快照。
 * @param logDirectory - 只包含 Desktop 结构化日志的目录。
 * @param targetPath - Main 系统保存对话框批准的绝对目标路径。
 * @param signal - 窗口或应用退出时取消写入的信号。
 * @returns ZIP 完成原子发布后解决。
 */
export async function writeDesktopDiagnosticBundle(
  snapshot: DesktopDiagnosticSnapshot,
  logDirectory: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  const archive = await createDesktopDiagnosticArchive(snapshot, logDirectory)
  await writeAtomicResponse(new Response(Uint8Array.from(archive).buffer), targetPath, signal, () => {})
}

function readSafeLogRecords(logDirectory: string, processName: string): string[] {
  const records: string[] = []
  for (let index = 3; index >= 0; index -= 1) {
    const suffix = index === 0 ? '' : `.${String(index)}`
    const path = join(logDirectory, `${processName}.jsonl${suffix}`)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const safe = safeLogRecord(line, processName)
      if (safe !== undefined) records.push(JSON.stringify(safe))
    }
  }
  return records
}

function safeLogRecord(line: string, expectedProcess: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.process !== expectedProcess
      || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
      || (value.level !== 'debug' && value.level !== 'info' && value.level !== 'warn' && value.level !== 'error')
      || typeof value.appVersion !== 'string' || value.appVersion.length > 128
      || typeof value.event !== 'string') return undefined
    return {
      timestamp: value.timestamp,
      level: value.level,
      process: expectedProcess,
      appVersion: value.appVersion,
      event: stableToken(value.event),
      ...optionalToken(value, 'phase'),
      ...optionalToken(value, 'stableCode'),
      ...optionalInteger(value, 'generation'),
      ...optionalInteger(value, 'durationMs'),
      ...optionalInteger(value, 'pid'),
    }
  } catch {
    // 损坏或注入了额外正文的日志行不进入用户诊断包。
    return undefined
  }
}

function optionalToken(value: Record<string, unknown>, field: string): Record<string, string> {
  return typeof value[field] === 'string' ? { [field]: stableToken(value[field]) } : {}
}

function optionalInteger(value: Record<string, unknown>, field: string): Record<string, number> {
  return typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] >= 0
    ? { [field]: value[field] }
    : {}
}

function stableToken(value: string): string {
  const token = value.toUpperCase().replace(/[^A-Z0-9_.-]/g, '_').slice(0, 128)
  return token === '' ? 'UNKNOWN' : token
}

function digestToken(value: string): string {
  // 该摘要只用于关联同一资源代际，不需要恢复原值。
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function jsonBytes(value: unknown): Uint8Array {
  return textBytes(`${JSON.stringify(value, null, 2)}\n`)
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
