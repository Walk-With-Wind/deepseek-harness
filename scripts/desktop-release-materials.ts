/** Desktop maker 产物的发行材料生成/验证入口。 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  generateDesktopReleaseMaterials,
  verifyDesktopReleaseMaterials,
} from './lib/desktop-release-materials.ts'

const root = resolve(import.meta.dirname, '..')
const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
const command = positionals[0]
if ((command !== 'generate' && command !== 'verify') || positionals.length !== 1) {
  throw new Error('desktop-release-materials: 用法 tsx scripts/desktop-release-materials.ts <generate|verify>')
}
const options = {
  root,
  staging: resolve(root, '.artifacts/desktop/staging'),
  artifactRoot: resolve(root, '.artifacts/desktop/out/make'),
  outputRoot: resolve(root, '.artifacts/desktop/out/make'),
}
if (command === 'generate') await generateDesktopReleaseMaterials(options)
else await verifyDesktopReleaseMaterials(options)
