/** 在最终安装应用中验证 100 MiB 附件、真实 IPC 进程链和 RSS 峰值。 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const appRequire = createRequire(join(root, 'apps', 'desktop', 'package.json'))
const { chromium } = appRequire('playwright')
const executable = resolve(process.env.DSH_DESKTOP_SMOKE_EXECUTABLE ?? '')
if (!existsSync(executable)) throw new Error('desktop-installed-data-smoke: 缺少已安装应用可执行文件')

const product = resolve(process.env.DSH_DESKTOP_SMOKE_PRODUCT ?? dirname(executable))
const acceptanceBytes = 100 * 1024 * 1024
const peakRssDeltaLimitBytes = 300 * 1024 * 1024
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 10_000
const rssSampleIntervalMs = process.platform === 'win32' ? 1_000 : 100
const perImageBytes = 5 * 1024 * 1024
const diagnosticBytes = process.env.DSH_DESKTOP_ATTACHMENT_DIAGNOSTIC_BYTES === undefined
  ? acceptanceBytes
  : Number(process.env.DSH_DESKTOP_ATTACHMENT_DIAGNOSTIC_BYTES)
if (!Number.isSafeInteger(diagnosticBytes)
  || diagnosticBytes < 1024 * 1024
  || diagnosticBytes > acceptanceBytes) {
  throw new Error('desktop-installed-data-smoke: 诊断附件大小必须在 1 MiB 到 100 MiB 之间')
}
const imageSizes = Array.from(
  { length: Math.ceil(diagnosticBytes / perImageBytes) },
  (_value, index) => Math.min(perImageBytes, diagnosticBytes - index * perImageBytes),
)
const fullAcceptance = diagnosticBytes === acceptanceBytes
const installedExportAcceptance = process.env.DSH_DESKTOP_INSTALLED_EXPORT_ACCEPTANCE === '1'
const exportAcceptanceBytes = process.env.DSH_DESKTOP_INSTALLED_EXPORT_BYTES === undefined
  ? 1024 * 1024 * 1024
  : Number(process.env.DSH_DESKTOP_INSTALLED_EXPORT_BYTES)
if (installedExportAcceptance && process.env.CI !== 'true') {
  throw new Error('desktop-installed-data-smoke: 安装态 1 GiB 导出只允许在一次性 CI runner 上运行')
}
if (!Number.isSafeInteger(exportAcceptanceBytes)
  || exportAcceptanceBytes < 8 * 1024 * 1024
  || exportAcceptanceBytes > 1024 * 1024 * 1024) {
  throw new Error('desktop-installed-data-smoke: 导出诊断容量必须在 8 MiB 到 1 GiB 之间')
}
const fullExportAcceptance = exportAcceptanceBytes === 1024 * 1024 * 1024
const exportRssDeltaLimitBytes = 128 * 1024 * 1024
const installedEnduranceAcceptance = process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_ACCEPTANCE === '1'
const enduranceAcceptanceDurationMs = process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_DURATION_MS === undefined
  ? 60 * 60 * 1000
  : Number(process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_DURATION_MS)
if (installedEnduranceAcceptance && process.env.CI !== 'true') {
  throw new Error('desktop-installed-data-smoke: 安装态耐久验收只允许在一次性 CI runner 上运行')
}
if (!Number.isSafeInteger(enduranceAcceptanceDurationMs)
  || enduranceAcceptanceDurationMs < 10_000
  || enduranceAcceptanceDurationMs > 60 * 60 * 1000) {
  throw new Error('desktop-installed-data-smoke: 耐久诊断时长必须在 10 秒到 60 分钟之间')
}
const fullEnduranceAcceptance = enduranceAcceptanceDurationMs === 60 * 60 * 1000
const installedUnaryLatencyAcceptance = process.env.DSH_DESKTOP_INSTALLED_UNARY_LATENCY_ACCEPTANCE === '1'
if (installedUnaryLatencyAcceptance && process.env.CI !== 'true') {
  throw new Error('desktop-installed-data-smoke: 安装态 unary 延迟验收只允许在一次性 CI runner 上运行')
}
const endurancePortCycleRequests = process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_PORT_CYCLE_REQUESTS === undefined
  ? 100
  : Number(process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_PORT_CYCLE_REQUESTS)
if (!Number.isSafeInteger(endurancePortCycleRequests) || endurancePortCycleRequests < 2) {
  throw new Error('desktop-installed-data-smoke: 耐久端口轮换间隔必须是不小于 2 的整数')
}
const enduranceRssGrowthLimitBytes = 128 * 1024 * 1024
const enduranceCancellationInterval = process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_CANCEL_INTERVAL === undefined
  ? 5
  : Number(process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_CANCEL_INTERVAL)
if (!Number.isSafeInteger(enduranceCancellationInterval) || enduranceCancellationInterval < 2) {
  throw new Error('desktop-installed-data-smoke: 耐久取消间隔必须是不小于 2 的整数')
}
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-installed-data-'))
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-desktop-installed-workspace-')))
const exportRoot = join(dshHome, '.desktop-acceptance', 'export')
const exportTarget = join(exportRoot, 'session-export.zip')
const enduranceMetricsPath = join(dshHome, '.desktop-acceptance', 'endurance-metrics.jsonl')
const unaryLatencyMetricsPath = join(dshHome, '.desktop-acceptance', 'unary-latency.json')
const marker = `desktop-installed-data-${randomUUID()}`
const output = []
let application
let browser
let activePage
let enduranceProvider
let observedPids = new Set()

/** 输出安装态验收的当前阶段，使原生 runner 卡点可从实时日志辨认。 */
function reportPhase(phase) {
  console.log(`desktop-installed-data-smoke: phase=${phase}`)
}

/** 在驱动进程生成严格有效的 GIF，避免把验收数据构造开销计入 Renderer RSS。 */
function seedAttachmentFiles() {
  const base = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'base64',
  )
  if (base.at(-1) !== 0x3b) throw new Error('附件诊断 GIF 缺少 trailer')
  const prefix = base.subarray(0, base.byteLength - 1)
  const trailer = base.subarray(base.byteLength - 1)
  const directory = join(dshHome, 'acceptance-input')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return imageSizes.map((size, index) => {
    const extensionBytes = size - base.byteLength
    const blockBytes = extensionBytes - 3
    const blockCount = Math.ceil(blockBytes / 256)
    let payloadBytes = blockBytes - blockCount
    if (blockCount < 1 || payloadBytes < blockCount || payloadBytes > blockCount * 255) {
      throw new Error('附件诊断大小无法编码为 GIF comment extension')
    }
    const extension = Buffer.alloc(extensionBytes)
    extension[0] = 0x21
    extension[1] = 0xfe
    let cursor = 2
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const remainingBlocks = blockCount - blockIndex
      const length = Math.min(255, payloadBytes - (remainingBlocks - 1))
      extension[cursor] = length
      cursor += 1
      if (blockIndex === 0) extension[cursor] = index + 1
      cursor += length
      payloadBytes -= length
    }
    extension[cursor] = 0
    if (cursor + 1 !== extension.byteLength || payloadBytes !== 0) {
      throw new Error('附件诊断 GIF comment extension 长度错误')
    }
    const path = join(directory, `acceptance-${String(index + 1)}.gif`)
    writeFileSync(path, prefix, { mode: 0o600 })
    appendFileSync(path, extension)
    appendFileSync(path, trailer)
    if (statSync(path).size !== size) throw new Error(`附件诊断文件大小错误：${path}`)
    return path
  })
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue
    rejectPromise = rejectValue
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolvePromise, reject) => {
      timer = setTimeout(() => { reject(new Error(message)) }, timeoutMs)
    }),
  ]).finally(() => { clearTimeout(timer) })
}

function seedWorkspace(providerBaseUrl) {
  const workspaceId = randomUUID()
  const now = new Date().toISOString()
  const storageRoot = join(dshHome, 'storages')
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(storageRoot, 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: workspace,
          title: 'Acceptance Workspace',
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })
  // 发布耐久验收使用驱动进程的回环 provider；普通大附件验收仍使用本地不可达地址。
  writeFileSync(join(dshHome, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    acceptance:',
    '      displayName: Acceptance',
    '      apiKeyEnv: DSH_DESKTOP_INSTALLED_ENDURANCE_API_KEY',
    '      api: openai-completions',
    `      baseURL: ${providerBaseUrl ?? 'http://127.0.0.1:9/v1'}`,
    '      models:',
    '        - id: vision',
    '          name: Acceptance Vision',
    '          contextWindow: 65536',
    '          maxTokens: 1024',
    '          input:',
    '            - text',
    '            - image',
    '',
  ].join('\n'), { mode: 0o600 })

  seedAcceptancePlugins()
}

/** 统一生成一次性可信验收插件列表，避免多个功能覆盖同一 patch。 */
function seedAcceptancePlugins() {
  const plugins = []
  if (installedExportAcceptance) plugins.push(seedSyntheticExportProvider())
  if (installedEnduranceAcceptance) plugins.push(seedEnduranceMetricsProvider())
  if (installedUnaryLatencyAcceptance) plugins.push(seedUnaryLatencyProvider())
  if (plugins.length === 0) return
  const rows = ['- insert:']
  for (const plugin of plugins) {
    rows.push(`    - id: ${plugin.id}`, `      name: ${JSON.stringify(plugin.name)}`)
  }
  rows.push('')
  writeFileSync(join(dshHome, 'cordis.patch.yml'), rows.join('\n'), { mode: 0o600 })
}

/**
 * 在一次性 Home 中挂载可信测试插件，为真实 Session ZIP handler 提供有界合成存储源。
 * 插件只替换专用 Session 和附件引用，其余持久化与附件读取继续交给产品 provider。
 */
function seedSyntheticExportProvider() {
  mkdirSync(exportRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    const mode = statSync(exportRoot).mode & 0o777
    if (mode !== 0o700) throw new Error(`desktop-installed-data-smoke: 验收导出目录权限错误 ${mode.toString(8)}`)
  }
  const pluginPath = join(dshHome, 'desktop-installed-export-acceptance.mjs')
  writeFileSync(pluginPath, [
    '/** 一次性安装态验收插件：只为专用 Session 提供可重复的合成持久化与附件源。 */',
    "import { createHash } from 'node:crypto'",
    "export const inject = ['sessionPersistence', 'sessionQuery', 'attachments']",
    "const SESSION_ID = 'desktop-installed-export-acceptance'",
    'const TARGET_BYTES = Number(process.env.DSH_DESKTOP_INSTALLED_EXPORT_BYTES)',
    'const ENTRY_BYTES = 5 * 1024 * 1024',
    'const ENTRY_COUNT = Math.ceil(TARGET_BYTES / ENTRY_BYTES)',
    'const refs = Array.from({ length: ENTRY_COUNT }, (_value, index) => ({',
    "  attachmentId: `sha256:${index.toString(16).padStart(64, '0')}`,",
    "  mediaType: 'image/gif', bytes: ENTRY_BYTES, width: 1, height: 1,",
    '}))',
    'const header = { type: \'session\', version: 0, id: SESSION_ID, createdAt: 0, delegationDepth: 0 }',
    'const event = {',
    "  type: 'user/message', seq: 0, at: 0,",
    "  data: { message: { content: refs.map(attachment => ({ type: 'image', attachment })) } },",
    '}',
    "const content = `${JSON.stringify(header)}\\n${JSON.stringify(event)}\\n`",
    "const base = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')",
    'const prefix = base.subarray(0, base.byteLength - 1)',
    'const trailer = base.subarray(base.byteLength - 1)',
    'const extensionBytes = ENTRY_BYTES - base.byteLength',
    'const blockBytes = extensionBytes - 3',
    'const blockCount = Math.ceil(blockBytes / 256)',
    'let payloadBytes = blockBytes - blockCount',
    'const extension = Buffer.alloc(extensionBytes)',
    'const seed = Buffer.alloc(64 * 1024)',
    'for (let index = 0; index < seed.byteLength / 32; index += 1) {',
    "  createHash('sha256').update(`desktop-installed-export-${index}`).digest().copy(seed, index * 32)",
    '}',
    'extension[0] = 0x21; extension[1] = 0xfe',
    'let cursor = 2; let seedOffset = 0',
    'for (let index = 0; index < blockCount; index += 1) {',
    '  const remainingBlocks = blockCount - index',
    '  const length = Math.min(255, payloadBytes - (remainingBlocks - 1))',
    '  extension[cursor] = length; cursor += 1',
    '  let copied = 0',
    '  while (copied < length) {',
    '    const size = Math.min(length - copied, seed.byteLength - seedOffset)',
    '    seed.copy(extension, cursor + copied, seedOffset, seedOffset + size)',
    '    copied += size; seedOffset = (seedOffset + size) % seed.byteLength',
    '  }',
    '  cursor += length; payloadBytes -= length',
    '}',
    'extension[cursor] = 0',
    'const image = Buffer.concat([prefix, extension, trailer])',
    'const refIds = new Set(refs.map(ref => ref.attachmentId))',
    'export function apply(ctx) {',
    '  const persistence = ctx.sessionPersistence',
    '  const sessionQuery = ctx.sessionQuery',
    '  const attachments = ctx.attachments',
    '  const originalReadRaw = persistence.readRaw',
    '  const originalTraceSession = sessionQuery.traceSession',
    '  const originalReadImage = attachments.readImage',
    '  const readRaw = async function(id, signal) {',
    '    if (String(id) !== SESSION_ID) return originalReadRaw.call(persistence, id, signal)',
    '    signal?.throwIfAborted()',
    '    return { meta: header, filename: \'session.jsonl\', content }',
    '  }',
    '  const traceSession = async function(id, signal) {',
    '    if (String(id) !== SESSION_ID) return originalTraceSession.call(sessionQuery, id, signal)',
    '    signal?.throwIfAborted()',
    '    const target = { header, live: false, persisted: true }',
    '    return { target, ancestors: [], descendants: [], complete: true, root: target }',
    '  }',
    '  const readImage = async function(ref, signal) {',
    '    if (!refIds.has(String(ref.attachmentId))) return originalReadImage.call(attachments, ref, signal)',
    '    // 固定等待让取消门禁稳定观察到同目录临时文件，且不改变真实 ZIP 背压链。',
    '    await new Promise(resolve => setTimeout(resolve, 100))',
    '    signal?.throwIfAborted()',
    '    return { ref, data: image }',
    '  }',
    '  ctx.effect(() => {',
    '    persistence.readRaw = readRaw',
    '    sessionQuery.traceSession = traceSession',
    '    attachments.readImage = readImage',
    '    return () => {',
    '      if (persistence.readRaw === readRaw) persistence.readRaw = originalReadRaw',
    '      if (sessionQuery.traceSession === traceSession) sessionQuery.traceSession = originalTraceSession',
    '      if (attachments.readImage === readImage) attachments.readImage = originalReadImage',
    '    }',
    "  }, 'desktop installed export acceptance')",
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  // 封闭 Host 的 Loader 接受绝对磁盘路径并在内部转成 file URL。
  return { id: 'desktop-installed-export-acceptance', name: pluginPath }
}

/** 在 Utility 内按固定间隔记录脱敏资源计数，供驱动进程比较端口轮换前后基线。 */
function seedEnduranceMetricsProvider() {
  const metricsRoot = dirname(enduranceMetricsPath)
  mkdirSync(metricsRoot, { recursive: true, mode: 0o700 })
  writeFileSync(enduranceMetricsPath, '', { mode: 0o600 })
  const pluginPath = join(dshHome, 'desktop-installed-endurance-acceptance.mjs')
  writeFileSync(pluginPath, [
    '/** 一次性安装态耐久插件：只记录无标识符和正文的资源计数。 */',
    "import { appendFileSync } from 'node:fs'",
    "export const inject = ['desktopHost']",
    'export function apply(ctx) {',
    '  const metricsPath = process.env.DSH_DESKTOP_INSTALLED_ENDURANCE_METRICS',
    "  if (!metricsPath) throw new Error('缺少安装态耐久指标路径')",
    '  const sample = () => {',
    "    appendFileSync(metricsPath, JSON.stringify({ at: Date.now(), ...ctx.desktopHost.resourceSnapshot() }) + '\\n')",
    '  }',
    '  sample()',
    '  const timer = setInterval(sample, 250)',
    '  timer.unref()',
    '  ctx.effect(() => () => { clearInterval(timer); sample() }, "desktop installed endurance acceptance")',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  return { id: 'desktop-installed-endurance-acceptance', name: pluginPath }
}

/** 在 Utility 的真实业务分发点提供固定 1 KiB echo，并归档 Renderer 端采样结果。 */
function seedUnaryLatencyProvider() {
  const metricsRoot = dirname(unaryLatencyMetricsPath)
  mkdirSync(metricsRoot, { recursive: true, mode: 0o700 })
  const pluginPath = join(dshHome, 'desktop-installed-unary-latency-acceptance.mjs')
  writeFileSync(pluginPath, [
    '/** 一次性安装态验收插件：提供固定 unary echo 并记录无正文延迟指标。 */',
    "import { writeFileSync } from 'node:fs'",
    "export const inject = ['connection']",
    'export function apply(ctx) {',
    '  const metricsPath = process.env.DSH_DESKTOP_INSTALLED_UNARY_LATENCY_METRICS',
    "  if (!metricsPath) throw new Error('缺少安装态 unary 延迟指标路径')",
    '  const connection = ctx.connection',
    '  const originalDispatch = connection.dispatch',
    '  const dispatch = async function(request, context) {',
    '    const url = new URL(request.url)',
    "    if (request.method === 'POST' && url.pathname === '/api/desktop-installed-unary-latency') {",
    '      const body = new Uint8Array(await request.arrayBuffer())',
    '      request.signal.throwIfAborted()',
    '      const startedAt = performance.now()',
    '      const response = new Response(body, {',
    "        headers: { 'content-type': 'application/octet-stream' },",
    '      })',
    '      const directDispatchMs = performance.now() - startedAt',
    '      if (body.byteLength !== 1024) return new Response(\'invalid unary bytes\', { status: 400 })',
    "      response.headers.set('x-dsh-acceptance-dispatch-ms', String(directDispatchMs))",
    '      return response',
    '    }',
    "    if (request.method === 'POST' && url.pathname === '/api/desktop-installed-unary-latency/result') {",
    '      const result = JSON.parse(await request.text())',
    "      writeFileSync(metricsPath, `${JSON.stringify(result)}\\n`, { mode: 0o600 })",
    '      return new Response(null, { status: 204 })',
    '    }',
    '    return originalDispatch.call(connection, request, context)',
    '  }',
    '  ctx.effect(() => {',
    '    connection.dispatch = dispatch',
    '    return () => { if (connection.dispatch === dispatch) connection.dispatch = originalDispatch }',
    "  }, 'desktop installed unary latency acceptance')",
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  return { id: 'desktop-installed-unary-latency-acceptance', name: pluginPath }
}

/**
 * 启动只监听回环的 OpenAI 兼容流式 provider。
 * provider 位于应用进程树外，因此能验证 Utility 中的真实网络请求、取消和 IPC 背压。
 */
async function startEnduranceProvider() {
  let mainRequests = 0
  let completedRequests = 0
  let cancelledRequests = 0
  const activeResponses = new Set()
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"error":"invalid request"}')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      })
      if (parsed.max_tokens === 64) {
        response.end([
          'data: {"choices":[{"delta":{"content":"Endurance title"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
        return
      }
      mainRequests += 1
      const cancellationTurn = body.includes('desktop-endurance-cancel-')
      const chunkCount = cancellationTurn ? 256 : 16
      const payload = `${cancellationTurn ? 'cancel' : 'complete'}-${String(mainRequests)}-`
        + 'x'.repeat(4 * 1024)
      let sent = 0
      let settled = false
      let timer
      const settleCancelled = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        activeResponses.delete(response)
        cancelledRequests += 1
      }
      const writeNext = () => {
        if (settled) return
        if (sent === chunkCount) {
          settled = true
          activeResponses.delete(response)
          completedRequests += 1
          response.end([
            'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ].join('\n\n'))
          return
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`)
        sent += 1
        timer = setTimeout(writeNext, 25)
      }
      activeResponses.add(response)
      response.once('close', settleCancelled)
      writeNext()
    })
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('desktop-installed-data-smoke: 耐久 provider 未绑定 TCP 端口')
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    snapshot: () => ({
      mainRequests,
      completedRequests,
      cancelledRequests,
      activeResponses: activeResponses.size,
    }),
    async close() {
      for (const response of activeResponses) response.destroy()
      server.closeAllConnections?.()
      await new Promise(resolvePromise => { server.close(resolvePromise) })
    },
  }
}

function processRows() {
  if (process.platform === 'win32') {
    return powershellJson('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress')
      .map(value => ({
        pid: Number(value.ProcessId),
        parent: Number(value.ParentProcessId),
        command: String(value.CommandLine ?? ''),
      }))
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-installed-data-smoke: 无法读取进程树：${result.stderr}`)
  return result.stdout.trim().split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }]
  })
}

function powershellJson(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
  })
  if (result.error !== undefined) {
    throw new Error('desktop-installed-data-smoke: PowerShell 检查无法完成', { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`desktop-installed-data-smoke: PowerShell 检查失败：${result.stderr}`)
  }
  const text = result.stdout.replace(/^\uFEFF/, '').trim()
  if (text === '') return []
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}

function descendantRows(rootPid) {
  const rows = processRows()
  const children = new Map()
  for (const row of rows) {
    const owned = children.get(row.parent) ?? []
    owned.push(row)
    children.set(row.parent, owned)
  }
  const rootRow = rows.find(row => row.pid === rootPid)
    ?? { pid: rootPid, parent: 0, command: executable }
  const owned = [rootRow]
  for (let index = 0; index < owned.length; index += 1) {
    owned.push(...(children.get(owned[index].pid) ?? []))
  }
  return owned
}

function readEvents(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line))
}

async function waitForUtilityPid() {
  const path = join(dshHome, 'logs', 'desktop', 'utility.jsonl')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const event = readEvents(path).findLast(value => value.event === 'BOOT_READY')
    if (event !== undefined && Number.isInteger(event.pid)) return event.pid
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  throw new Error('desktop-installed-data-smoke: Utility 未在 60 秒内进入 READY')
}

function processTreeRss(utilityPid) {
  const rows = descendantRows(application.pid)
  for (const row of rows) observedPids.add(row.pid)
  const measured = rows.filter(row => row.pid === application.pid
    || row.pid === utilityPid
    || /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command))
  const pids = measured.map(row => row.pid)
  if (pids.length < 3) {
    throw new Error(`desktop-installed-data-smoke: RSS 进程集合不完整：${pids.join(', ')}`)
  }
  return processRss(pids)
}

/** 读取已确定进程集合的当前 RSS，避免高频重复枚举 Windows 进程树。 */
function processRss(pids) {
  if (process.platform === 'win32') {
    const entries = powershellJson(`Get-Process -Id ${pids.join(',')} -ErrorAction Stop | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`)
      .map(value => ({ pid: Number(value.Id), rssBytes: Number(value.WorkingSet64) }))
    return { totalBytes: entries.reduce((total, entry) => total + entry.rssBytes, 0), entries }
  }
  const result = spawnSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`desktop-installed-data-smoke: 无法读取 RSS：${result.stderr}`)
  const entries = result.stdout.trim().split('\n').map((line) => {
    const [pid, rss] = line.trim().split(/\s+/)
    return { pid: Number(pid), rssBytes: Number(rss) * 1024 }
  })
  return { totalBytes: entries.reduce((total, entry) => total + entry.rssBytes, 0), entries }
}

/** 读取当前 Utility 的原生工作集，避免把 Main 与 Renderer 波动计入导出门槛。 */
function utilityRssBytes(utilityPid, measuredPids) {
  const entry = processRss(measuredPids).entries.find(value => value.pid === utilityPid)
  if (entry === undefined) throw new Error('desktop-installed-data-smoke: Utility RSS 样本缺失')
  return entry.rssBytes
}

/** 记录应用进程 RSS 与 Renderer JS 堆，区分预览解码和 IPC 传输的峰值来源。 */
async function memoryCheckpoint(page, utilityPid) {
  const rss = processTreeRss(utilityPid)
  const rendererJsHeapBytes = await page.evaluate(() => {
    const memory = performance['memory']
    return memory === undefined ? null : Number(memory.usedJSHeapSize)
  })
  return { rss, rendererJsHeapBytes }
}

function collectFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function persistedSessionLog() {
  const candidates = collectFiles(join(dshHome, 'sessions'))
    .filter(path => path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl'))
  for (const path of candidates) {
    const content = readFileSync(path)
    if (path.endsWith('.jsonl')) {
      if (content.toString('utf8').includes(marker)) return path
      continue
    }
    // 默认日志是可追加的独立 Zstandard frame；两个 magic 说明 header 之外已有事件批次。
    let frames = 0
    for (let offset = 0; offset <= content.byteLength - 4; offset += 1) {
      if (content.readUInt32LE(offset) === 0xfd2fb528) frames += 1
    }
    if (frames >= 2) return path
  }
  return undefined
}

async function waitForPersistence(page, expectedFiles, expectedBytes) {
  const objectsRoot = join(dshHome, 'attachments', 'v1', 'objects')
  const stagingRoot = join(dshHome, 'attachments', 'v1', 'tmp')
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const objects = collectFiles(objectsRoot)
    const bytes = objects.reduce((total, path) => total + statSync(path).size, 0)
    const sessionLog = persistedSessionLog()
    const messageVisible = await page.getByText(marker, { exact: true }).count() > 0
    if (objects.length === expectedFiles
      && bytes === expectedBytes
      && sessionLog !== undefined
      && messageVisible) {
      const staged = collectFiles(stagingRoot)
      if (staged.length !== 0) {
        throw new Error(`desktop-installed-data-smoke: 附件成功后仍有临时文件：${staged.join(', ')}`)
      }
      return { objects, sessionLog }
    }
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  throw new Error('desktop-installed-data-smoke: 大附件未在 5 分钟内完整持久化')
}

async function waitForExportTempBytes(minimumBytes) {
  const deadline = Date.now() + 2 * 60_000
  while (Date.now() < deadline) {
    const temporary = collectFiles(exportRoot).find(path => path.endsWith('.tmp'))
    if (temporary !== undefined && statSync(temporary).size >= minimumBytes) return temporary
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 50) })
  }
  throw new Error('desktop-installed-data-smoke: 取消验收未观察到导出临时文件')
}

async function waitForExportCleanup() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (collectFiles(exportRoot).length === 0) return
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 50) })
  }
  throw new Error('desktop-installed-data-smoke: 取消导出后仍有目标或临时文件')
}

/** 读取 ZIP 中央目录，不加载或解压 1 GiB 正文。 */
function inspectZipEntries(path) {
  const size = statSync(path).size
  const tailBytes = Math.min(size, 65_557)
  const tail = Buffer.alloc(tailBytes)
  const handle = openSync(path, 'r')
  try {
    if (readSync(handle, tail, 0, tail.byteLength, size - tailBytes) !== tail.byteLength) {
      throw new Error('desktop-installed-data-smoke: ZIP 尾部读取不完整')
    }
    let endOffset = -1
    for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        endOffset = offset
        break
      }
    }
    if (endOffset < 0) throw new Error('desktop-installed-data-smoke: ZIP 缺少中央目录结束记录')
    const totalEntries = tail.readUInt16LE(endOffset + 10)
    const directoryBytes = tail.readUInt32LE(endOffset + 12)
    const directoryOffset = tail.readUInt32LE(endOffset + 16)
    if (totalEntries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error('desktop-installed-data-smoke: ZIP 意外使用 ZIP64 中央目录')
    }
    const directory = Buffer.alloc(directoryBytes)
    if (readSync(handle, directory, 0, directory.byteLength, directoryOffset) !== directory.byteLength) {
      throw new Error('desktop-installed-data-smoke: ZIP 中央目录读取不完整')
    }
    const entries = []
    let cursor = 0
    while (cursor < directory.byteLength) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('desktop-installed-data-smoke: ZIP 中央目录条目签名错误')
      }
      const compressedBytes = directory.readUInt32LE(cursor + 20)
      const uncompressedBytes = directory.readUInt32LE(cursor + 24)
      const nameBytes = directory.readUInt16LE(cursor + 28)
      const extraBytes = directory.readUInt16LE(cursor + 30)
      const commentBytes = directory.readUInt16LE(cursor + 32)
      const next = cursor + 46 + nameBytes + extraBytes + commentBytes
      if (next > directory.byteLength) throw new Error('desktop-installed-data-smoke: ZIP 中央目录条目越界')
      entries.push({
        name: directory.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8'),
        compressedBytes,
        uncompressedBytes,
      })
      cursor = next
    }
    if (entries.length !== totalEntries) {
      throw new Error(`desktop-installed-data-smoke: ZIP 条目计数错误 ${String(entries.length)}`)
    }
    return entries
  } finally {
    closeSync(handle)
  }
}

/** 流式计算归档摘要，避免驱动进程把大文件整体读入内存。 */
async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 在最终安装应用中验证取消、成功、原子清理和 Utility RSS 门槛。 */
async function runInstalledExportAcceptance(page, utilityPid) {
  const sessionId = 'desktop-installed-export-acceptance'
  const suggestedName = 'dsh-session-desktop-installed-export-acceptance.zip'
  const cancelOperationId = `installed-export-cancel-${randomUUID()}`
  await page.evaluate(({ operationId, sessionIdValue, suggestedNameValue }) => {
    const api = window.dshDesktop
    if (api === undefined) throw new Error('Desktop preload API 不可用')
    globalThis['__dshInstalledExportPending'] = api.invoke({
      type: 'session-log/save', operationId, sessionId: sessionIdValue, suggestedName: suggestedNameValue,
    })
  }, { operationId: cancelOperationId, sessionIdValue: sessionId, suggestedNameValue: suggestedName })
  await waitForExportTempBytes(Math.min(32 * 1024 * 1024, Math.floor(exportAcceptanceBytes / 4)))
  const cancelAccepted = await page.evaluate(async operationId => {
    const api = window.dshDesktop
    if (api === undefined) throw new Error('Desktop preload API 不可用')
    return api.invoke({ type: 'operation/cancel', operationId })
  }, cancelOperationId)
  const cancelled = await withTimeout(page.evaluate(async () => {
    const pending = globalThis['__dshInstalledExportPending']
    delete globalThis['__dshInstalledExportPending']
    return pending === undefined ? undefined : await pending
  }), 60_000, 'desktop-installed-data-smoke: 取消导出未在 60 秒内结算')
  if (cancelAccepted.type !== 'operation/cancel-result'
    || cancelAccepted.outcome !== 'accepted'
    || cancelled?.type !== 'session-log/result'
    || cancelled.outcome !== 'cancelled') {
    throw new Error(`desktop-installed-data-smoke: 取消导出结果错误 ${JSON.stringify({ cancelAccepted, cancelled })}`)
  }
  await waitForExportCleanup()

  const successOperationId = `installed-export-success-${randomUUID()}`
  const baselineUtilityRssBytes = utilityRssBytes(utilityPid, [utilityPid])
  let peakUtilityRssBytes = baselineUtilityRssBytes
  let samplingFailure
  const sampler = setInterval(() => {
    try {
      peakUtilityRssBytes = Math.max(peakUtilityRssBytes, utilityRssBytes(utilityPid, [utilityPid]))
    } catch (error) {
      samplingFailure = error
      clearInterval(sampler)
    }
  }, rssSampleIntervalMs)
  let saved
  try {
    saved = await withTimeout(page.evaluate(async ({ operationId, sessionIdValue, suggestedNameValue }) => {
      const api = window.dshDesktop
      if (api === undefined) throw new Error('Desktop preload API 不可用')
      return api.invoke({
        type: 'session-log/save', operationId, sessionId: sessionIdValue, suggestedName: suggestedNameValue,
      })
    }, { operationId: successOperationId, sessionIdValue: sessionId, suggestedNameValue: suggestedName }),
    20 * 60_000, 'desktop-installed-data-smoke: 成功导出未在 20 分钟内结算')
  } finally {
    clearInterval(sampler)
  }
  if (samplingFailure !== undefined) throw samplingFailure
  if (saved.type !== 'session-log/result' || saved.outcome !== 'saved') {
    throw new Error(`desktop-installed-data-smoke: 成功导出结果错误 ${JSON.stringify(saved)}`)
  }
  const targetBytes = statSync(exportTarget).size
  if (targetBytes < exportAcceptanceBytes) {
    throw new Error(`desktop-installed-data-smoke: 导出 ZIP 小于验收容量 ${String(targetBytes)}`)
  }
  const entries = inspectZipEntries(exportTarget)
  const expectedMediaEntries = Math.ceil(exportAcceptanceBytes / (5 * 1024 * 1024))
  const mediaEntries = entries.filter(entry => entry.name.startsWith('media/') && entry.name.endsWith('.gif'))
  if (entries[0]?.name !== 'session.jsonl'
    || entries.length !== expectedMediaEntries + 1
    || mediaEntries.length !== expectedMediaEntries
    || mediaEntries.some(entry => entry.uncompressedBytes !== 5 * 1024 * 1024)) {
    throw new Error(`desktop-installed-data-smoke: Session ZIP 条目错误 ${JSON.stringify(entries.slice(0, 4))}`)
  }
  const archiveSha256 = await digestFile(exportTarget)
  const unexpected = collectFiles(exportRoot).filter(path => path !== exportTarget)
  if (unexpected.length !== 0) {
    throw new Error(`desktop-installed-data-smoke: 成功导出留下临时文件 ${unexpected.join(', ')}`)
  }
  const peakUtilityRssDeltaBytes = peakUtilityRssBytes - baselineUtilityRssBytes
  if (fullExportAcceptance && peakUtilityRssDeltaBytes > exportRssDeltaLimitBytes) {
    throw new Error(
      `desktop-installed-data-smoke: 1 GiB 导出 Utility RSS 增量 ${String(peakUtilityRssDeltaBytes)} 超过 128 MiB`,
    )
  }
  return {
    totalBytes: targetBytes,
    archiveSha256,
    zipEntries: entries.length,
    mediaEntries: mediaEntries.length,
    baselineUtilityRssBytes,
    peakUtilityRssBytes,
    peakUtilityRssDeltaBytes,
  }
}

function resourceCounts(value) {
  if (value === undefined) return undefined
  return {
    bridges: value.bridges,
    inFlightRequests: value.inFlightRequests,
    requestReaders: value.requestReaders,
    responseReaders: value.responseReaders,
    exports: value.exports,
    directoryDialogs: value.directoryDialogs,
    nativePaths: value.nativePaths,
  }
}

function sameResourceCounts(left, right) {
  return JSON.stringify(resourceCounts(left)) === JSON.stringify(resourceCounts(right))
}

/** 等待 Utility 资源计数稳定，或回到指定基线。 */
async function waitForStableResourceCounts(expected) {
  const deadline = Date.now() + 60_000
  let previous
  let stableSamples = 0
  while (Date.now() < deadline) {
    const current = readEvents(enduranceMetricsPath).at(-1)
    const quiescent = current !== undefined
      && current.exports === 0
      && current.directoryDialogs === 0
      && current.nativePaths === 0
    const matches = expected === undefined || sameResourceCounts(current, expected)
    if (quiescent && matches && sameResourceCounts(current, previous)) stableSamples += 1
    else stableSamples = 0
    if (stableSamples >= 4) return resourceCounts(current)
    previous = current
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 250) })
  }
  const current = readEvents(enduranceMetricsPath).at(-1)
  throw new Error(
    `desktop-installed-data-smoke: Utility 资源计数未回到基线 ${JSON.stringify({ expected, current })}`,
  )
}

async function waitForEventCount(path, event, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readEvents(path).filter(value => value.event === event).length >= expected) return
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  throw new Error(`desktop-installed-data-smoke: ${event} 未在限时内达到 ${String(expected)} 次`)
}

/** 等待并校验 Renderer 经真实 Electron 数据端口提交的 1 KiB unary p95。 */
async function waitForInstalledUnaryLatency() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (existsSync(unaryLatencyMetricsPath)) {
      const text = readFileSync(unaryLatencyMetricsPath, 'utf8').trim()
      if (text !== '') {
        const result = JSON.parse(text)
        if (result.outcome !== 'passed'
          || result.requestBytes !== 1024
          || result.responseBytes !== 1024
          || result.sampleRequests !== 100
          || typeof result.extraRoundTripP95Ms !== 'number'
          || result.extraRoundTripP95Ms > 10) {
          throw new Error(`desktop-installed-data-smoke: 安装态 unary 延迟门禁失败 ${JSON.stringify(result)}`)
        }
        return result
      }
    }
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  throw new Error('desktop-installed-data-smoke: 安装态 unary 延迟指标未在 60 秒内生成')
}

function observePage(page) {
  page.on('pageerror', error => {
    console.error(`desktop-installed-data-smoke: Renderer 页面异常：${String(error)}`)
  })
  page.on('console', message => {
    if (message.type() === 'error') console.error(`desktop-installed-data-smoke: Renderer 控制台：${message.text()}`)
  })
}

/** 终止当前受监督 Renderer，以真实恢复路径轮换 BrowserWindow 与 MessagePort。 */
async function rotateRenderer(context) {
  const mainLog = join(dshHome, 'logs', 'desktop', 'main.jsonl')
  const readyCount = readEvents(mainLog).filter(value => value.event === 'EVENT_RENDERER-READY').length
  const rows = descendantRows(application.pid)
  for (const row of rows) observedPids.add(row.pid)
  const renderer = rows.find(row => /(?:^|\s)--type=renderer(?:\s|$)/.test(row.command))
  if (renderer === undefined) throw new Error('desktop-installed-data-smoke: 耐久验收未找到 Renderer 进程')
  const nextPagePromise = context.waitForEvent('page')
  process.kill(renderer.pid, 'SIGKILL')
  await waitForEventCount(mainLog, 'EVENT_RENDERER-READY', readyCount + 1, 60_000)
  const nextPage = await withTimeout(nextPagePromise, 60_000, 'desktop-installed-data-smoke: Renderer 恢复未创建新页面')
  observePage(nextPage)
  const composer = await prepareSession(nextPage)
  return { page: nextPage, composer }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

/** 等待取消轮次抵达 provider 并保持流打开，避免只取消尚未发出的本地任务。 */
async function waitForProviderActiveRequest(provider, previousRequests) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = provider.snapshot()
    if (snapshot.mainRequests > previousRequests && snapshot.activeResponses > 0) return
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 25) })
  }
  throw new Error('desktop-installed-data-smoke: 取消轮次未在 30 秒内抵达 provider')
}

/** 在最终安装应用中持续流式请求、取消并轮换 Renderer 数据端口。 */
async function runInstalledEnduranceAcceptance(context, initialPage, utilityPid, provider) {
  let page = initialPage
  let composer = page.locator('textarea').first()
  const baselineResources = await waitForStableResourceCounts()
  const deadline = Date.now() + enduranceAcceptanceDurationMs
  const sampleIntervalMs = Math.max(1_000, Math.min(60_000, Math.floor(enduranceAcceptanceDurationMs / 10)))
  const rssSamples = [processTreeRss(utilityPid).totalBytes]
  let nextSampleAt = Date.now() + sampleIntervalMs
  let completedRequests = 0
  let cancelledRequests = 0
  let portGenerations = 1
  let requests = 0
  while (Date.now() < deadline) {
    requests += 1
    const cancellationTurn = requests % enduranceCancellationInterval === 0
    const prompt = `desktop-endurance-${cancellationTurn ? 'cancel' : 'complete'}-${String(requests)}-${randomUUID()}`
    await composer.fill(prompt)
    const previousProviderRequests = provider.snapshot().mainRequests
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const stop = page.getByRole('button', { name: '停止生成', exact: true })
    await stop.waitFor({ state: 'visible', timeout: 30_000 })
    if (cancellationTurn) {
      await waitForProviderActiveRequest(provider, previousProviderRequests)
      await stop.click()
      cancelledRequests += 1
    } else {
      completedRequests += 1
    }
    await page.waitForFunction(() => {
      const textarea = document.querySelector('textarea')
      const streaming = document.querySelector('[data-streaming="true"]')
      return textarea instanceof HTMLTextAreaElement
        && !textarea.disabled
        && !textarea.readOnly
        && streaming === null
    }, undefined, { timeout: 60_000 })
    if (Date.now() >= nextSampleAt) {
      rssSamples.push(processTreeRss(utilityPid).totalBytes)
      nextSampleAt = Date.now() + sampleIntervalMs
    }
    if (requests % endurancePortCycleRequests === 0 && Date.now() < deadline) {
      const rotated = await rotateRenderer(context)
      page = rotated.page
      activePage = page
      composer = rotated.composer
      portGenerations += 1
      await waitForStableResourceCounts(baselineResources)
    }
  }
  rssSamples.push(processTreeRss(utilityPid).totalBytes)
  const finalResources = await waitForStableResourceCounts(baselineResources)
  const providerSnapshot = provider.snapshot()
  if (completedRequests === 0 || cancelledRequests === 0 || portGenerations < 2
    || providerSnapshot.completedRequests === 0
    || providerSnapshot.cancelledRequests === 0
    || providerSnapshot.activeResponses !== 0) {
    throw new Error(
      `desktop-installed-data-smoke: 耐久验收未覆盖完成、取消和端口轮换 ${JSON.stringify(providerSnapshot)}`,
    )
  }
  const baselineRssBytes = rssSamples[0]
  const peakRssGrowthBytes = Math.max(0, ...rssSamples.map(value => value - baselineRssBytes))
  const windowSize = Math.max(1, Math.min(5, Math.floor(rssSamples.length / 2)))
  const head = median(rssSamples.slice(0, windowSize))
  const tail = median(rssSamples.slice(-windowSize))
  const tailRssGrowthBytes = Math.max(0, tail - head)
  if (fullEnduranceAcceptance && (peakRssGrowthBytes > enduranceRssGrowthLimitBytes
    || tailRssGrowthBytes > enduranceRssGrowthLimitBytes / 2)) {
    throw new Error(
      `desktop-installed-data-smoke: 60 分钟耐久 RSS 增长超限 peak=${String(peakRssGrowthBytes)} tail=${String(tailRssGrowthBytes)}`,
    )
  }
  return {
    durationMs: enduranceAcceptanceDurationMs,
    completedRequests,
    cancelledRequests,
    portGenerations,
    baselineResources,
    finalResources,
    provider: providerSnapshot,
    rssSamples,
    peakRssGrowthBytes,
    tailRssGrowthBytes,
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await Promise.race([
    new Promise(resolvePromise => { child.once('exit', () => { resolvePromise(true) }) }),
    new Promise(resolvePromise => { setTimeout(() => { resolvePromise(false) }, timeoutMs) }),
  ])
}

function requestGracefulShutdown() {
  if (process.platform !== 'win32') {
    if (!application.kill('SIGTERM')) throw new Error('desktop-installed-data-smoke: 应用无法接收 SIGTERM')
    return
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$target = Get-Process -Id ${String(application.pid)} -ErrorAction Stop; if (-not $target.CloseMainWindow()) { exit 3 }`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('desktop-installed-data-smoke: 应用无法接收窗口关闭请求')
}

function aliveProcessIds(pids) {
  if (pids.length === 0) return []
  if (process.platform === 'win32') {
    const alive = new Set(
      powershellJson('Get-Process -ErrorAction Stop | Select-Object Id | ConvertTo-Json -Compress')
        .map(value => Number(value.Id)),
    )
    return pids.filter(pid => alive.has(pid))
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
}

async function waitForProcessTreeExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (aliveProcessIds([...observedPids]).length === 0) return
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 100) })
  }
  const alive = aliveProcessIds([...observedPids])
  throw new Error(`desktop-installed-data-smoke: 退出后仍有进程存活：${alive.join(', ')}`)
}

async function prepareSession(page) {
  const workspaceTree = page.getByRole('treeitem', { name: 'Acceptance Workspace' })
  await workspaceTree.waitFor({ state: 'visible', timeout: 60_000 })
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  // 工作区 baseline 可能先于首次使用遮罩完成渲染，给引导按钮一个独立的有界窗口。
  if (await continueButton.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
    await continueButton.click()
  }
  const skipButton = page.getByRole('button', { name: '稍后配置', exact: true })
  if (await skipButton.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
    await skipButton.click()
  }
  await workspaceTree.hover()
  await page.locator('button[aria-label="在“Acceptance Workspace”中新建会话"]').click()
  const composer = page.locator('textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => {
    const textarea = document.querySelector('textarea')
    return textarea instanceof HTMLTextAreaElement && !textarea.disabled && !textarea.readOnly
  }, undefined, { timeout: 60_000 })
  const modelTrigger = page.getByRole('button', { name: /选择模型/u })
  await modelTrigger.click()
  await page.getByRole('menuitem', { name: /模型/u }).click()
  await page.getByRole('menuitemradio', { name: 'Acceptance Vision' }).click()
  await page.waitForFunction(() => {
    const trigger = document.querySelector('button[aria-label^="选择模型"]')
    return trigger?.getAttribute('aria-label')?.includes('Acceptance Vision') ?? false
  }, undefined, { timeout: 30_000 })
  return composer
}

async function attachImages(page, paths) {
  // 原生拖放协议只把磁盘路径交给 Chromium，避免页面内 DataTransfer 把文件正文复制进 JS 堆。
  const session = await page.context().newCDPSession(page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  try {
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 100, y: 100, data })
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: 100, y: 100, data })
    await session.send('Input.dispatchDragEvent', { type: 'drop', x: 100, y: 100, data })
  } finally {
    await session.detach()
  }
  await page.locator('button[aria-label^="移除图片 "]').nth(imageSizes.length - 1)
    .waitFor({ state: 'visible', timeout: 60_000 })
}

/** 在清理一次性 Home 前输出有界日志尾部，使安装态失败可以直接定位。 */
async function printFailureDiagnostics() {
  const sections = [['application', output.join('')]]
  for (const [name, path] of [
    ['main', join(dshHome, 'logs', 'desktop', 'main.jsonl')],
    ['utility', join(dshHome, 'logs', 'desktop', 'utility.jsonl')],
  ]) {
    if (existsSync(path)) sections.push([name, readFileSync(path, 'utf8')])
  }
  for (const [name, content] of sections) {
    const tail = content.trim().split('\n').slice(-80).join('\n')
    if (tail !== '') console.error(`desktop-installed-data-smoke: ${name} 日志尾部\n${tail}`)
  }
  if (enduranceProvider !== undefined) {
    console.error(`desktop-installed-data-smoke: provider 状态\n${JSON.stringify(enduranceProvider.snapshot())}`)
  }
  const pageText = await activePage?.locator('body').innerText({ timeout: 2_000 }).catch(() => undefined)
  if (pageText !== undefined) {
    console.error(`desktop-installed-data-smoke: Renderer 文本尾部\n${pageText.slice(-8_000)}`)
  }
}

try {
  if (installedEnduranceAcceptance && diagnosticBytes > 5 * 1024 * 1024) {
    throw new Error('desktop-installed-data-smoke: 耐久验收的启动附件不得超过 5 MiB')
  }
  enduranceProvider = installedEnduranceAcceptance ? await startEnduranceProvider() : undefined
  seedWorkspace(enduranceProvider?.baseUrl)
  const attachmentPaths = seedAttachmentFiles()
  const devtools = deferred()
  reportPhase('launch')
  const applicationEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    ...(installedExportAcceptance
      ? { DSH_DESKTOP_INSTALLED_EXPORT_BYTES: String(exportAcceptanceBytes) }
      : {}),
    ...(installedEnduranceAcceptance
      ? {
          DSH_DESKTOP_INSTALLED_ENDURANCE_API_KEY: 'desktop-installed-endurance-acceptance',
          DSH_DESKTOP_INSTALLED_ENDURANCE_METRICS: enduranceMetricsPath,
        }
      : {}),
    ...(installedUnaryLatencyAcceptance
      ? { DSH_DESKTOP_INSTALLED_UNARY_LATENCY_METRICS: unaryLatencyMetricsPath }
      : {}),
  }
  if (installedEnduranceAcceptance) {
    applicationEnv.HTTP_PROXY = ''
    applicationEnv.HTTPS_PROXY = ''
    applicationEnv.ALL_PROXY = ''
    applicationEnv.NO_PROXY = '127.0.0.1,localhost'
    applicationEnv.http_proxy = ''
    applicationEnv.https_proxy = ''
    applicationEnv.all_proxy = ''
    applicationEnv.no_proxy = '127.0.0.1,localhost'
  } else {
    applicationEnv.http_proxy = applicationEnv.HTTP_PROXY
    applicationEnv.https_proxy = applicationEnv.HTTPS_PROXY
    applicationEnv.all_proxy = applicationEnv.ALL_PROXY
    applicationEnv.no_proxy = applicationEnv.NO_PROXY
  }
  delete applicationEnv.DEEPSEEK_API_KEY
  delete applicationEnv.DEEPSEEK_BASE_URL
  application = spawn(executable, [
    '--remote-debugging-port=0',
    ...(installedExportAcceptance ? ['--dsh-desktop-installed-export-acceptance'] : []),
    ...(installedUnaryLatencyAcceptance ? ['--dsh-desktop-installed-unary-latency-acceptance'] : []),
  ], {
    cwd: product,
    env: applicationEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const receiveOutput = (chunk) => {
    const text = chunk.toString()
    output.push(text)
    const match = /DevTools listening on (ws:\/\/\S+)/u.exec(text)
    if (match?.[1] !== undefined) devtools.resolve(match[1])
  }
  application.stdout?.on('data', receiveOutput)
  application.stderr?.on('data', receiveOutput)
  application.once('exit', (code, signal) => {
    devtools.reject(new Error(`desktop-installed-data-smoke: 应用提前退出 ${String(code ?? signal)}\n${output.join('')}`))
  })

  const endpoint = await withTimeout(devtools.promise, 60_000, 'desktop-installed-data-smoke: DevTools endpoint 启动超时')
  browser = await chromium.connectOverCDP(endpoint)
  const context = browser.contexts()[0]
  if (context === undefined) throw new Error('desktop-installed-data-smoke: CDP 未返回默认 BrowserContext')
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  activePage = page
  observePage(page)
  const composer = await prepareSession(page)
  const installedUnaryLatency = installedUnaryLatencyAcceptance
    ? await waitForInstalledUnaryLatency()
    : undefined
  const utilityPid = await waitForUtilityPid()
  const baseline = processTreeRss(utilityPid)
  const measuredPids = baseline.entries.map(entry => entry.pid)
  const checkpoints = { baseline: await memoryCheckpoint(page, utilityPid) }
  reportPhase('attachment-persistence')
  let peak = baseline.totalBytes
  let peakEntries = baseline.entries
  let currentPhase = 'draft-attachment'
  let peakPhase = currentPhase
  let samplingFailure
  const sampler = setInterval(() => {
    try {
      const sample = processRss(measuredPids)
      if (sample.totalBytes > peak) {
        peak = sample.totalBytes
        peakEntries = sample.entries
        peakPhase = currentPhase
      }
    } catch (error) {
      samplingFailure = error
      clearInterval(sampler)
    }
  }, rssSampleIntervalMs)
  let persistence
  try {
    await attachImages(page, attachmentPaths)
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 500) })
    checkpoints.afterAttachment = await memoryCheckpoint(page, utilityPid)
    await composer.fill(marker)
    // Enter 行为属于用户设置；验收点击语义明确的主操作，避免把偏好差异当作传输失败。
    currentPhase = 'upload-and-persistence'
    await page.getByRole('button', { name: '发送消息' }).click()
    persistence = await waitForPersistence(page, imageSizes.length, diagnosticBytes)
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 500) })
    checkpoints.afterPersistence = await memoryCheckpoint(page, utilityPid)
    currentPhase = 'settled'
  } finally {
    clearInterval(sampler)
  }
  if (samplingFailure !== undefined) throw samplingFailure
  reportPhase('attachment-persistence-complete')
  const peakRssDeltaBytes = peak - baseline.totalBytes
  if (fullAcceptance && peakRssDeltaBytes > peakRssDeltaLimitBytes) {
    throw new Error([
      `desktop-installed-data-smoke: 100 MiB 附件 RSS 峰值增量 ${String(peakRssDeltaBytes)} 超过 300 MiB`,
      `baseline=${JSON.stringify(baseline.entries)}`,
      `peak=${JSON.stringify(peakEntries)}`,
      `peakPhase=${peakPhase}`,
      `checkpoints=${JSON.stringify(checkpoints)}`,
    ].join('\n'))
  }

  let installedExport
  if (installedExportAcceptance) {
    reportPhase('export')
    installedExport = await runInstalledExportAcceptance(page, utilityPid)
  }
  let installedEndurance
  if (installedEnduranceAcceptance) {
    reportPhase('endurance')
    installedEndurance = await runInstalledEnduranceAcceptance(context, page, utilityPid, enduranceProvider)
  }

  reportPhase('shutdown')
  requestGracefulShutdown()
  if (!await waitForExit(application, 20_000)) {
    throw new Error('desktop-installed-data-smoke: 应用未在 20 秒内退出')
  }
  await waitForProcessTreeExit(15_000)
  console.log(JSON.stringify({
    outcome: 'passed',
    fullAcceptance,
    attachmentBytes: diagnosticBytes,
    attachmentCount: imageSizes.length,
    persistedObjects: persistence.objects.length,
    sessionLog: basename(persistence.sessionLog),
    baselineRssBytes: baseline.totalBytes,
    baselineProcesses: baseline.entries,
    peakRssBytes: peak,
    peakRssDeltaBytes,
    peakProcesses: peakEntries,
    peakPhase,
    checkpoints,
    ...(installedExport === undefined ? {} : { installedExport }),
    ...(installedEndurance === undefined ? {} : { installedEndurance }),
    ...(installedUnaryLatency === undefined ? {} : { installedUnaryLatency }),
  }, null, 2))
} catch (error) {
  await printFailureDiagnostics()
  throw error
} finally {
  if (application !== undefined && !await waitForExit(application, 1_000)) {
    application.kill('SIGTERM')
    if (!await waitForExit(application, 5_000)) application.kill('SIGKILL')
  }
  await browser?.close().catch(() => undefined)
  await enduranceProvider?.close().catch(() => undefined)
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
