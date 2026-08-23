/** 安装包竞争验收使用的共享业务数据快照与租约冲突判定。 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const BUSINESS_PATHS = [
  'sessions',
  'storages',
  'attachments',
  'settings.yaml',
  '.credentials.yaml',
]

const DESKTOP_LEASE_CONFLICT = /Harness home is already in use by (?:desktop Host pid \d+ \(version [^\r\n]+\)|another live Host)\. Close that Host and retry; the competing process was not modified\./

/** @typedef {{ path: string, kind: 'file' | 'symlink', digest: string }} DesktopBusinessEntry */

/** 把平台分隔符收敛为稳定的快照路径。 */
function snapshotPath(home, path) {
  return relative(home, path).split(sep).join('/')
}

/** 递归记录一个共享业务根；不跟随符号链接。 */
function collect(home, path, entries) {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink()) {
    entries.push({
      path: snapshotPath(home, path),
      kind: 'symlink',
      digest: createHash('sha256').update(readlinkSync(path)).digest('hex'),
    })
    return
  }
  if (info.isDirectory()) {
    for (const child of readdirSync(path).sort()) collect(home, join(path, child), entries)
    return
  }
  if (!info.isFile()) throw new Error(`共享业务路径包含不支持的文件类型：${snapshotPath(home, path)}`)
  entries.push({
    path: snapshotPath(home, path),
    kind: 'file',
    digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
}

/**
 * 记录租约失败方不得修改的 sessions、Workspace storage、附件、设置和凭据。
 * @param {string} home - 已由 Desktop Host 使用的 DSH_HOME。
 * @returns {DesktopBusinessEntry[]} 稳定排序且不含文件正文的快照。
 */
export function snapshotDesktopBusinessData(home) {
  /** @type {DesktopBusinessEntry[]} */
  const entries = []
  for (const path of BUSINESS_PATHS) collect(home, join(home, path), entries)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 断言竞争 Host 退出前后没有共享业务数据写入。
 * @param {DesktopBusinessEntry[]} before - 竞争启动前快照。
 * @param {DesktopBusinessEntry[]} after - 竞争退出后快照。
 */
export function assertDesktopBusinessDataUnchanged(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return
  const beforeByPath = new Map(before.map(entry => [entry.path, entry]))
  const afterByPath = new Map(after.map(entry => [entry.path, entry]))
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort()
  const changed = paths.filter(path => JSON.stringify(beforeByPath.get(path)) !== JSON.stringify(afterByPath.get(path)))
  throw new Error(`竞争 Host 修改了共享业务数据：${changed.join(', ')}`)
}

/**
 * 判断竞争产品是否因当前 Desktop 租约安全退出。
 * @param {number | null} status - 竞争进程退出码。
 * @param {string} output - 竞争进程合并后的标准输出与错误输出。
 * @returns {boolean} 退出码与完整冲突提示是否都符合预期。
 */
export function isExpectedDesktopLeaseConflict(status, output) {
  return status === 1 && DESKTOP_LEASE_CONFLICT.test(output)
}
