/** Community Desktop 三目标无签名 Preview 的本地生成入口。 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildDesktopCommunityPreviewPlan,
  writeDesktopCommunityPreviewPlan,
} from './lib/desktop-community-publish.ts'

const usage = `用法：pnpm run desktop:community-preview -- \\
  --input <候选根目录> --output <空输出目录> \\
  --expected-version <checkout 版本> --expected-source-commit <冻结 commit>

输入目录必须同时包含 darwin-arm64、darwin-x64 和 win32-x64。该命令只校验并生成
无签名 Preview Release 上传目录，不生成 Pages 或自动更新元数据，不访问网络。
`

const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const parsed = parseArgs({
  args: arguments_,
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    'expected-version': { type: 'string' },
    'expected-source-commit': { type: 'string' },
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
const expectedVersion = requiredOption(parsed.values['expected-version'], '--expected-version')
const expectedSourceCommit = requiredOption(
  parsed.values['expected-source-commit'], '--expected-source-commit',
)
const plan = await buildDesktopCommunityPreviewPlan({
  inputRoot: resolve(input),
  expectedVersion,
  expectedSourceCommit,
})
await writeDesktopCommunityPreviewPlan(plan, resolve(output))
process.stdout.write(
  `已生成 ${plan.release.version} unsigned preview：${String(plan.release.assets.length)} 个 Release 资产。\n`,
)

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`desktop-community-preview: 缺少 ${name}\n${usage}`)
  }
  return value
}
