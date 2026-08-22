/** Community Desktop 完整矩阵发布材料的本地生成入口。 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildDesktopCommunityPublishPlan,
  writeDesktopCommunityPublishPlan,
  type DesktopCommunityChannel,
  type DesktopCommunityReleaseManifest,
} from './lib/desktop-community-publish.ts'

const usage = `用法：pnpm run desktop:community-publish -- \\
  --input <候选根目录> --output <空输出目录> --channel <canary|stable> \\
  --expected-version <checkout 版本> --expected-source-commit <冻结 commit> \\
  [--canary-manifest <已发布 canary 清单>] \\
  [--stable-acceptance <仓库内 stable 验收记录>] \\
  [--existing-release-manifest <同版本既有 Release 清单>]

输入目录必须同时包含 darwin-arm64、darwin-x64 和 win32-x64。该命令只校验并生成
GitHub Release/Pages 上传目录，不访问网络，也不修改远端状态。stable 必须提供同版本线的
--canary-manifest 与 --stable-acceptance。
`

const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const parsed = parseArgs({
  args: arguments_,
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    channel: { type: 'string' },
    'expected-version': { type: 'string' },
    'expected-source-commit': { type: 'string' },
    'canary-manifest': { type: 'string' },
    'stable-acceptance': { type: 'string' },
    'existing-release-manifest': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
})

if (parsed.values.help === true) {
  process.stdout.write(usage)
  process.exit(0)
}
const input = requiredOption(parsed.values.input, '--input')
const output = requiredOption(parsed.values.output, '--output')
const channel = parseChannel(parsed.values.channel)
const expectedVersion = requiredOption(parsed.values['expected-version'], '--expected-version')
const expectedSourceCommit = requiredOption(
  parsed.values['expected-source-commit'], '--expected-source-commit',
)
const publishedCanary = await readOptionalManifest(parsed.values['canary-manifest'])
const existingRelease = await readOptionalManifest(parsed.values['existing-release-manifest'])
const plan = await buildDesktopCommunityPublishPlan({
  inputRoot: resolve(input),
  channel,
  expectedVersion,
  expectedSourceCommit,
  ...(parsed.values['stable-acceptance'] === undefined
    ? {}
    : { stableAcceptancePath: resolve(parsed.values['stable-acceptance']) }),
  ...(publishedCanary === undefined ? {} : { publishedCanary }),
  ...(existingRelease === undefined ? {} : { existingRelease }),
})
await writeDesktopCommunityPublishPlan(plan, resolve(output))
process.stdout.write(
  `已生成 ${plan.release.version} ${plan.release.channel}：${String(plan.release.assets.length)} 个 Release 资产。\n`,
)

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`desktop-community-publish: 缺少 ${name}\n${usage}`)
  }
  return value
}

function parseChannel(value: string | undefined): DesktopCommunityChannel {
  if (value !== 'canary' && value !== 'stable') {
    throw new Error(`desktop-community-publish: --channel 必须是 canary 或 stable\n${usage}`)
  }
  return value
}

async function readOptionalManifest(
  path: string | undefined,
): Promise<DesktopCommunityReleaseManifest | undefined> {
  if (path === undefined) return undefined
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as DesktopCommunityReleaseManifest
  } catch {
    throw new Error(`desktop-community-publish: 无法读取发布清单 ${path}`)
  }
}
