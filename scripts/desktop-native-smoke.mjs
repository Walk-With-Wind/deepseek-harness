/** 使用匹配 Electron ABI 的测试运行时实际执行最终安装目录中的原生能力。 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const executable = resolve(process.env.DSH_DESKTOP_SMOKE_EXECUTABLE ?? '')
if (!existsSync(executable)) throw new Error('desktop-native-smoke: 缺少已安装应用可执行文件')
const canonicalExecutable = realpathSync(executable)
const resources = process.platform === 'darwin'
  ? resolve(dirname(canonicalExecutable), '..', 'Resources')
  : join(dirname(canonicalExecutable), 'resources')
const asar = join(resources, 'app.asar')
const unpacked = join(resources, 'app.asar.unpacked')
if (!existsSync(asar) || !existsSync(unpacked)) {
  throw new Error(`desktop-native-smoke: 已安装应用缺少 ASAR 资源 ${resources}`)
}

const appRequire = createRequire(join(asar, 'package.json'))
const loadedAddons = []
for (const path of collectFiles(unpacked).filter(path => path.endsWith('.node')).sort()) {
  appRequire(path)
  loadedAddons.push(path.slice(unpacked.length + 1).replaceAll('\\', '/'))
}
if (loadedAddons.length === 0) throw new Error('desktop-native-smoke: 未实际加载任何 .node 文件')

const sharp = appRequire('sharp')
const png = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
}).png().toBuffer()
if (png[0] !== 0x89 || png.subarray(1, 4).toString() !== 'PNG') {
  throw new Error('desktop-native-smoke: sharp 未生成有效 PNG')
}

const koffi = appRequire('koffi')
const processId = process.platform === 'win32'
  ? koffi.load('kernel32.dll').func('__stdcall', 'GetCurrentProcessId', 'uint32', [])()
  : koffi.load('/usr/lib/libSystem.B.dylib')
    .func('getpid', 'int', [])()
if (processId !== process.pid) throw new Error('desktop-native-smoke: Koffi 原生调用返回错误 PID')

const ripgrep = appRequire('@vscode/ripgrep')
const rg = spawnSync(unpackedPath(ripgrep.rgPath), ['--version'], { encoding: 'utf8' })
if (rg.status !== 0 || !/^ripgrep /m.test(rg.stdout)) {
  throw new Error(`desktop-native-smoke: ripgrep 执行失败 ${rg.stderr}`)
}

const ptyOutput = await runPty(appRequire('node-pty'))
if (!ptyOutput.includes('dsh-native-pty')) throw new Error('desktop-native-smoke: PTY 未返回探针文本')

await writeResult({
  outcome: 'passed',
  loadedAddons,
  sharpBytes: png.byteLength,
  ripgrep: rg.stdout.trim().split(/\r?\n/, 1)[0],
  pty: 'passed',
})
// 原生模块可在 Windows 留下 libuv handle；探针结果刷新后不再依赖自然事件循环退出。
process.exit(0)

function writeResult(result) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) => {
      if (error === undefined || error === null) resolvePromise()
      else reject(error)
    })
  })
}

function collectFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function unpackedPath(path) {
  const prefix = `${asar}${process.platform === 'win32' ? '\\' : '/'}`
  return path.startsWith(prefix) ? join(unpacked, path.slice(prefix.length)) : path
}

function runPty(pty) {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Write('dsh-native-pty')"]
      : ['-c', "printf 'dsh-native-pty'"]
    const child = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: dirname(executable), env: process.env })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('desktop-native-smoke: PTY 探针超时'))
    }, 10_000)
    child.onData(data => { output += data })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode === 0) resolvePromise(output)
      else reject(new Error(`desktop-native-smoke: PTY 退出码 ${String(exitCode)}`))
    })
  })
}
