/** 从最终原生安装器验证无签名 Preview 的真实平台签名状态。 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DESKTOP_PRODUCT_NAME,
  DESKTOP_WINDOWS_SETUP_EXE,
} from '../../apps/desktop/src/shared/release-policy.ts'
import type { DesktopCommunityTarget } from './desktop-community-publish.ts'
import { desktopArtifactPaths } from './desktop-artifact.ts'

/** Preview 验收记录允许的平台签名状态。 */
export type DesktopPreviewSignature = 'ad-hoc' | 'unsigned'

/** 最终安装器签名验证输入。 */
export interface DesktopPreviewSignatureOptions {
  readonly target: DesktopCommunityTarget
  readonly artifactRoot: string
}

/**
 * 拒绝任何不是纯 ad-hoc 的 macOS 签名详情。
 * @param detail - `codesign -dv --verbose=4` 输出。
 * @returns 无返回值；身份不符时抛错。
 */
export function assertMacAdHocSignature(detail: string): void {
  if (!/^Signature=adhoc$/m.test(detail)) {
    throw new Error('desktop-preview-signature: macOS 应用不是 ad-hoc 签名')
  }
  if (/^Authority=/m.test(detail)) {
    throw new Error('desktop-preview-signature: macOS Preview 不得带发行签名 Authority')
  }
}

/**
 * 拒绝任何不是 Authenticode NotSigned 的 Windows 状态。
 * @param status - PowerShell `Get-AuthenticodeSignature` 状态。
 * @returns 无返回值；状态不符时抛错。
 */
export function assertWindowsUnsignedSignature(status: string): void {
  if (status.trim() !== 'NotSigned') {
    throw new Error(`desktop-preview-signature: Windows Preview 期望 NotSigned，实际 ${status.trim()}`)
  }
}

/**
 * 验证 packaged 应用及最终安装器的真实签名状态。
 * @param options - 当前原生目标和 Forge maker 输出根目录。
 * @returns 经平台工具验证的签名状态。
 */
export async function verifyDesktopPreviewSignature(
  options: DesktopPreviewSignatureOptions,
): Promise<DesktopPreviewSignature> {
  const [platform, arch] = options.target.split('-') as ['darwin' | 'win32', 'arm64' | 'x64']
  if (process.platform !== platform || process.arch !== arch) {
    throw new Error(`desktop-preview-signature: runner ${process.platform}-${process.arch} 与 ${options.target} 不一致`)
  }
  if (platform === 'darwin') {
    await verifyMacPreview(options.artifactRoot, arch)
    return 'ad-hoc'
  }
  await verifyWindowsPreview(options.artifactRoot)
  return 'unsigned'
}

async function verifyMacPreview(artifactRoot: string, arch: 'arm64' | 'x64'): Promise<void> {
  const packaged = desktopArtifactPaths('darwin', arch).app
  verifyMacApplication(packaged)
  const dmg = await findSingleFile(artifactRoot, path => path.endsWith('.dmg'), 'DMG')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-preview-signature-'))
  const mount = join(temporary, 'mount')
  await mkdir(mount)
  let attached = false
  try {
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
    attached = true
    verifyMacApplication(join(mount, `${DESKTOP_PRODUCT_NAME}.app`))
  } finally {
    if (attached) run('hdiutil', ['detach', mount, '-force'])
    await rm(temporary, { recursive: true, force: true })
  }
}

function verifyMacApplication(app: string): void {
  if (!existsSync(app)) throw new Error(`desktop-preview-signature: 缺少 macOS 应用 ${app}`)
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const detail = run('codesign', ['-dv', '--verbose=4', app])
  assertMacAdHocSignature(`${detail.stdout}\n${detail.stderr}`)
}

async function verifyWindowsPreview(artifactRoot: string): Promise<void> {
  const packaged = desktopArtifactPaths('win32', 'x64').executable
  if (!existsSync(packaged)) throw new Error(`desktop-preview-signature: 缺少 Windows 应用 ${packaged}`)
  const setup = await findSingleFile(
    artifactRoot,
    path => basename(path) === DESKTOP_WINDOWS_SETUP_EXE,
    'Windows setup',
  )
  for (const executable of [packaged, setup]) {
    const result = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-AuthenticodeSignature -LiteralPath $env:DSH_PREVIEW_EXECUTABLE).Status.ToString()',
    ], { DSH_PREVIEW_EXECUTABLE: executable })
    assertWindowsUnsignedSignature(result.stdout)
  }
}

async function findSingleFile(
  root: string,
  predicate: (path: string) => boolean,
  subject: string,
): Promise<string> {
  const matches: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && predicate(path)) matches.push(path)
    }
  }
  await visit(root)
  if (matches.length !== 1) {
    throw new Error(`desktop-preview-signature: ${subject} 数量必须为 1，实际 ${String(matches.length)}`)
  }
  return matches[0]!
}

function run(
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
  if (result.status !== 0) {
    throw new Error(`desktop-preview-signature: ${command} 失败：${result.stderr.trim()}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
