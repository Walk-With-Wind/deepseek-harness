/**
 * Node 22 startup-output smoke for the shipped Web CLI composition.
 *
 * 仅专用 Node 兼容性门禁会在产物构建后启用本测试；普通 Vitest 清单固定跳过。
 * 子进程在普通 Node 下运行已构建产物，并使用自动初始化的正式 Web profile
 * （dsh-base + dsh-gui-app + dsh-web-app）。URL 输出发生在 profile 完成启动后，
 * 随后的 SIGTERM 用于验证正式的完全停稳释放流程。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
// 全文搜索在 base 与共享 GUI 层都保持关闭，浏览器传输层不再拥有该配置。
const baseConfigPath = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const guiConfigPath = join(repoRoot, 'packages/bundle/gui-app/cordis.patch.yml')
const requireBuiltArtifacts = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'

interface ConfigRow {
  id?: string
  disabled?: unknown
  config?: { openAt?: unknown }
}

interface PatchEntry extends ConfigRow {
  insert?: ConfigRow[]
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => String(value),
})
const configSchema = yaml.JSON_SCHEMA.extend(jsExprType)

/** Boot the built Web CLI, wait for its settled URL, then dispose through SIGTERM. */
function runBuiltWeb(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEEPSEEK_API_KEY: 'dsh-cli-smoke-dummy-key',
      DSH_HOME: join(cwd, '.dsh'),
    }
    delete env.DEEPSEEK_BASE_URL
    delete env.NODE_OPTIONS
    delete env.NODE_NO_WARNINGS
    const child = spawn(process.execPath, [
      builtBin,
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!settled && /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout)) {
        settled = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`built Web CLI did not settle and dispose within 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!settled) {
        rejectRun(new Error(`built Web CLI exited before settled startup (code ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolveRun({ stdout, stderr, code: code ?? -1 })
    })
  })
}

describe.skipIf(!requireBuiltArtifacts)('built CLI lazy-search startup', () => {
  it('boots and disposes the shipped composition with full-text search off by default', async () => {
    expect(existsSync(builtBin), `missing built CLI ${resolve(builtBin)}; run pnpm build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build:web`).toBe(true)
    const baseRows = (yaml.load(await readFile(baseConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const guiRows = (yaml.load(await readFile(guiConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const baseRow = baseRows.find(row => row.id === 'session-query-sqlite')
    const guiRow = guiRows.find(row => row.id === 'session-query-sqlite')
    expect(baseRow?.config?.openAt).toBe('never')
    expect(baseRow?.disabled).toBeUndefined()
    // 共享 GUI 层固定默认值；启用全文搜索仍由更后的用户层完整覆盖。
    expect(guiRow?.config?.openAt).toBe('never')
    expect(guiRow?.disabled).toBeUndefined()

    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cli-lazy-search-'))
    try {
      const result = await runBuiltWeb(cwd)
      expect(result.stdout).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+/u)
      expect(result.code).toBe(0)
      expect(result.stderr).not.toMatch(/ExperimentalWarning: SQLite/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 70_000)
})
