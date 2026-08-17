/** 在一次性应用副本中篡改核心 JS，验证 macOS ASAR integrity 拒绝启动。 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { desktopArtifactPaths, loadDesktopAsar } from './lib/desktop-artifact.ts'

if (process.platform !== 'darwin') {
  throw new Error('desktop-asar-tamper: Electron 的 V1 embedded ASAR integrity 只在 macOS 生效')
}

const source = desktopArtifactPaths(process.platform, process.arch)
if (!existsSync(source.app)) throw new Error(`desktop-asar-tamper: 缺少最终应用 ${source.app}`)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-asar-tamper-'))
const copiedApp = join(temporaryRoot, 'DeepSeek Harness.app')
const copiedExecutable = join(copiedApp, 'Contents', 'MacOS', 'deepseek-harness')
const asar = join(copiedApp, 'Contents', 'Resources', 'app.asar')
const dshHome = join(temporaryRoot, 'home')
let application: ChildProcess | undefined

try {
  cpSync(source.app, copiedApp, {
    recursive: true,
    dereference: false,
    // Framework 的相对链接必须逐字保留，否则复制会反向引用原始应用并破坏签名密封。
    verbatimSymlinks: true,
  })
  const asarModule = await loadDesktopAsar()
  const header = asarModule.getRawHeader(asar)
  const mainEntry = asarModule.statFile(asar, 'lib/main.js')
  if (mainEntry.unpacked === true || mainEntry.size <= 0) {
    throw new Error('desktop-asar-tamper: 核心 Main 入口必须是 ASAR 内普通文件')
  }
  const mainBytes = asarModule.extractFile(asar, 'lib/main.js')
  const commentMarker = Buffer.from('//#endregion')
  const markerOffset = mainBytes.lastIndexOf(commentMarker)
  if (markerOffset < 0) throw new Error('desktop-asar-tamper: 核心 Main 入口缺少可安全篡改的注释')
  // 只修改注释中的一个字节；若完整性检查失效，JavaScript 语义仍保持不变。
  const tamperOffset = 8 + header.headerSize + Number(mainEntry.offset) + markerOffset + 3
  const descriptor = openSync(asar, 'r+')
  try {
    const byte = Buffer.alloc(1)
    if (readSync(descriptor, byte, 0, 1, tamperOffset) !== 1) {
      throw new Error('desktop-asar-tamper: 无法读取目标字节')
    }
    const originalByte = byte[0]
    if (originalByte === undefined) throw new Error('desktop-asar-tamper: 目标字节为空')
    byte[0] = originalByte ^ 1
    if (writeSync(descriptor, byte, 0, 1, tamperOffset) !== 1) {
      throw new Error('desktop-asar-tamper: 无法写入目标字节')
    }
  } finally {
    closeSync(descriptor)
  }

  // 重新 ad-hoc 签名一次性副本，确保拒绝来自 Electron ASAR 校验而非旧签名失效。
  const resign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', copiedApp], { encoding: 'utf8' })
  if (resign.status !== 0) {
    throw new Error(`desktop-asar-tamper: 无法签名一次性副本：${resign.stderr.trim()}`)
  }

  const applicationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
  }
  delete applicationEnv.DEEPSEEK_API_KEY
  delete applicationEnv.DEEPSEEK_BASE_URL
  const output: string[] = []
  application = spawn(copiedExecutable, [], {
    cwd: dirname(copiedExecutable),
    env: applicationEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  application.stdout?.on('data', (chunk: Buffer) => { output.push(chunk.toString()) })
  application.stderr?.on('data', (chunk: Buffer) => { output.push(chunk.toString()) })
  if (!await waitForExit(application, 15_000)) {
    terminateProcessGroup(application)
    throw new Error('desktop-asar-tamper: 篡改后的应用未拒绝启动')
  }
  const combinedOutput = output.join('')
  if (application.exitCode === 0 || !/asar.*integrity|integrity.*asar/i.test(combinedOutput)) {
    throw new Error([
      `desktop-asar-tamper: 未观察到 ASAR integrity 拒绝，exit=${String(application.exitCode)}`,
      combinedOutput.slice(-4_000),
    ].join('\n'))
  }
  const mainLog = join(dshHome, 'logs', 'desktop', 'main.jsonl')
  const events = readEvents(mainLog)
  if (events.some(event => event.event === 'EVENT_RENDERER-READY')) {
    throw new Error('desktop-asar-tamper: 篡改后的应用到达 Renderer ready')
  }
  console.log(JSON.stringify({
    outcome: 'passed',
    platform: process.platform,
    arch: process.arch,
    exitCode: application.exitCode,
    signal: application.signalCode,
    integrityFailureObserved: true,
  }, null, 2))
} finally {
  if (application !== undefined && !await waitForExit(application, 500)) terminateProcessGroup(application)
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function readEvents(path: string): Array<{ event?: unknown }> {
  if (!existsSync(path)) return []
  const content = readFileSync(path, 'utf8').trim()
  return content === ''
    ? []
    : content.split('\n').map(line => JSON.parse(line) as { event?: unknown })
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    child.once('exit', onExit)
  })
}

function terminateProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') throw error
  }
}
