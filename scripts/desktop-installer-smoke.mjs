/** 在隔离 CI runner 上安装、运行并卸载最终 maker 产物。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  exerciseInstallerLifecycle,
  resolveInstalledProductDirectory,
} from './desktop-installer-cycle.mjs'

if (process.env.CI !== 'true') {
  throw new Error('desktop-installer-smoke: 只允许在一次性 CI runner 上安装系统包')
}

const root = resolve(import.meta.dirname, '..')
const makeRoot = join(root, '.artifacts', 'desktop', 'out', 'make')
const smokeScript = join(root, 'scripts', 'desktop-packaged-smoke.mjs')
const nativeSmokeScript = join(root, 'scripts', 'desktop-native-smoke.mjs')
const performanceSmokeScript = join(root, 'scripts', 'desktop-performance-smoke.mjs')
const installedDataSmokeScript = join(root, 'scripts', 'desktop-installed-data-smoke.mjs')
const appRequire = createRequire(join(root, 'apps', 'desktop', 'package.json'))
const electronExecutable = appRequire('electron')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-desktop-installer-smoke-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    throw new Error(`desktop-installer-smoke: ${command} 失败，exit ${String(result.status)}`)
  }
}

function findArtifact(suffix) {
  const matches = collectFiles(makeRoot).filter(path => path.toLowerCase().endsWith(suffix.toLowerCase()))
  if (matches.length !== 1) {
    throw new Error(`desktop-installer-smoke: 期望一个 ${suffix}，实际 ${String(matches.length)}`)
  }
  return matches[0]
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

/**
 * 对最终安装路径运行 packaged smoke，并允许重装阶段关闭高成本故障和性能分支。
 * @param {string} executable - 最终安装的应用可执行文件。
 * @param {NodeJS.ProcessEnv} [overrides] - 当前阶段覆盖的 smoke 环境变量。
 * @returns {void}
 */
function runPackagedSmoke(executable, overrides = {}) {
  const product = resolveInstalledProductDirectory(executable)
  run(process.execPath, [smokeScript], {
    cwd: product,
    env: {
      ...process.env,
      DSH_DESKTOP_SMOKE_EXECUTABLE: executable,
      DSH_DESKTOP_SMOKE_PRODUCT: product,
      ...overrides,
    },
  })
}

/**
 * 首次安装运行完整 packaged、原生和可选性能验收。
 * @param {string} executable - 最终安装的应用可执行文件。
 * @returns {void}
 */
function runInitialInstalledSmoke(executable) {
  const product = resolveInstalledProductDirectory(executable)
  runPackagedSmoke(executable, { DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE: '0' })
  if (process.env.DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE === '1') {
    runPackagedSmoke(executable, {
      DSH_DESKTOP_FULL_ACCEPTANCE: '0',
      DSH_DESKTOP_FAULT_ACCEPTANCE: '0',
      DSH_DESKTOP_CIRCUIT_ACCEPTANCE: '0',
      DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE: '0',
      DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE: '1',
    })
  }
  run(electronExecutable, [nativeSmokeScript], {
    cwd: product,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_SMOKE_EXECUTABLE: executable,
    },
  })
  if (process.env.DSH_DESKTOP_FULL_ACCEPTANCE === '1') {
    runInstalledDataSmoke(executable)
    run(process.execPath, [performanceSmokeScript], {
      cwd: product,
      env: {
        ...process.env,
        DSH_DESKTOP_SMOKE_EXECUTABLE: executable,
        DSH_DESKTOP_SMOKE_PRODUCT: product,
      },
    })
  }
}

/**
 * 在最终安装应用的真实 Renderer、Utility 和 Main 进程链中执行大附件门禁。
 * @param {string} executable - 最终安装的应用可执行文件。
 * @returns {void}
 */
function runInstalledDataSmoke(executable) {
  const product = resolveInstalledProductDirectory(executable)
  run(process.execPath, [installedDataSmokeScript], {
    cwd: product,
    env: {
      ...process.env,
      DSH_DESKTOP_SMOKE_EXECUTABLE: executable,
      DSH_DESKTOP_SMOKE_PRODUCT: product,
    },
  })
}

/**
 * 重装后再次运行真实 packaged 启动路径，但不重复高成本的故障和性能矩阵。
 * @param {string} executable - 重装后的应用可执行文件。
 * @returns {void}
 */
function runReinstalledSmoke(executable) {
  runPackagedSmoke(executable, {
    DSH_DESKTOP_FULL_ACCEPTANCE: '0',
    DSH_DESKTOP_FAULT_ACCEPTANCE: '0',
    DSH_DESKTOP_CIRCUIT_ACCEPTANCE: '0',
    DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE: '0',
    DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE: '0',
  })
}

/**
 * 根据安装阶段选择完整或重装 smoke。
 * @param {string} executable - 当前安装的应用可执行文件。
 * @param {'initial' | 'reinstall'} phase - 当前安装阶段。
 * @returns {void}
 */
function runLifecycleSmoke(executable, phase) {
  if (phase === 'initial') runInitialInstalledSmoke(executable)
  else runReinstalledSmoke(executable)
}

/** 在隔离 Applications 目录中验证 DMG 的安装、卸载和重装。 */
function smokeMacDmg() {
  const dmg = findArtifact('.dmg')
  const mount = join(temporary, 'mounted-dmg')
  const installed = join(temporary, 'Applications', 'DeepSeek Harness.app')
  mkdirSync(mount, { recursive: true })
  mkdirSync(dirname(installed), { recursive: true })
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
  try {
    exerciseInstallerLifecycle({
      install() {
        run('ditto', [join(mount, 'DeepSeek Harness.app'), installed])
        return join(installed, 'Contents', 'MacOS', 'deepseek-harness')
      },
      smoke: runLifecycleSmoke,
      uninstall() {
        rmSync(installed, { recursive: true, force: true })
        if (existsSync(installed)) throw new Error('desktop-installer-smoke: macOS 应用卸载后仍存在')
      },
    })
  } finally {
    run('hdiutil', ['detach', mount, '-force'])
  }
}

/** 在当前 CI 用户目录中验证 Squirrel 的安装、卸载和重装。 */
function smokeWindowsSquirrel() {
  const setup = findArtifact('DeepSeek-Harness-Setup.exe')
  const installRoot = join(process.env.LOCALAPPDATA ?? '', 'DeepSeekHarness')
  if (installRoot === 'DeepSeekHarness') throw new Error('desktop-installer-smoke: LOCALAPPDATA 未设置')
  exerciseInstallerLifecycle({
    install() {
      run(setup, ['--silent'])
      const executable = collectFiles(installRoot)
        .find(path => path.toLowerCase().endsWith('deepseek-harness.exe'))
      if (executable === undefined) throw new Error('desktop-installer-smoke: Squirrel 未安装应用 exe')
      return executable
    },
    smoke: runLifecycleSmoke,
    uninstall() {
      const update = join(installRoot, 'Update.exe')
      try {
        if (existsSync(update)) run(update, ['--uninstall', '-s'])
      } finally {
        const executableRemains = existsSync(installRoot)
          && collectFiles(installRoot).some(path => path.toLowerCase().endsWith('deepseek-harness.exe'))
        rmSync(installRoot, { recursive: true, force: true })
        if (executableRemains) throw new Error('desktop-installer-smoke: Squirrel 卸载后应用 exe 仍存在')
      }
    },
  })
}

try {
  if (process.platform === 'darwin') smokeMacDmg()
  else if (process.platform === 'win32') smokeWindowsSquirrel()
  else throw new Error(`desktop-installer-smoke: 不支持平台 ${process.platform}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log(JSON.stringify({ installerLifecycle: 'passed', reinstall: 'passed' }))
