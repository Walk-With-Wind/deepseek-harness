/** 将受保护构建与耐久 job 的成功结果写成可移植验收记录。 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createDesktopReleaseAcceptance,
  type DesktopCommunityTarget,
} from './lib/desktop-community-publish.ts'

const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const { values } = parseArgs({
  args: arguments_,
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'source-commit': { type: 'string' },
    'artifact-root': { type: 'string' },
    'endurance-minutes': { type: 'string', default: '60' },
    'installed-export-bytes': { type: 'string', default: String(1024 ** 3) },
  },
  strict: true,
})
const artifactRoot = required(values['artifact-root'], '--artifact-root')
const record = createDesktopReleaseAcceptance({
  target: required(values.target, '--target') as DesktopCommunityTarget,
  version: required(values.version, '--version'),
  sourceCommit: required(values['source-commit'], '--source-commit'),
  enduranceMinutes: Number(values['endurance-minutes']),
  installedExportBytes: Number(values['installed-export-bytes']),
})
await writeFile(
  resolve(artifactRoot, 'release-acceptance.json'),
  `${JSON.stringify(record, null, 2)}\n`,
)

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`desktop-release-acceptance: 缺少 ${name}`)
  }
  return value
}
