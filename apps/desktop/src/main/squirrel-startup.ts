/** Squirrel.Windows 维护启动在常规 Desktop 启动前处理快捷方式并及时退出。 */
import { spawn } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { app } from 'electron'

const SQUIRREL_MAINTENANCE_EXIT_DELAY_MS = 1_000

interface SquirrelStartupRuntime {
  startUpdater(args: readonly string[]): void
  deferQuit(delayMs: number): void
  quit(): void
}

const defaultRuntime: SquirrelStartupRuntime = {
  startUpdater(args) {
    const updateExecutable = resolve(dirname(process.execPath), '..', 'Update.exe')
    const child = spawn(updateExecutable, [...args], { detached: true, stdio: 'ignore' })
    child.once('error', () => {
      // 快捷方式维护失败不能阻止 Squirrel 安装、更新或卸载继续完成。
    })
    child.unref()
  },
  deferQuit(delayMs) {
    setTimeout(() => { app.quit() }, delayMs)
  },
  quit() {
    app.quit()
  },
}

function startUpdaterAndDeferQuit(runtime: SquirrelStartupRuntime, args: readonly string[]): void {
  try {
    runtime.startUpdater(args)
  } catch {
    // 同步启动失败与异步 updater 错误具有相同的非阻塞退出要求。
  }
  runtime.deferQuit(SQUIRREL_MAINTENANCE_EXIT_DELAY_MS)
}

/**
 * 处理当前进程的 Squirrel.Windows 维护事件。
 * @param platform - 当前 Node 平台。
 * @param argv - 当前进程参数。
 * @param executablePath - 当前应用可执行文件路径。
 * @param runtime - 快捷方式维护和退出适配器。
 * @returns 是否已接管当前启动；为 true 时调用方不得启动常规 Desktop Host。
 */
export function handleSquirrelStartup(
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
  executablePath: string = process.execPath,
  runtime: SquirrelStartupRuntime = defaultRuntime,
): boolean {
  if (platform !== 'win32') return false

  const target = basename(executablePath)
  switch (argv[1]) {
    case '--squirrel-install':
    case '--squirrel-updated':
      startUpdaterAndDeferQuit(runtime, [`--createShortcut=${target}`])
      return true
    case '--squirrel-uninstall':
      startUpdaterAndDeferQuit(runtime, [`--removeShortcut=${target}`])
      return true
    case '--squirrel-obsolete':
      runtime.quit()
      return true
    default:
      return false
  }
}
