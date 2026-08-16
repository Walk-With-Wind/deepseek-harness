/** 从最终 packaged app 读取 ASAR、fuses 与原生解包清单。 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  desktopArtifactPaths,
  loadDesktopAsar,
  type DesktopAsarModule,
} from './lib/desktop-artifact.ts'
import { verifyNativeRuntimeFiles } from './lib/runtime-staging.ts'

interface FusesModule {
  getCurrentFuseWire(path: string): Promise<Record<string | number, unknown>>
}

async function loadFuses(): Promise<FusesModule> {
  const root = new URL('../apps/desktop/package.json', import.meta.url)
  const appRequire = createRequire(root)
  const path = appRequire.resolve('@electron/fuses')
  return await import(pathToFileURL(path).href) as FusesModule
}

async function collectFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`desktop-artifact: unpacked 包含非常规文件 ${path}`)
  }
  return files
}

function expectFuse(value: unknown, enabled: boolean, name: string): void {
  const normalized = String(value).toLowerCase()
  const actual = normalized === 'enabled' || normalized === '49'
    ? true
    : normalized === 'disabled' || normalized === '48'
      ? false
      : undefined
  if (actual !== enabled) {
    throw new Error(`desktop-artifact: fuse ${name} 期望 ${enabled ? 'Enabled' : 'Disabled'}，实际 ${String(value)}`)
  }
}

function verifyMacAsarIntegrity(app: string, asar: string, asarModule: DesktopAsarModule): void {
  if (process.platform !== 'darwin') return
  const result = spawnSync('plutil', [
    '-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-artifact: 无法读取 macOS ASAR integrity：${result.stderr.trim()}`)
  const plist = JSON.parse(result.stdout) as {
    ElectronAsarIntegrity?: Record<string, { algorithm?: string; hash?: string }>
  }
  const integrity = plist.ElectronAsarIntegrity?.['Resources/app.asar']
  if (integrity?.algorithm !== 'SHA256' || typeof integrity.hash !== 'string') {
    throw new Error('desktop-artifact: Info.plist 缺少 SHA256 ASAR integrity')
  }
  const expected = integrity.hash
  const actual = createHash('sha256').update(asarModule.getRawHeader(asar).headerString).digest('hex')
  if (actual !== expected) throw new Error('desktop-artifact: app.asar header hash 与 Info.plist 不一致')
}

function verifyMacSignature(app: string): void {
  if (process.platform !== 'darwin') return
  const strict = process.env.DSH_DESKTOP_REQUIRE_SIGNING === '1'
  if (!strict) return
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-artifact: macOS 签名验证失败：${result.stderr.trim()}`)
  const detail = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' })
  if (/Signature=adhoc/.test(detail.stderr)) throw new Error('desktop-artifact: release 产物不得使用 ad-hoc 签名')
  const gatekeeper = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { encoding: 'utf8' })
  if (gatekeeper.status !== 0) throw new Error(`desktop-artifact: Gatekeeper 验收失败：${gatekeeper.stderr.trim()}`)
}

function verifyWindowsSignature(executable: string): void {
  if (process.platform !== 'win32' || process.env.DSH_DESKTOP_REQUIRE_SIGNING !== '1') return
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:DSH_VERIFY_EXECUTABLE',
    'if ($signature.Status -ne "Valid") { throw "Desktop executable signature is not valid" }',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_VERIFY_EXECUTABLE: executable },
  })
  if (result.status !== 0) {
    throw new Error(`desktop-artifact: Windows Authenticode 验证失败：${result.stderr.trim()}`)
  }
}

const platform = process.platform
const arch = process.arch
if (arch !== 'arm64' && arch !== 'x64') throw new Error(`desktop-artifact: 不支持架构 ${arch}`)
const target = desktopArtifactPaths(platform, arch)
for (const path of [target.app, target.executable, target.resources]) {
  if (!existsSync(path)) throw new Error(`desktop-artifact: 缺少最终产物 ${path}`)
}

const asar = join(target.resources, 'app.asar')
if (!existsSync(asar)) throw new Error('desktop-artifact: 缺少 resources/app.asar')
if (existsSync(join(target.resources, 'app', 'lib', 'main.js'))) {
  throw new Error('desktop-artifact: 核心 Main 代码不得从 ASAR 外加载')
}

const asarModule = await loadDesktopAsar()
const entries = new Set(asarModule.listPackage(asar).map(path => path.replace(/^\//, '')))
for (const required of [
  'package.json', 'build-info.json', 'lib/main.js', 'lib/preload.cjs', 'lib/utility.js',
  'renderer/index.html', 'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html',
  'licenses/npm-overrides/Apache-2.0.txt',
  'licenses/npm-overrides/GPL-3.0.txt',
  'licenses/npm-overrides/LGPL-3.0.txt',
  'licenses/npm-overrides/MIT-Amit-Gupta.txt',
  'licenses/npm-overrides/MIT-Mario-Zechner.txt',
  'licenses/npm-overrides/MIT-Nathan-Rajlich.txt',
  'licenses/npm-overrides/MIT-Niels-Martignene.txt',
]) {
  if (!entries.has(required)) throw new Error(`desktop-artifact: app.asar 缺少 ${required}`)
}
for (const path of entries) {
  if (/^(?:src|tests)(?:\/|$)/.test(path)
    || /(?:^|\/)forge\.config\./.test(path)
    || path === 'pnpm-lock.yaml') {
    throw new Error(`desktop-artifact: app.asar 包含非发行输入 ${path}`)
  }
}

const unpacked = join(target.resources, 'app.asar.unpacked')
const unpackedFiles = await collectFiles(unpacked)
for (const path of unpackedFiles) {
  const rel = relative(unpacked, path).split(sep).join('/')
  const sharedLibrary = (platform === 'darwin' && rel.endsWith('.dylib'))
    || (platform === 'win32' && rel.endsWith('.dll'))
    || (platform === 'linux' && /\.so(?:\.\d+)*$/.test(rel))
  if (!rel.endsWith('.node')
    && !sharedLibrary
    && !/(?:^|\/)spawn-helper$/.test(rel)
    && !/(?:^|\/)@vscode\/ripgrep(?:-[^/]+)?\/(?:.*\/)?rg(?:\.exe)?$/.test(rel)
    && !/(?:^|\/)@deepseek-ai\/node-addon-landlock-run-linux-(?:x64|arm64)\/bin\/landlock-run$/.test(rel)) {
    throw new Error(`desktop-artifact: ASAR unpacked 文件不在白名单 ${rel}`)
  }
}
const nativeFiles = await verifyNativeRuntimeFiles(unpacked, platform, arch)
if (nativeFiles.length === 0) throw new Error('desktop-artifact: 最终产物无原生文件')

const fusesModule = await loadFuses()
const fuses = await fusesModule.getCurrentFuseWire(target.executable)
expectFuse(fuses[0], false, 'RunAsNode')
expectFuse(fuses[1], true, 'EnableCookieEncryption')
expectFuse(fuses[2], false, 'EnableNodeOptionsEnvironmentVariable')
expectFuse(fuses[3], false, 'EnableNodeCliInspectArguments')
expectFuse(fuses[4], true, 'EnableEmbeddedAsarIntegrityValidation')
expectFuse(fuses[5], true, 'OnlyLoadAppFromAsar')
expectFuse(fuses[6], false, 'LoadBrowserProcessSpecificV8Snapshot')
expectFuse(fuses[7], false, 'GrantFileProtocolExtraPrivileges')

verifyMacAsarIntegrity(target.app, asar, asarModule)
verifyMacSignature(target.app)
verifyWindowsSignature(target.executable)

console.log(JSON.stringify({
  outcome: 'verified',
  product: basename(target.app),
  platform,
  arch,
  asarSha256: createHash('sha256').update(await readFile(asar)).digest('hex'),
  asarEntries: entries.size,
  unpackedFiles: unpackedFiles.length,
  nativeFiles,
}, null, 2))
