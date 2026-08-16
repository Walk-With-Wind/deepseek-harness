/** Desktop production closure 与 Electron Forge 的发行编排入口。 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ensureKnownNativeExecutableModes,
  pruneKnownNativeVariants,
  stageProductionClosure,
  verifyNativeRuntimeFiles,
} from './lib/runtime-staging.ts'
import { generateDesktopReleaseMaterials } from './lib/desktop-release-materials.ts'
import { generateDesktopUpdateMetadata } from './lib/desktop-update-metadata.ts'

const root = resolve(import.meta.dirname, '..')
const appRoot = resolve(root, 'apps/desktop')
const staging = resolve(root, '.artifacts/desktop/staging')
const forgeConfig = resolve(appRoot, 'forge.config.ts')
const forgeCli = resolve(appRoot, 'node_modules/@electron-forge/cli/dist/electron-forge.js')
const legalOverrideNames = [
  'Apache-2.0.txt', 'GPL-3.0.txt', 'LGPL-3.0.txt',
  'MIT-Amit-Gupta.txt', 'MIT-Mario-Zechner.txt',
  'MIT-Nathan-Rajlich.txt', 'MIT-Niels-Martignene.txt',
] as const
const requiredEntries = [
  'lib/main.js', 'lib/preload.cjs', 'lib/utility.js',
  'renderer/index.html', 'cordis.patch.yml', 'assets/icon.png',
  'desktop.config.json', 'build-info.json',
  'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html',
  ...legalOverrideNames.map(name => `licenses/npm-overrides/${name}`),
] as const

type DesktopCommand = 'stage' | 'package' | 'make' | 'materials'

function parseCommand(argv: string[]): { command: DesktopCommand; arch: string; platform: string } {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      arch: { type: 'string', default: process.arch },
      platform: { type: 'string', default: process.platform },
    },
  })
  const command = positionals[0]
  if (command !== 'stage' && command !== 'package' && command !== 'make' && command !== 'materials') {
    throw new Error('desktop: 用法 tsx scripts/desktop.ts <stage|package|make|materials> [--arch=<arch>] [--platform=<platform>]')
  }
  if (positionals.length !== 1) throw new Error(`desktop: 未知参数 ${positionals.slice(1).join(' ')}`)
  if (values.arch === '' || values.platform === '') throw new Error('desktop: arch/platform 不得为空')
  return { command, arch: values.arch, platform: values.platform }
}

async function prepareStaging(platform: string, arch: string): Promise<void> {
  await stageProductionClosure({
    root,
    packageName: '@deepseek-ai/dsh-desktop',
    target: staging,
    legacy: false,
    label: 'desktop',
    // WebServer peer 只服务 Web carrier；Desktop 的客户端节点不执行该入口。
    allowedMissingOwnedPeers: ['@deepseek-ai/dsh-host-webserver'],
  })
  if ((platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
    || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(`desktop: 不支持目标 ${platform}-${arch}`)
  }
  await pruneKnownNativeVariants(staging, platform, arch)
  await ensureKnownNativeExecutableModes(staging, platform, arch)
  const nativeFiles = await verifyNativeRuntimeFiles(staging, platform, arch)
  if (nativeFiles.length === 0) throw new Error('desktop: staging 未发现已声明的原生运行时文件')
  await writeFile(
    join(staging, 'native-manifest.json'),
    `${JSON.stringify({ platform, arch, files: nativeFiles }, null, 2)}\n`,
  )
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const version = typeof manifest.version === 'string' ? manifest.version : undefined
  if (version === undefined || version === '') throw new Error('desktop: 应用 manifest 缺少版本')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('desktop: 无法解析源 commit')
  const sourceDate = new Date(execFileSync(
    'git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: root, encoding: 'utf8' },
  ).trim()).toISOString()
  const appRequire = createRequire(join(appRoot, 'package.json'))
  // Electron 43 在首次加载入口时才下载运行时，复制发行许可证前必须先物化 dist。
  const electronExecutable: unknown = appRequire('electron')
  if (typeof electronExecutable !== 'string' || !existsSync(electronExecutable)) {
    throw new Error('desktop: Electron 运行时未完成物化')
  }
  const electronManifest = JSON.parse(
    await readFile(appRequire.resolve('electron/package.json'), 'utf8'),
  ) as { version?: unknown }
  if (typeof electronManifest.version !== 'string' || electronManifest.version === '') {
    throw new Error('desktop: 无法解析 Electron 版本')
  }
  const electronRoot = dirname(appRequire.resolve('electron/package.json'))
  const electronLicenses = join(staging, 'licenses', 'electron')
  await mkdir(electronLicenses, { recursive: true })
  await Promise.all(['LICENSE', 'LICENSES.chromium.html'].map(name => (
    copyFile(join(electronRoot, 'dist', name), join(electronLicenses, name))
  )))
  const npmLegalOverrides = join(staging, 'licenses', 'npm-overrides')
  await mkdir(npmLegalOverrides, { recursive: true })
  await Promise.all(legalOverrideNames.map(name => (
    copyFile(join(appRoot, 'assets', 'legal', name), join(npmLegalOverrides, name))
  )))
  await writeFile(join(staging, 'build-info.json'), `${JSON.stringify({
    version,
    sourceCommit,
    sourceDate,
    electronVersion: electronManifest.version,
    nodeVersion: process.versions.node,
    platform,
    arch,
  }, null, 2)}\n`)
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    productName: 'DeepSeek Harness',
    private: true,
  }, null, 2)}\n`)
  for (const entry of requiredEntries) {
    if (!existsSync(join(staging, entry))) throw new Error(`desktop: staging 缺少 ${entry}`)
  }
  await mkdir(staging, { recursive: true })
  // Forge 只在构建期读取源配置；该 wrapper 被 packager ignore，不会泄露 checkout 路径。
  await writeFile(
    join(staging, 'forge.config.ts'),
    `export { default } from ${JSON.stringify(pathToFileURL(forgeConfig).href)}\n`,
  )
}

async function runForge(command: 'package' | 'make', arch: string, platform: string): Promise<void> {
  if (!existsSync(forgeCli)) throw new Error('desktop: Electron Forge CLI 未安装')
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [forgeCli, command, staging, '--arch', arch, '--platform', platform], {
      cwd: root,
      stdio: 'inherit',
      // Forge 在运行前检查 pnpm 布局；staging 已由共享 helper 物化为 hoisted 闭包。
      env: { ...process.env, CI: 'true', PNPM_CONFIG_NODE_LINKER: 'hoisted' },
    })
    child.once('error', (error) => { reject(new Error(`desktop: Forge ${command} 启动失败：${error.message}`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop: Forge ${command} 失败：${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}`))
    })
  })
}

async function finalizeReleaseMaterials(platform: string, arch: string): Promise<void> {
  const makeRoot = resolve(root, '.artifacts/desktop/out/make')
  const buildInfo = JSON.parse(await readFile(join(staging, 'build-info.json'), 'utf8')) as {
    version?: unknown
    sourceCommit?: unknown
    sourceDate?: unknown
    platform?: unknown
    arch?: unknown
  }
  if (typeof buildInfo.version !== 'string' || typeof buildInfo.sourceCommit !== 'string'
    || typeof buildInfo.sourceDate !== 'string') {
    throw new Error('desktop: build-info 缺少版本、源 commit 或源日期')
  }
  if (buildInfo.platform !== platform || buildInfo.arch !== arch) {
    throw new Error(`desktop: staging 目标 ${String(buildInfo.platform)}-${String(buildInfo.arch)} 与材料目标 ${platform}-${arch} 不一致`)
  }
  await generateDesktopUpdateMetadata({
    artifactRoot: makeRoot,
    platform: platform as 'darwin' | 'win32' | 'linux',
    arch: arch as 'arm64' | 'x64',
    version: buildInfo.version,
    sourceCommit: buildInfo.sourceCommit,
    sourceDate: buildInfo.sourceDate,
  })
  await generateDesktopReleaseMaterials({
    root,
    staging,
    artifactRoot: makeRoot,
    outputRoot: makeRoot,
  })
}

const options = parseCommand(process.argv.slice(2))
if (options.command === 'materials') {
  await finalizeReleaseMaterials(options.platform, options.arch)
} else {
  await prepareStaging(options.platform, options.arch)
  if (options.command !== 'stage') await runForge(options.command, options.arch, options.platform)
  if (options.command === 'make') await finalizeReleaseMaterials(options.platform, options.arch)
}
