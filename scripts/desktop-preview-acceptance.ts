/** 将无签名原生构建与安装器循环结果写成可移植 Preview 验收记录。 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createDesktopPreviewAcceptance,
  type DesktopCommunityTarget,
} from './lib/desktop-community-publish.ts'
import { verifyDesktopPreviewSignature } from './lib/desktop-preview-signature.ts'

const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const { values } = parseArgs({
  args: arguments_,
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'source-commit': { type: 'string' },
    'artifact-root': { type: 'string' },
  },
  strict: true,
})
const artifactRoot = required(values['artifact-root'], '--artifact-root')
const target = required(values.target, '--target') as DesktopCommunityTarget
const signature = await verifyDesktopPreviewSignature({ target, artifactRoot })
const record = createDesktopPreviewAcceptance({
  target,
  version: required(values.version, '--version'),
  sourceCommit: required(values['source-commit'], '--source-commit'),
  signature,
})
await writeFile(
  resolve(artifactRoot, 'preview-acceptance.json'),
  `${JSON.stringify(record, null, 2)}\n`,
)

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`desktop-preview-acceptance: 缺少 ${name}`)
  }
  return value
}
