/** 在最终 packaged app 上验证离线启动、进程恢复、无端口 Host 与有界关停。 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertDesktopBusinessDataUnchanged,
  isExpectedDesktopLeaseConflict,
  snapshotDesktopBusinessData,
} from './desktop-business-snapshot.mjs'

const {
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_PRODUCT_NAME,
} = await import('../apps/desktop/lib/types-host/shared/release-policy.js')

const root = resolve(import.meta.dirname, '..')
const platform = process.platform
const arch = process.arch
const product = process.env.DSH_DESKTOP_SMOKE_PRODUCT === undefined
  ? join(root, '.artifacts', 'desktop', 'out', `${DESKTOP_PRODUCT_NAME}-${platform}-${arch}`)
  : resolve(process.env.DSH_DESKTOP_SMOKE_PRODUCT)
const executable = process.env.DSH_DESKTOP_SMOKE_EXECUTABLE === undefined
  ? platform === 'darwin'
    ? join(product, `${DESKTOP_PRODUCT_NAME}.app`, 'Contents', 'MacOS', DESKTOP_EXECUTABLE_NAME)
    : join(product, platform === 'win32' ? `${DESKTOP_EXECUTABLE_NAME}.exe` : DESKTOP_EXECUTABLE_NAME)
  : resolve(process.env.DSH_DESKTOP_SMOKE_EXECUTABLE)
if (!existsSync(executable)) throw new Error(`desktop-packaged-smoke: 缺少 ${executable}`)

const ownsDshHome = process.env.DSH_DESKTOP_SMOKE_HOME === undefined
const dshHome = ownsDshHome
  ? mkdtempSync(join(tmpdir(), 'dsh-desktop-packaged-smoke-'))
  : resolve(process.env.DSH_DESKTOP_SMOKE_HOME)
const fullAcceptance = process.env.DSH_DESKTOP_FULL_ACCEPTANCE === '1'
const circuitAcceptance = process.env.DSH_DESKTOP_CIRCUIT_ACCEPTANCE === '1'
const rendererCircuitAcceptance = process.env.DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE === '1'
const crashRestartAcceptance = process.env.DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE === '1'
const faultAcceptance = fullAcceptance
  || circuitAcceptance
  || rendererCircuitAcceptance
  || process.env.DSH_DESKTOP_FAULT_ACCEPTANCE === '1'
if (circuitAcceptance && rendererCircuitAcceptance) {
  throw new Error('packaged app 的 Utility 与 Renderer 熔断验收必须使用隔离进程分别执行')
}
// 三进程 RSS 按平台原生工作集求和，包含 Electron Framework 在各进程中的共享驻留页。
const idleRssLimitBytes = 560 * 1024 * 1024
const processOutput = []
let application

function launchApplication(environment) {
  const child = spawn(executable, [], {
    cwd: product,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => { processOutput.push(chunk.toString()) })
  child.stderr?.on('data', chunk => { processOutput.push(chunk.toString()) })
  return child
}

function readEvents(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line))
}

async function waitForEventCount(path, event, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readEvents(path).filter(record => record.event === event).length
    if (found >= count) return
    if (application.exitCode !== null || application.signalCode !== null) {
      throw new Error([
        `packaged app 在第 ${String(count)} 个 ${event} 前退出：${application.exitCode ?? application.signalCode}`,
        existsSync(path) ? readFileSync(path, 'utf8') : `${path} 尚未创建`,
        processOutput.join(''),
      ].join('\n'))
    }
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  throw new Error([
    `packaged app 等待第 ${String(count)} 个 ${event} 超时`,
    existsSync(path) ? readFileSync(path, 'utf8') : `${path} 尚未创建`,
    processOutput.join(''),
  ].join('\n'))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await Promise.race([
    new Promise(resolvePromise => { child.once('exit', () => { resolvePromise(true) }) }),
    new Promise(resolvePromise => { setTimeout(() => { resolvePromise(false) }, timeoutMs) }),
  ])
}

function processRows() {
  if (platform !== 'win32') return posixProcessRows()
  return powershellJson('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress')
    .map(value => ({
      pid: Number(value.ProcessId),
      parent: Number(value.ParentProcessId),
      command: String(value.CommandLine ?? ''),
    }))
}

function descendantRows(rootPid) {
  const rows = processRows()
  const children = new Map()
  for (const row of rows) {
    const { pid, parent } = row
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue
    const owned = children.get(parent) ?? []
    owned.push(row)
    children.set(parent, owned)
  }
  const root = rows.find(row => row.pid === rootPid) ?? { pid: rootPid, parent: 0, command: executable }
  const owned = [root]
  for (let index = 0; index < owned.length; index += 1) {
    owned.push(...(children.get(owned[index].pid) ?? []))
  }
  return owned
}

function posixProcessRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-packaged-smoke: 无法读取进程树：${result.stderr}`)
  return result.stdout.trim().split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }]
  })
}

function powershellJson(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`desktop-packaged-smoke: PowerShell 检查失败：${result.stderr}`)
  }
  const output = result.stdout.replace(/^\uFEFF/, '').trim()
  if (output === '') return []
  const value = JSON.parse(output)
  return Array.isArray(value) ? value : [value]
}

function assertNoNetworkListeners(pids) {
  if (platform === 'win32') {
    const ids = pids.join(',')
    const listeners = powershellJson([
      `$ids = @(${ids})`,
      "$tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object @{Name='Protocol';Expression={'TCP'}},LocalAddress,LocalPort,OwningProcess",
      "$udp = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object @{Name='Protocol';Expression={'UDP'}},LocalAddress,LocalPort,OwningProcess",
      '@($tcp) + @($udp) | ConvertTo-Json -Compress',
    ].join('; '))
    if (listeners.length !== 0) {
      throw new Error(`packaged app 不得监听 TCP 或 UDP 端口：\n${JSON.stringify(listeners, null, 2)}`)
    }
    return
  }
  for (const pid of pids) {
    for (const args of [
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
      ['-nP', '-a', '-p', String(pid), '-iUDP'],
    ]) {
      const result = spawnSync('lsof', args, { encoding: 'utf8' })
      if (result.status === 0 && result.stdout.trim() !== '') {
        throw new Error(`packaged app 不得监听 TCP 或 UDP 端口：\n${result.stdout}`)
      }
    }
  }
}

/** 启动第二份最终包，验证 Electron 单实例交接不会产生第二个 Host 写入方。 */
function assertSecondDesktopRedirected(environment) {
  const before = snapshotDesktopBusinessData(dshHome)
  const result = spawnSync(executable, [], {
    cwd: product,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error !== undefined) throw result.error
  const after = snapshotDesktopBusinessData(dshHome)
  assertDesktopBusinessDataUnchanged(before, after)
  if (result.status !== 0) {
    throw new Error([
      `第二个 packaged Desktop 实例未正常完成单实例交接：exit ${String(result.status)}`,
      result.stdout ?? '',
      result.stderr ?? '',
    ].join('\n'))
  }
  if (application.exitCode !== null || application.signalCode !== null) {
    throw new Error('第二个 packaged Desktop 实例退出后首实例不再存活')
  }
}

/** 用真实 CLI 与 Web 产品争用当前安装包 home，并证明失败方没有写共享业务数据。 */
function assertCompetingProductsRejected(environment) {
  const cliEntry = resolve(process.env.DSH_DESKTOP_SMOKE_CLI_ENTRY
    ?? join(root, 'apps', 'cli', 'lib', 'bin.js'))
  if (!existsSync(cliEntry)) throw new Error(`desktop-packaged-smoke: 缺少竞争 CLI ${cliEntry}`)
  const contenders = [
    { contender: 'CLI Host', args: ['--profile', 'headless', 'Desktop lease contention acceptance'] },
    { contender: 'Web Host', args: ['web'] },
  ]
  for (const { contender, args } of contenders) {
    const before = snapshotDesktopBusinessData(dshHome)
    const result = spawnSync(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error !== undefined) throw result.error
    const after = snapshotDesktopBusinessData(dshHome)
    assertDesktopBusinessDataUnchanged(before, after)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (!isExpectedDesktopLeaseConflict(result.status, output)) {
      throw new Error([
        `packaged app 持有租约时 ${contender} 未按预期失败：exit ${String(result.status)}`,
        output,
      ].join('\n'))
    }
  }
}

function processTreeRss(rows, utilityPid) {
  const measured = rows.filter(row => row.pid === application.pid
    || row.pid === utilityPid
    || /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command))
  const pids = measured.map(row => row.pid)
  if (pids.length < 3) throw new Error(`packaged app RSS 进程集合不完整：${pids.join(', ')}`)
  if (platform === 'win32') {
    const entries = powershellJson(`Get-Process -Id ${pids.join(',')} -ErrorAction Stop | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`)
      .map(value => ({ pid: Number(value.Id), rssBytes: Number(value.WorkingSet64) }))
    return { totalBytes: entries.reduce((total, value) => total + value.rssBytes, 0), entries }
  }
  const result = spawnSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-packaged-smoke: 无法读取 RSS：${result.stderr}`)
  const entries = result.stdout.trim().split('\n').map((line) => {
    const fields = line.trim().split(/\s+/)
    return { pid: Number(fields[0]), rssBytes: Number(fields[1] ?? 0) * 1024 }
  })
  return { totalBytes: entries.reduce((total, value) => total + value.rssBytes, 0), entries }
}

function requestGracefulShutdown(child) {
  if (platform !== 'win32') {
    if (!child.kill('SIGTERM')) throw new Error('packaged app 无法接收 SIGTERM')
    return
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$target = Get-Process -Id ${String(child.pid)} -ErrorAction Stop; if (-not $target.CloseMainWindow()) { exit 3 }`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`packaged app 无法通过 CloseMainWindow() 请求有界关停：${result.stderr}`)
  }
}

function killOwnedProcess(pid, rows) {
  if (!rows.some(row => row.pid === pid)) {
    throw new Error(`packaged app 拒绝终止进程树外的 PID：${String(pid)}`)
  }
  if (platform !== 'win32') {
    process.kill(pid, 'SIGKILL')
    return
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Stop-Process -Id ${String(pid)} -Force -ErrorAction Stop`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`packaged app 无法终止 PID ${String(pid)}：${result.stderr}`)
}

function latestEventPid(path, event) {
  const record = readEvents(path).findLast(value => value.event === event && Number.isInteger(value.pid))
  if (record === undefined) throw new Error(`packaged app 的 ${event} 缺少 PID`)
  return record.pid
}

function assertExpectedErrors(mainEvents, utilityEvents, rendererEvents) {
  const errors = [...mainEvents, ...utilityEvents, ...rendererEvents]
    .filter(record => record.level === 'error')
  if (!faultAcceptance && errors.length !== 0) {
    throw new Error(`packaged app 结构化日志包含 error 记录：\n${JSON.stringify(errors, null, 2)}`)
  }
  if (!faultAcceptance) return
  const utilityCrashes = errors.filter(record => (
    record.process === 'main' && record.event === 'UTILITY_EXITED'
  ))
  const rendererCrashes = errors.filter(record => (
    record.process === 'renderer-crash'
      && record.event === 'RENDERER_PROCESS_GONE'
      && record.stableCode === 'RENDERER_PROCESS_GONE'
  ))
  // Renderer 熔断用例只终止 Renderer；Utility 的正常关停不应被计为故障注入。
  const expectedUtilityCrashes = rendererCircuitAcceptance ? 0 : circuitAcceptance ? 4 : 1
  const expectedRendererCrashes = rendererCircuitAcceptance ? 4 : 1
  if (errors.length !== expectedUtilityCrashes + expectedRendererCrashes
    || utilityCrashes.length !== expectedUtilityCrashes
    || rendererCrashes.length !== expectedRendererCrashes) {
    throw new Error(`packaged app 故障注入产生了非预期 error：\n${JSON.stringify(errors, null, 2)}`)
  }
}

async function measureIdleRssP95(utilityLog, sampleCount, durationMs) {
  const samples = []
  const intervalMs = Math.floor(durationMs / sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    await new Promise(resolvePromise => { setTimeout(resolvePromise, intervalMs) })
    const rows = descendantRows(application.pid)
    samples.push(processTreeRss(rows, latestEventPid(utilityLog, 'BOOT_READY')).totalBytes)
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    p95Bytes: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples,
  }
}

function assertProcessTreeExited(pids) {
  const alive = aliveProcessIds(pids)
  if (alive.length !== 0) throw new Error(`packaged app 关停后仍有子进程存活：${alive.join(', ')}`)
}

function aliveProcessIds(pids) {
  return platform === 'win32'
    ? powershellJson(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id | ConvertTo-Json -Compress`)
      .map(value => Number(value.Id))
    : pids.filter((pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
}

async function waitForProcessTreeExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (aliveProcessIds(pids).length === 0) return
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  assertProcessTreeExited(pids)
}

try {
  const mainLog = join(dshHome, 'logs', 'desktop', 'main.jsonl')
  const utilityLog = join(dshHome, 'logs', 'desktop', 'utility.jsonl')
  const rendererLog = join(dshHome, 'logs', 'desktop', 'renderer-crash.jsonl')
  const initialRendererReadyCount = readEvents(mainLog)
    .filter(record => record.event === 'EVENT_RENDERER-READY').length
  const initialUtilityExitCount = readEvents(mainLog)
    .filter(record => record.event === 'EVENT_UTILITY-EXIT').length
  const initialBootReadyCount = readEvents(utilityLog)
    .filter(record => record.event === 'BOOT_READY').length
  const initialQuiescentCount = readEvents(utilityLog)
    .filter(record => record.event === 'SHUTDOWN_QUIESCENT').length
  const initialRendererCrashCount = readEvents(rendererLog)
    .filter(record => record.event === 'RENDERER_PROCESS_GONE').length
  const initialRendererDocumentCount = readEvents(mainLog)
    .filter(record => record.event === 'RENDERER_DOCUMENT_LOADED').length
  const applicationEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    no_proxy: '',
  }
  // 安装包必须在无 API 凭据且网络不可达时完成本地启动。
  delete applicationEnv.DEEPSEEK_API_KEY
  delete applicationEnv.DEEPSEEK_BASE_URL
  const launchStartedAt = Date.now()
  application = launchApplication(applicationEnv)
  await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', initialRendererReadyCount + 1, 60_000)
  await waitForEventCount(utilityLog, 'BOOT_READY', initialBootReadyCount + 1, 60_000)
  const startupMs = Date.now() - launchStartedAt
  const initialRows = descendantRows(application.pid)
  const observedPids = new Set(initialRows.map(row => row.pid))
  if (observedPids.size < 3) {
    throw new Error(`packaged app 进程树不完整：${[...observedPids].join(', ')}`)
  }
  assertNoNetworkListeners([...observedPids])
  assertSecondDesktopRedirected(applicationEnv)
  assertCompetingProductsRejected(applicationEnv)
  const idleRss = processTreeRss(initialRows, latestEventPid(utilityLog, 'BOOT_READY'))
  const idleRssBytes = idleRss.totalBytes
  let idleRssP95
  let rssFailure
  if (fullAcceptance) {
    // 方案定义的是 READY 后空闲五分钟，不用刚启动时的瞬态 RSS 替代。
    const rssDurationMs = process.env.DSH_DESKTOP_RSS_DIAGNOSTIC_DURATION_MS === undefined
      ? 5 * 60 * 1000
      : Number(process.env.DSH_DESKTOP_RSS_DIAGNOSTIC_DURATION_MS)
    if (!Number.isSafeInteger(rssDurationMs) || rssDurationMs < 30_000 || rssDurationMs > 5 * 60 * 1000) {
      throw new Error('packaged app RSS 诊断时长必须在 30 秒到 5 分钟之间')
    }
    idleRssP95 = await measureIdleRssP95(utilityLog, 20, rssDurationMs)
    if (idleRssP95.p95Bytes > idleRssLimitBytes) {
      const finalRss = processTreeRss(
        descendantRows(application.pid), latestEventPid(utilityLog, 'BOOT_READY'),
      )
      rssFailure = [
        `packaged app 空闲 RSS p95 ${String(idleRssP95.p95Bytes)} 超过 560 MiB`,
        `samples=${JSON.stringify(idleRssP95.samples)}`,
        `processes=${JSON.stringify(finalRss.entries)}`,
      ].join('\n')
    }
  }

  let rendererRecoveryMs
  let utilityRecoveryMs
  if (faultAcceptance) {
    let rows = descendantRows(application.pid)
    const renderer = rows.find(row => /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command))
    if (renderer === undefined) throw new Error('packaged app 未找到受监督 Renderer 进程')
    const rendererKilledAt = Date.now()
    killOwnedProcess(renderer.pid, rows)
    await waitForEventCount(rendererLog, 'RENDERER_PROCESS_GONE', initialRendererCrashCount + 1, 30_000)
    await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', initialRendererReadyCount + 2, 60_000)
    rendererRecoveryMs = Date.now() - rendererKilledAt

    rows = descendantRows(application.pid)
    for (const row of rows) observedPids.add(row.pid)
    if (rendererCircuitAcceptance) {
      for (let crash = 2; crash <= 4; crash += 1) {
        rows = descendantRows(application.pid)
        for (const row of rows) observedPids.add(row.pid)
        const renderer = rows.find(row => /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command))
        if (renderer === undefined) throw new Error('packaged app 连续故障验收未找到 Renderer 进程')
        killOwnedProcess(renderer.pid, rows)
        await waitForEventCount(
          rendererLog, 'RENDERER_PROCESS_GONE', initialRendererCrashCount + crash, 30_000,
        )
        if (crash < 4) {
          await waitForEventCount(
            mainLog, 'EVENT_RENDERER-READY', initialRendererReadyCount + crash + 1, 60_000,
          )
          continue
        }
        await waitForEventCount(
          mainLog, 'RENDERER_DOCUMENT_LOADED', initialRendererDocumentCount + 5, 60_000,
        )
        const latest = readEvents(mainLog)
          .findLast(record => record.event === 'EVENT_RENDERER-GONE')
        if (latest === undefined || latest.phase !== 'CIRCUIT_OPEN') {
          throw new Error(`packaged app 连续 Renderer 失败后未显示熔断恢复页：${JSON.stringify(latest)}`)
        }
      }
    } else {
      const utilityPid = latestEventPid(utilityLog, 'BOOT_READY')
      const utilityKilledAt = Date.now()
      killOwnedProcess(utilityPid, rows)
      await waitForEventCount(mainLog, 'EVENT_UTILITY-EXIT', initialUtilityExitCount + 1, 30_000)
      await waitForEventCount(utilityLog, 'BOOT_READY', initialBootReadyCount + 2, 60_000)
      await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', initialRendererReadyCount + 3, 60_000)
      utilityRecoveryMs = Date.now() - utilityKilledAt
      if (utilityRecoveryMs > 15_000) {
        throw new Error(`packaged app Utility 恢复 ${String(utilityRecoveryMs)}ms 超过 15000ms`)
      }
      for (const row of descendantRows(application.pid)) observedPids.add(row.pid)
      assertNoNetworkListeners([...observedPids])
    }

    if (circuitAcceptance && !rendererCircuitAcceptance) {
      for (let crash = 2; crash <= 4; crash += 1) {
        rows = descendantRows(application.pid)
        for (const row of rows) observedPids.add(row.pid)
        killOwnedProcess(latestEventPid(utilityLog, 'BOOT_READY'), rows)
        await waitForEventCount(mainLog, 'EVENT_UTILITY-EXIT', initialUtilityExitCount + crash, 30_000)
        if (crash < 4) {
          await waitForEventCount(utilityLog, 'BOOT_READY', initialBootReadyCount + crash + 1, 60_000)
          await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', initialRendererReadyCount + crash + 2, 60_000)
          continue
        }
        const latest = readEvents(mainLog)
          .findLast(record => record.event === 'EVENT_UTILITY-EXIT')
        if (latest === undefined || latest.phase !== 'CIRCUIT_OPEN') {
          throw new Error(`packaged app 连续 Utility 失败后未进入 CIRCUIT_OPEN：${JSON.stringify(latest)}`)
        }
      }
    }
  }

  let forcedRestartMs
  if (crashRestartAcceptance) {
    const crashedRows = descendantRows(application.pid)
    const crashedPids = crashedRows.map(row => row.pid)
    for (const pid of crashedPids) observedPids.add(pid)
    // 强杀 Main 后必须先证明整棵旧进程树消失，再让同一 home 的新 Host 回收残留租约。
    killOwnedProcess(application.pid, crashedRows)
    if (!await waitForExit(application, 5_000)) throw new Error('packaged app 强制终止 Main 后未退出')
    await waitForProcessTreeExit(crashedPids, 15_000)

    const restartRendererReadyCount = readEvents(mainLog)
      .filter(record => record.event === 'EVENT_RENDERER-READY').length
    const restartBootReadyCount = readEvents(utilityLog)
      .filter(record => record.event === 'BOOT_READY').length
    const restartStartedAt = Date.now()
    application = launchApplication(applicationEnv)
    await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', restartRendererReadyCount + 1, 60_000)
    await waitForEventCount(utilityLog, 'BOOT_READY', restartBootReadyCount + 1, 60_000)
    forcedRestartMs = Date.now() - restartStartedAt
    const restartedRows = descendantRows(application.pid)
    if (restartedRows.length < 3) throw new Error('packaged app 强制终止后重启的进程树不完整')
    for (const row of restartedRows) observedPids.add(row.pid)
    assertNoNetworkListeners(restartedRows.map(row => row.pid))
  }

  const shutdownStartedAt = Date.now()
  requestGracefulShutdown(application)
  if ((!circuitAcceptance && !rendererCircuitAcceptance) || crashRestartAcceptance) {
    await waitForEventCount(utilityLog, 'SHUTDOWN_QUIESCENT', initialQuiescentCount + 1, 30_000)
  }
  if (!await waitForExit(application, 15_000)) throw new Error('packaged app 未在有界关停窗口内退出')
  const shutdownMs = Date.now() - shutdownStartedAt
  await new Promise(resolvePromise => { setTimeout(resolvePromise, 250) })
  assertProcessTreeExited([...observedPids])
  const mainEvents = readEvents(mainLog)
  const utilityEvents = readEvents(utilityLog)
  const rendererEvents = readEvents(rendererLog)
  assertExpectedErrors(mainEvents, utilityEvents, rendererEvents)
  if (rssFailure !== undefined) throw new Error(rssFailure)
  console.log(JSON.stringify({
    outcome: 'passed',
    fullAcceptance,
    faultAcceptance,
    circuitAcceptance,
    rendererCircuitAcceptance,
    crashRestartAcceptance,
    secondDesktopInstance: 'passed',
    hostLeaseConflicts: ['cli', 'web'],
    startupMs,
    idleRssBytes,
    ...(idleRssP95 === undefined ? {} : { idleRssP95Bytes: idleRssP95.p95Bytes }),
    shutdownMs,
    ...(rendererRecoveryMs === undefined ? {} : { rendererRecoveryMs }),
    ...(utilityRecoveryMs === undefined ? {} : { utilityRecoveryMs }),
    ...(forcedRestartMs === undefined ? {} : { forcedRestartMs }),
    pids: [...observedPids],
    mainEvents: mainEvents.map(record => record.event),
    utilityEvents: utilityEvents.map(record => record.event),
    rendererEvents: rendererEvents.map(record => record.event),
  }, null, 2))
} finally {
  if (application !== undefined && !await waitForExit(application, 1_000)) {
    application.kill('SIGTERM')
    if (!await waitForExit(application, 5_000)) application.kill('SIGKILL')
  }
  if (ownsDshHome) rmSync(dshHome, { recursive: true, force: true })
}
