/** 在最终安装应用上采集固定样本并执行启动、RSS 与关停 p95 门禁。 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.CI !== 'true') {
  throw new Error('desktop-performance-smoke: 只允许在一次性 CI runner 上运行最终安装应用')
}

const root = resolve(import.meta.dirname, '..')
const smokeScript = join(root, 'scripts', 'desktop-packaged-smoke.mjs')
const sampleCount = 20
const warmHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-performance-warm-'))

/**
 * 使用指定的一次性 home 运行一个最终安装应用样本。
 * @param {string} dshHome - 当前样本使用的隔离 Harness home。
 * @returns {{ startupMs: number, shutdownMs: number, idleRssBytes: number }} 进程级测量值。
 */
function runSample(dshHome) {
  const result = spawnSync(process.execPath, [smokeScript], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      // 性能样本必须排除签名任务继承的故障注入分支，避免启动时间与进程生命周期被验收开关污染。
      DSH_DESKTOP_FULL_ACCEPTANCE: '0',
      DSH_DESKTOP_FAULT_ACCEPTANCE: '0',
      DSH_DESKTOP_CIRCUIT_ACCEPTANCE: '0',
      DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE: '0',
      DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE: '0',
      DSH_DESKTOP_SMOKE_HOME: dshHome,
    },
  })
  if (result.status !== 0) {
    throw new Error(`desktop-performance-smoke: 样本失败\n${result.stdout}\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

/** 使用互不复用的 home 收集真正的首次启动样本，并立即清理每个 home。 */
function collectColdSamples() {
  return Array.from({ length: sampleCount }, () => {
    const coldHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-performance-cold-'))
    try {
      return runSample(coldHome)
    } finally {
      rmSync(coldHome, { recursive: true, force: true })
    }
  })
}

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

try {
  const coldSamples = collectColdSamples()
  // 温启动集合先执行一次不计入样本的预热，再保留全部正式样本，不删除离群值。
  runSample(warmHome)
  const warmSamples = Array.from({ length: sampleCount }, () => runSample(warmHome))
  const coldStartupP95Ms = p95(coldSamples.map(value => value.startupMs))
  const warmStartupP95Ms = p95(warmSamples.map(value => value.startupMs))
  const shutdownP95Ms = p95([...coldSamples, ...warmSamples].map(value => value.shutdownMs))
  const idleRssP95Bytes = p95(warmSamples.map(value => value.idleRssBytes))
  if (coldStartupP95Ms > 8_000) {
    throw new Error(`desktop-performance-smoke: 冷启动 p95 ${String(coldStartupP95Ms)}ms 超过 8000ms`)
  }
  if (warmStartupP95Ms > 5_000) {
    throw new Error(`desktop-performance-smoke: 温启动 p95 ${String(warmStartupP95Ms)}ms 超过 5000ms`)
  }
  if (shutdownP95Ms > 20_000) {
    throw new Error(`desktop-performance-smoke: 关停 p95 ${String(shutdownP95Ms)}ms 超过 20000ms`)
  }
  console.log(JSON.stringify({
    outcome: 'passed',
    sampleCount,
    coldStartupP95Ms,
    warmStartupP95Ms,
    shutdownP95Ms,
    idleRssP95Bytes,
    coldSamples: coldSamples.map(value => ({
      startupMs: value.startupMs,
      shutdownMs: value.shutdownMs,
    })),
    warmSamples: warmSamples.map(value => ({
      startupMs: value.startupMs,
      shutdownMs: value.shutdownMs,
      idleRssBytes: value.idleRssBytes,
    })),
  }, null, 2))
} finally {
  rmSync(warmHome, { recursive: true, force: true })
}
