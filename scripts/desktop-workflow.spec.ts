/** Desktop workflow 的平台、签名隔离与非发布约束。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { releaseFamily } from './release/families.ts'

const root = resolve(import.meta.dirname, '..')

function workflow(): Record<string, unknown> {
  return load(readFileSync(resolve(root, '.github/workflows/desktop.yml'), 'utf8')) as Record<string, unknown>
}

function jobs(): Record<string, Record<string, unknown>> {
  return workflow().jobs as Record<string, Record<string, unknown>>
}

/** 校验桌面任务覆盖统一的首发平台与原生 runner。 */
function expectDesktopTargetMatrix(job: Record<string, unknown>): void {
  const matrix = (job.strategy as {
    matrix: { include: Array<Record<string, string>> }
  }).matrix.include
  expect(matrix.map(value => `${value.platform}-${value.arch}`)).toEqual([
    'darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64',
  ])
  expect(matrix.map(value => value.runner)).toEqual([
    'macos-15', 'macos-15-intel', 'windows-2022', 'ubuntu-22.04',
  ])
}

describe('Desktop CI workflow', () => {
  it('把 Desktop 应用纳入统一 dsh 发布家族和版本', () => {
    const family = releaseFamily('dsh')
    const members = family.members(root)
    const desktop = members.find(member => member.name === '@deepseek-ai/dsh-desktop')
    const rootVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string
    }

    expect(desktop?.directory).toBe('apps/desktop')
    expect(desktop?.version).toBe(rootVersion.version)
    expect(desktop === undefined ? undefined : family.tagFor(desktop)).toBe(`dsh-v${rootVersion.version}`)
    expect(() => { family.verifyVersions(members) }).not.toThrow()
  })

  it('根构建入口从干净树生成全部 Desktop 进程产物', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['build:desktop']).toBe(
      'pnpm run build:lib && pnpm --filter @deepseek-ai/dsh-desktop run build',
    )
  })

  it('复制 Electron 许可证前先物化懒加载运行时', () => {
    const source = readFileSync(resolve(root, 'scripts/desktop.ts'), 'utf8')
    const materialize = source.indexOf("appRequire('electron')")
    const copyLicense = source.indexOf("copyFile(join(electronRoot, 'dist', name)")
    expect(materialize).toBeGreaterThan(-1)
    expect(copyLicense).toBeGreaterThan(materialize)
  })

  it('在原生 runner 构建四个首发平台/架构目标', () => {
    for (const name of ['unsigned-native', 'signed-release']) {
      expectDesktopTargetMatrix(jobs()[name]!)
    }
  })

  it('把签名构建限制在保护环境和人工 release 输入', () => {
    const signed = jobs()['signed-release']!
    expect(signed.if).toBe("github.event_name == 'workflow_dispatch' && inputs.release")
    expect(signed.environment).toBe('desktop-release')
    expect(JSON.stringify(signed)).toContain('DSH_DESKTOP_REQUIRE_SIGNING')
    expect(JSON.stringify(signed)).toContain('DSH_MAC_CERTIFICATE_P12_BASE64')
    expect(JSON.stringify(signed)).toContain('DSH_WINDOWS_CERTIFICATE_PFX_BASE64')
    const signedText = JSON.stringify(signed)
    expect(signedText).toContain('notarytool submit')
    expect(signedText).toContain('stapler staple')
    expect(signedText).toContain('desktop.ts materials')
    expect(signedText).toContain('Remove protected macOS signing credentials')
    expect(signedText).toContain('Remove protected Windows signing credentials')
    expect(signedText).toContain("always() && runner.os == 'macOS'")
  })

  it('验证最终包和发行材料，但不发布远端 metadata 或 channel', () => {
    const text = readFileSync(resolve(root, '.github/workflows/desktop.yml'), 'utf8')
    expect(text).toContain('verify:desktop-artifact')
    expect(text).toContain('test:desktop:installer')
    expect(text).toContain('DSH_DESKTOP_INSTALLED_ENDURANCE_ACCEPTANCE')
    expect(text).toContain('verify:desktop-materials')
    expect(text).not.toContain('gh release upload')
    expect(text).not.toContain('actions/upload-pages-artifact')
    expect(jobs()['endurance-release']!.environment).toBe('desktop-release')
    expect(jobs()['release-matrix-complete']!.needs).toEqual(['signed-release', 'endurance-release'])
  })

  it('在四个首发平台安装签名产物并运行 60 分钟真实进程链耐久门禁', () => {
    const endurance = jobs()['endurance-release']!
    const serialized = JSON.stringify(endurance)
    expect(endurance.needs).toBe('signed-release')
    expect(endurance['timeout-minutes']).toBe(150)
    expectDesktopTargetMatrix(endurance)
    expect(serialized).toContain('actions/download-artifact@v4')
    expect(serialized).toContain('deepseek-harness-${{ matrix.target }}-signed')
    expect(serialized).toContain("runner.os == 'macOS'")
    expect(serialized).toContain("runner.os == 'Windows'")
    expect(serialized).toContain("runner.os == 'Linux'")
    expect(serialized).toContain('hdiutil attach')
    expect(serialized).toContain('DeepSeek-Harness-Setup.exe')
    expect(serialized).toContain('apt-get install')
    expect(serialized).toContain('DSH_DESKTOP_INSTALLED_ENDURANCE_ACCEPTANCE')
    expect(serialized).toContain('desktop-installed-data-smoke.mjs')
    expect(serialized).toContain('xvfb-run')
    expect(serialized).toContain("always() && runner.os == 'macOS'")
    expect(serialized).toContain("always() && runner.os == 'Windows'")
    expect(serialized).toContain("always() && runner.os == 'Linux'")
    expect(serialized).toContain('apt-get remove')
    expect(serialized).not.toContain('pnpm run test:desktop:endurance')

    const installed = readFileSync(resolve(root, 'scripts/desktop-installed-data-smoke.mjs'), 'utf8')
    expect(installed).toContain('DSH_DESKTOP_INSTALLED_ENDURANCE_ACCEPTANCE')
    expect(installed).toContain('id: \'desktop-installed-endurance-acceptance\'')
    expect(installed).toContain('ctx.desktopHost.resourceSnapshot()')
    expect(installed).toContain('name: \'停止生成\'')
    expect(installed).toContain('EVENT_RENDERER-READY')
    expect(installed).toContain('endurance-metrics.jsonl')
    expect(installed).toContain('name: pluginPath')
    expect(installed).toContain('apiKeyEnv: DSH_DESKTOP_INSTALLED_ENDURANCE_API_KEY')
    expect(installed).toContain('DSH_DESKTOP_INSTALLED_ENDURANCE_CANCEL_INTERVAL')
    expect(serialized).toContain('DSH_DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE')
    expect(installed).toContain('--dsh-desktop-installed-unary-latency-acceptance')
    expect(installed).toContain('unary-latency.json')
    expect(installed).toContain("url.pathname === '/api/desktop-installed-unary-latency'")
  })

  it('在共享门禁和 60 分钟耐久门禁中验证 1 KiB unary IPC p95', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['test:desktop:ipc-latency']).toBe('tsx scripts/desktop-ipc-latency.mjs')
    expect(JSON.stringify(jobs().shared)).toContain('test:desktop:ipc-latency')
    const latency = readFileSync(resolve(root, 'scripts/desktop-ipc-latency.mjs'), 'utf8')
    expect(latency).toContain('sampleRequests: 100')
    expect(latency).toContain('DESKTOP_UNARY_IPC_MAX_EXTRA_P95_MS')
    const endurance = readFileSync(resolve(root, 'scripts/desktop-ipc-endurance.mjs'), 'utf8')
    expect(endurance).toContain('measureDesktopUnaryIpcLatency')
    expect(endurance).toContain('unaryLatency')
  })

  it('只在支持 ASAR integrity 的 macOS 上篡改一次性副本并验证拒绝启动', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['test:desktop:asar-tamper']).toBe('tsx scripts/desktop-asar-tamper.ts')
    for (const name of ['unsigned-native', 'signed-release']) {
      const job = jobs()[name]!
      const serialized = JSON.stringify(job)
      expect(serialized).toContain('test:desktop:asar-tamper')
      const step = (job.steps as Array<Record<string, unknown>>)
        .find(value => value.run === 'pnpm run test:desktop:asar-tamper')
      expect(step?.if).toBe("runner.os == 'macOS'")
    }
    const tamper = readFileSync(resolve(root, 'scripts/desktop-asar-tamper.ts'), 'utf8')
    expect(tamper).toContain("statFile(asar, 'lib/main.js')")
    expect(tamper).toContain("['--force', '--deep', '--sign', '-', copiedApp]")
    expect(tamper).toContain("event === 'EVENT_RENDERER-READY'")
  })

  it('Windows packaged smoke 读取真实进程树并通过窗口消息触发有界关停', () => {
    const smoke = readFileSync(resolve(root, 'scripts/desktop-packaged-smoke.mjs'), 'utf8')
    expect(smoke).toContain('Get-CimInstance Win32_Process')
    expect(smoke).toContain('CloseMainWindow()')
    expect(smoke).toContain('Get-NetTCPConnection')
    expect(smoke).toContain('Get-NetUDPEndpoint')
    expect(smoke).toContain("'-iUDP'")
    expect(smoke).toContain('DEEPSEEK_API_KEY')
    expect(smoke).toContain('--type=renderer')
    expect(smoke).toContain("latestEventPid(utilityLog, 'BOOT_READY')")
    expect(smoke).toContain('initialRendererReadyCount + 3')
    expect(smoke).toContain("process.env.DSH_DESKTOP_FAULT_ACCEPTANCE === '1'")
    expect(smoke).toContain("process.env.DSH_DESKTOP_CIRCUIT_ACCEPTANCE === '1'")
    expect(smoke).toContain("process.env.DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE === '1'")
    expect(smoke).toContain("process.env.DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE === '1'")
    expect(smoke).toContain("latest.phase !== 'CIRCUIT_OPEN'")
    expect(smoke).toContain("secondDesktopInstance: 'passed'")
    expect(smoke).toContain('第二个 packaged Desktop 实例')
    expect(smoke).toContain("contender: 'Web Host'")
    expect(smoke).toContain('forcedRestartMs')
    expect(smoke).not.toContain("if (platform === 'win32') return [rootPid]")
    expect(JSON.stringify(jobs()['unsigned-native'])).toContain('DSH_DESKTOP_FAULT_ACCEPTANCE')
    expect(JSON.stringify(jobs()['unsigned-native'])).toContain('DSH_DESKTOP_CIRCUIT_ACCEPTANCE')
    expect(JSON.stringify(jobs()['unsigned-native'])).toContain('DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE')
    expect(JSON.stringify(jobs()['unsigned-native'])).toContain('DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE')
    expect(JSON.stringify(jobs()['signed-release'])).toContain('DSH_DESKTOP_CIRCUIT_ACCEPTANCE')
    expect(JSON.stringify(jobs()['signed-release'])).toContain('DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE')
    expect(JSON.stringify(jobs()['signed-release'])).toContain('DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE')
  })

  it('最终 maker 产物按平台安装、运行、卸载、重装并再次运行', () => {
    const installer = readFileSync(resolve(root, 'scripts/desktop-installer-smoke.mjs'), 'utf8')
    expect(installer).toContain("process.env.CI !== 'true'")
    expect(installer).toContain("'hdiutil', ['attach'")
    expect(installer).toContain("setup, ['--silent']")
    expect(installer).toContain("'apt-get', 'install'")
    expect(installer).toContain("'rpm', '-i'")
    expect(installer).toContain("['--uninstall', '-s']")
    expect(installer).toContain('exerciseInstallerLifecycle')
    expect(installer).toContain('runReinstalledSmoke')
    expect(installer).toContain("reinstall: 'passed'")
    expect(installer).toContain('desktop-native-smoke.mjs')
    expect(installer).toContain('desktop-performance-smoke.mjs')
    expect(installer).toContain('DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE')
    for (const name of ['unsigned-native', 'signed-release']) {
      const step = (jobs()[name]!.steps as Array<Record<string, unknown>>)
        .find(value => value.run === 'pnpm run test:desktop:installer')
      expect(step?.name).toBe('Install, smoke, uninstall and reinstall final maker artifacts')
    }
    const native = readFileSync(resolve(root, 'scripts/desktop-native-smoke.mjs'), 'utf8')
    expect(native).toContain("endsWith('.node')")
    expect(native).toContain("appRequire('node-pty')")
    expect(native).toContain("appRequire('koffi')")
    expect(native).toContain("appRequire('@vscode/ripgrep')")
    expect(native).toContain("appRequire('sharp')")
    expect(native).toContain('landlock.probe(')
    const performance = readFileSync(resolve(root, 'scripts/desktop-performance-smoke.mjs'), 'utf8')
    expect(performance).toContain('const sampleCount = 20')
    expect(performance).toContain('coldSamples')
    expect(performance).toContain('warmSamples')
    expect(performance).toContain('coldStartupP95Ms > 8_000')
    expect(performance).toContain('warmStartupP95Ms > 5_000')
    expect(performance).toContain('idleRssP95Bytes')
    expect(performance).toContain("DSH_DESKTOP_FAULT_ACCEPTANCE: '0'")
    expect(performance).toContain("DSH_DESKTOP_CIRCUIT_ACCEPTANCE: '0'")
    expect(performance).toContain("DSH_DESKTOP_RENDERER_CIRCUIT_ACCEPTANCE: '0'")
    expect(performance).toContain("DSH_DESKTOP_CRASH_RESTART_ACCEPTANCE: '0'")
    const packaged = readFileSync(resolve(root, 'scripts/desktop-packaged-smoke.mjs'), 'utf8')
    expect(packaged).toContain('? 5 * 60 * 1000')
    expect(packaged).toContain('const idleRssLimitBytes = 560 * 1024 * 1024')
    expect(JSON.stringify(jobs()['signed-release'])).toContain('DSH_DESKTOP_FULL_ACCEPTANCE')
  })

  it('在最终安装进程链中发送 100 MiB 附件并执行 RSS 门禁', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const desktopManifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    expect(manifest.scripts['test:desktop:installed-data']).toBe(
      'node scripts/desktop-installed-data-smoke.mjs',
    )
    expect(desktopManifest.devDependencies.playwright).toBeDefined()
    const installed = readFileSync(resolve(root, 'scripts/desktop-installed-data-smoke.mjs'), 'utf8')
    expect(installed).toContain('const acceptanceBytes = 100 * 1024 * 1024')
    expect(installed).toContain('const peakRssDeltaLimitBytes = 300 * 1024 * 1024')
    expect(installed).toContain('chromium.connectOverCDP')
    expect(installed).toContain("join(dshHome, 'attachments', 'v1', 'objects')")
    expect(installed).toContain('const exportAcceptanceBytes = process.env.DSH_DESKTOP_INSTALLED_EXPORT_BYTES')
    expect(installed).toContain("type: 'session-log/save'")
    expect(installed).toContain("type: 'operation/cancel'")
    expect(installed).toContain('const exportRssDeltaLimitBytes = 128 * 1024 * 1024')
    expect(installed).toContain('--dsh-desktop-installed-export-acceptance')
    expect(installed).toContain("inject = ['sessionPersistence', 'sessionQuery', 'attachments']")
    expect(installed).toContain('inspectZipEntries(exportTarget)')
    expect(installed).toContain('archiveSha256')
    expect(installed).not.toContain("url.pathname !== '/api/session.export'")
    const installer = readFileSync(resolve(root, 'scripts/desktop-installer-smoke.mjs'), 'utf8')
    expect(installer).toContain('desktop-installed-data-smoke.mjs')
    expect(installer).toContain('runInstalledDataSmoke(executable)')
    expect(JSON.stringify(jobs()['signed-release'])).toContain('DSH_DESKTOP_INSTALLED_EXPORT_ACCEPTANCE')
    const signedSteps = jobs()['signed-release']!.steps as Array<Record<string, unknown>>
    expect(signedSteps.some(value => value.run === 'pnpm run test:desktop:export-stress')).toBe(false)
  })
})
