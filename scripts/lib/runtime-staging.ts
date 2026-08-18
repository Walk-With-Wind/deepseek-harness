/** 两种发行产物共用的 pnpm production closure staging。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, win32 } from 'node:path'
import ts from 'typescript'

/** staging 完成后可审计的原生文件记录。 */
export interface NativeRuntimeFile {
  readonly relativePath: string
  readonly kind: 'node-addon' | 'shared-library' | 'spawn-helper' | 'ripgrep'
  readonly architectures: readonly ('x64' | 'arm64')[]
}

/** staging 目录树的可审计规模。 */
export interface DirectoryTreeSummary {
  readonly directories: number
  readonly files: number
  readonly bytes: number
}

/** production closure 的可注入部署选项。 */
export interface RuntimeStagingOptions {
  readonly root: string
  readonly packageName: string
  readonly target: string
  readonly sourceNodeModules?: string
  readonly removeFiles?: readonly string[]
  /** 当前载体明确不会装载的工作区 peer。 */
  readonly allowedMissingOwnedPeers?: readonly string[]
  /** 仅供依赖旧 hoist 布局的历史消费者使用。 */
  readonly legacy?: boolean
  readonly dryRun?: boolean
  readonly label: string
}

/**
 * 确认可清理的 staging 位于仓库内且不包含仓库根。
 * @param root - 仓库根目录。
 * @param target - staging 目录。
 */
export function assertSafeStagingTarget(root: string, target: string): void {
  const canonicalRoot = resolve(root)
  const canonicalTarget = resolve(target)
  if (canonicalTarget === canonicalRoot || canonicalRoot.startsWith(`${canonicalTarget}${sep}`)) {
    throw new Error(`runtime-staging: 拒绝清理包含仓库根的目录 ${canonicalTarget}`)
  }
  if (!canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`runtime-staging: staging 必须位于仓库内：${canonicalTarget}`)
  }
}

/**
 * 使用锁定的 workspace 图部署 production closure，再物化所有包链接。
 * @param options - 部署与兼容性修复选项。
 */
export async function stageProductionClosure(options: RuntimeStagingOptions): Promise<void> {
  assertSafeStagingTarget(options.root, options.target)
  if (options.dryRun) {
    console.log(`${options.label}: [dry-run] rm -rf ${options.target}`)
  } else {
    await rm(options.target, { recursive: true, force: true })
  }
  await runPnpmDeploy(options)
  if (options.dryRun) {
    console.log(`${options.label}: [dry-run] materialize staged package links`)
    return
  }
  await restoreMissingDirectDependencies(options.target, options.sourceNodeModules)
  await materializeStagedLinks(join(options.target, 'node_modules'))
  await Promise.all((options.removeFiles ?? []).map(name => rm(join(options.target, name), { force: true })))
  await verifySymlinkFree(options.target)
  await verifyOwnedPeerClosure(options.target, options.allowedMissingOwnedPeers)
  await verifyJavaScriptRuntimeClosure(options.target)
}

async function runPnpmDeploy(options: RuntimeStagingOptions): Promise<void> {
  const args = [
    '--filter', options.packageName, 'deploy',
    ...(options.legacy === false ? [] : ['--legacy']),
    '--prod',
    ...(options.legacy === false
      ? ['--config.inject-workspace-packages=true', '--config.node-linker=hoisted', '--ignore-scripts']
      : [
          '--config.node-linker=hoisted',
          '--config.auto-install-peers=false',
          '--config.link-workspace-packages=true',
        ]),
    options.target,
  ]
  if (options.dryRun) {
    console.log(`${options.label}: [dry-run] pnpm ${args.join(' ')}`)
    return
  }
  const invocation = resolvePnpmInvocation(args)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.root,
      stdio: 'inherit',
      // 产物构建不安装或运行开发者本机 Git hooks。
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', error => { reject(new Error(`${options.label}: pnpm deploy 启动失败：${error.message}`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${options.label}: pnpm deploy 失败：${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}`))
    })
  })
}

/**
 * 构造跨平台且无 shell 的 pnpm 子进程调用。
 * @param args - 传给 pnpm 的参数。
 * @param environment - 提供当前 pnpm 入口的进程环境。
 * @param platform - 当前进程平台。
 * @param fileExists - pnpm JavaScript 入口存在性检查。
 * @returns Node 可直接执行的命令与参数。
 */
export function resolvePnpmInvocation(
  args: string[],
  environment: { readonly npm_execpath?: string; readonly PNPM_HOME?: string } = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint !== undefined && entrypoint !== '') {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  if (platform !== 'win32') return { command: 'pnpm', args }
  const pnpmHome = environment.PNPM_HOME
  if (pnpmHome !== undefined && pnpmHome !== '') {
    const actionEntrypoint = win32.resolve(pnpmHome, '..', 'pnpm', 'bin', 'pnpm.cjs')
    if (fileExists(actionEntrypoint)) {
      return { command: process.execPath, args: [actionEntrypoint, ...args] }
    }
  }
  throw new Error('runtime-staging: PNPM_HOME 未提供可执行的 pnpm.cjs')
}

async function restoreMissingDirectDependencies(staging: string, sourceNodeModules?: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    if (sourceNodeModules === undefined) {
      throw new Error(`runtime-staging: 部署结果缺少直接依赖 ${dependency}`)
    }
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`runtime-staging: ${dependency} 在部署结果和兼容性来源中均不存在`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
  }
}

/**
 * 物化 node_modules 内的包链接，并删除不会被产品调用的 `.bin` 链接目录。
 * @param nodeModules - staging 中的 node_modules。
 */
export async function materializeStagedLinks(nodeModules: string): Promise<void> {
  let remaining = await findSymlinks(nodeModules)
  while (remaining.length > 0) {
    const removedBinDirectories = new Set<string>()
    for (const link of remaining) {
      const segments = link.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        const binDirectory = join(nodeModules, ...segments.slice(0, binIndex + 1))
        if (!removedBinDirectories.has(binDirectory)) {
          await rm(binDirectory, { recursive: true, force: true })
          removedBinDirectories.add(binDirectory)
        }
        continue
      }
      if (!existsSync(link)) continue
      const source = await realpath(link)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(link, { recursive: true, force: true })
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
      })
    }
    remaining = await findSymlinks(nodeModules)
  }
}

async function findSymlinks(directory: string): Promise<string[]> {
  const links: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) links.push(path)
    else if (metadata.isDirectory()) links.push(...await findSymlinks(path))
  }
  return links
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 拒绝 staging 内的任何残留符号链接。
 * @param staging - 已部署闭包根目录。
 */
export async function verifySymlinkFree(staging: string): Promise<void> {
  const link = await findSymlink(staging)
  if (link !== undefined) throw new Error(`runtime-staging: 产物闭包残留符号链接 ${relative(staging, link)}`)
}

/**
 * 汇总目录树的文件数、子目录数与文件实际长度。
 * @param root - 待统计的目录根。
 * @returns 不含根目录自身的规模汇总。
 */
export async function summarizeDirectoryTree(root: string): Promise<DirectoryTreeSummary> {
  const summary = { directories: 0, files: 0, bytes: 0 }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        summary.directories += 1
        await visit(path)
      } else if (entry.isFile()) {
        summary.files += 1
        summary.bytes += (await lstat(path)).size
      }
    }
  }
  await visit(root)
  return summary
}

/**
 * 拒绝 production closure 中未由应用提供的工作区 peer。
 * @param staging - 已部署闭包根目录。
 * @param allowedMissing - 当前载体不会执行的可解释例外。
 */
export async function verifyOwnedPeerClosure(
  staging: string,
  allowedMissing: readonly string[] = [],
): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  const packages = await topLevelPackageDirectories(nodeModules)
  const available = new Set<string>()
  for (const directory of packages) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string }
    if (manifest.name !== undefined) available.add(manifest.name)
  }
  const allowed = new Set(allowedMissing)
  const missing = new Map<string, string[]>()
  for (const directory of packages) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      name?: string
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/') || available.has(peer) || allowed.has(peer)
        || manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      const consumers = missing.get(peer) ?? []
      consumers.push(manifest.name ?? relative(staging, directory))
      missing.set(peer, consumers)
    }
  }
  if (missing.size === 0) return
  const details = [...missing]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([peer, consumers]) => `${peer} <- ${consumers.sort().join(', ')}`)
  throw new Error(`runtime-staging: production closure 缺少工作区 peer\n${details.join('\n')}`)
}

/**
 * 拒绝应用与工作区包入口引用但未进入发布白名单的相对运行时文件。
 * @param staging - 已部署闭包根目录。
 */
export async function verifyJavaScriptRuntimeClosure(staging: string): Promise<void> {
  const failures: string[] = []
  const queue = await runtimeEntryFiles(staging, failures)
  const visited = new Set<string>()
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (visited.has(path) || !/\.(?:c|m)?js$/.test(path)) continue
    visited.add(path)
    const source = await readFile(path, 'utf8')
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    for (const rawSpecifier of runtimeSpecifiers(sourceFile)) {
      if (!rawSpecifier.startsWith('.')) continue
      const specifier = rawSpecifier.split(/[?#]/, 1)[0]
      if (specifier === undefined) continue
      const resolved = resolveRuntimeFile(dirname(path), specifier)
      if (resolved === undefined) {
        failures.push(`${relative(staging, path)} -> ${specifier}`)
        if (failures.length >= 20) break
      } else if (/\.(?:c|m)?js$/.test(resolved)) {
        queue.push(resolved)
      }
    }
    if (failures.length >= 20) break
  }
  if (failures.length > 0) {
    throw new Error(`runtime-staging: JavaScript 运行时闭包不完整\n${failures.join('\n')}`)
  }
}

async function runtimeEntryFiles(staging: string, failures: string[]): Promise<string[]> {
  const queue: string[] = []
  const ownedRoot = join(staging, 'node_modules', '@deepseek-ai')
  const roots = [
    staging,
    ...(await topLevelPackageDirectories(join(staging, 'node_modules')))
      .filter(directory => directory.startsWith(`${ownedRoot}${sep}`)),
  ]
  for (const directory of roots) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      main?: string
      bin?: string | Record<string, string>
      exports?: unknown
    }
    const declared = new Set<string>()
    if (typeof manifest.main === 'string') declared.add(manifest.main)
    if (typeof manifest.bin === 'string') declared.add(manifest.bin)
    else for (const value of Object.values(manifest.bin ?? {})) {
      if (typeof value === 'string') declared.add(value)
    }
    collectRuntimeExportPaths(manifest.exports, declared)
    for (const entry of declared) {
      if (entry.includes('*') || !/\.(?:c|m)?js$/.test(entry)) continue
      const resolved = resolveRuntimeFile(directory, entry)
      if (resolved === undefined) failures.push(`${relative(staging, manifestPath)} -> ${entry}`)
      else queue.push(resolved)
    }
  }
  // 产品入口中不经 package exports 调度的进程文件与 Renderer chunk 也属于运行时根。
  const productLib = join(staging, 'lib')
  if (existsSync(productLib)) {
    for (const path of await collectFiles(productLib)) if (/\.(?:c|m)?js$/.test(path)) queue.push(path)
  }
  const renderer = join(staging, 'renderer')
  if (existsSync(renderer)) {
    for (const path of await collectFiles(renderer)) if (/\.(?:c|m)?js$/.test(path)) queue.push(path)
  }
  return queue
}

function collectRuntimeExportPaths(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    output.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRuntimeExportPaths(entry, output)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const entry of Object.values(value)) collectRuntimeExportPaths(entry, output)
}

function resolveRuntimeFile(base: string, specifier: string): string | undefined {
  const candidate = resolve(base, specifier)
  return [candidate, `${candidate}.js`, `${candidate}.json`, join(candidate, 'index.js')].find(existsSync)
}

function runtimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0]
      const runtimeImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      if (runtimeImport && first !== undefined && ts.isStringLiteralLike(first)) specifiers.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

async function topLevelPackageDirectories(nodeModules: string): Promise<string[]> {
  const packages: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const directory = join(nodeModules, entry.name)
    if (!entry.name.startsWith('@')) {
      if (existsSync(join(directory, 'package.json'))) packages.push(directory)
      continue
    }
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const childDirectory = join(directory, child.name)
      if (child.isDirectory() && existsSync(join(childDirectory, 'package.json'))) packages.push(childDirectory)
    }
  }
  return packages
}

/**
 * 检查需要解包的原生文件类型、执行位和 CPU 架构。
 * @param staging - 已物化的 production closure。
 * @param platform - 目标 Node 平台。
 * @param arch - 目标 CPU 架构。
 * @returns 按路径排序的原生文件清单。
 */
export async function verifyNativeRuntimeFiles(
  staging: string,
  platform: NodeJS.Platform,
  arch: 'x64' | 'arm64',
): Promise<NativeRuntimeFile[]> {
  const files = await collectFiles(staging)
  const inventory: NativeRuntimeFile[] = []
  for (const path of files) {
    const relativePath = relative(staging, path).split(sep).join('/')
    const kind = nativeKind(relativePath, platform)
    if (kind === undefined) continue
    const metadata = await lstat(path)
    if (platform !== 'win32' && (kind === 'spawn-helper' || kind === 'ripgrep')
      && (metadata.mode & 0o111) === 0) {
      throw new Error(`runtime-staging: 原生可执行文件缺少执行位 ${relativePath}`)
    }
    const architectures = detectBinaryArchitectures(await readFile(path))
    if (!architectures.includes(arch)) {
      throw new Error(`runtime-staging: ${relativePath} 不包含目标架构 ${arch}`)
    }
    inventory.push({ relativePath, kind, architectures })
  }
  return inventory.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

/**
 * 删除 node-pty 中非目标平台的预编译目录，防止它们被 ASAR 解包进最终产物。
 * @param staging - 已部署闭包根目录。
 * @param platform - Electron 目标平台。
 * @param arch - Electron 目标架构。
 */
export async function pruneKnownNativeVariants(
  staging: string,
  platform: NodeJS.Platform,
  arch: 'x64' | 'arm64',
): Promise<void> {
  const prebuilds = join(staging, 'node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    const platformName = platform === 'win32' ? 'win32' : platform
    const keep = `${platformName}-${arch}`
    for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keep) continue
      await rm(join(prebuilds, entry.name), { recursive: true, force: true })
    }
  }

  const conpty = join(staging, 'node_modules', 'node-pty', 'third_party', 'conpty')
  if (!existsSync(conpty)) return
  if (platform !== 'win32') {
    await rm(conpty, { recursive: true, force: true })
    return
  }
  const keep = `win10-${arch}`
  for (const version of await readdir(conpty, { withFileTypes: true })) {
    if (!version.isDirectory()) continue
    const versionRoot = join(conpty, version.name)
    for (const candidate of await readdir(versionRoot, { withFileTypes: true })) {
      if (!candidate.isDirectory() || candidate.name === keep) continue
      await rm(join(versionRoot, candidate.name), { recursive: true, force: true })
    }
  }
}

/**
 * 恢复 npm 归档无法稳定保留的已知原生 helper 执行位。
 * @param staging - 已部署闭包根目录。
 * @param platform - Electron 目标平台。
 * @param arch - Electron 目标架构。
 */
export async function ensureKnownNativeExecutableModes(
  staging: string,
  platform: NodeJS.Platform,
  arch: 'x64' | 'arm64',
): Promise<void> {
  if (platform === 'win32') return
  const candidates = [
    join(staging, 'node_modules', 'node-pty', 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  ]
  const ripgrepRoot = join(staging, 'node_modules')
  for (const path of await collectFiles(ripgrepRoot)) {
    const relativePath = relative(staging, path).split(sep).join('/')
    const kind = nativeKind(relativePath, platform)
    if (kind === 'ripgrep') candidates.push(path)
  }
  for (const path of candidates) {
    if (existsSync(path)) await chmod(path, 0o755)
  }
}

function nativeKind(relativePath: string, platform: NodeJS.Platform): NativeRuntimeFile['kind'] | undefined {
  if (relativePath.endsWith('.node')) return 'node-addon'
  if ((platform === 'darwin' && relativePath.endsWith('.dylib'))
    || (platform === 'win32' && relativePath.endsWith('.dll'))) return 'shared-library'
  if (/(?:^|\/)spawn-helper$/.test(relativePath)) return 'spawn-helper'
  if (/(?:^|\/)@vscode\/ripgrep(?:-[^/]+)?\/(?:.*\/)?rg(?:\.exe)?$/.test(relativePath)) return 'ripgrep'
  return undefined
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * 识别 ELF、PE 以及单架构/通用 Mach-O 的 CPU 架构。
 * @param bytes - 原生二进制文件字节。
 * @returns 文件包含的已支持架构。
 */
export function detectBinaryArchitectures(bytes: Uint8Array): ('x64' | 'arm64')[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength >= 20 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const little = bytes[5] === 1
    return architectureFromMachine(view.getUint16(18, little))
  }
  if (bytes.byteLength >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = view.getUint32(0x3c, true)
    if (offset + 6 <= bytes.byteLength && view.getUint32(offset, true) === 0x00004550) {
      return architectureFromMachine(view.getUint16(offset + 4, true))
    }
  }
  if (bytes.byteLength >= 8) {
    const magic = view.getUint32(0, false)
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = view.getUint32(4, false)
      const stride = magic === 0xcafebabf ? 32 : 20
      const result = new Set<'x64' | 'arm64'>()
      for (let index = 0; index < count && 8 + ((index + 1) * stride) <= bytes.byteLength; index += 1) {
        for (const value of architectureFromMachine(view.getUint32(8 + (index * stride), false))) result.add(value)
      }
      return [...result]
    }
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe
    if (little || magic === 0xfeedface || magic === 0xfeedfacf) {
      return architectureFromMachine(view.getUint32(4, little))
    }
  }
  return []
}

function architectureFromMachine(machine: number): ('x64' | 'arm64')[] {
  if (machine === 0x3e || machine === 0x8664 || machine === 0x01000007) return ['x64']
  if (machine === 0xb7 || machine === 0xaa64 || machine === 0x0100000c) return ['arm64']
  return []
}
