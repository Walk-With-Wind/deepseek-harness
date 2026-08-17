/**
 * 在源码树和已构建树上使用同一条 Knip 门禁。
 *
 * Typert 的生成入口只存在于构建产物中。Knip 在干净树上需要忽略这些
 * 入口的运行时依赖，在已构建树上则会把相同忽略项判定为冗余配置。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveKnipConfigForArtifacts, type KnipConfig } from './knip-config.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * 运行 Knip，并在退出前移除本次运行生成的临时配置。
 *
 * @param args 透传给 Knip CLI 的附加参数。
 * @returns Knip 进程退出码；信号中止时返回 `1`。
 */
function runKnip(args: readonly string[]): number {
  const sourceConfigPath = resolve(root, 'knip.json')
  const runtimeConfigPath = resolve(root, `.knip.runtime-${process.pid}.json`)
  const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, 'utf8')) as KnipConfig
  const hasBuildOutputs = globSync(['apps/*/lib/**/*', 'packages/*/*/lib/**/*'], { cwd: root }).length > 0
  const runtimeConfig = resolveKnipConfigForArtifacts(sourceConfig, {
    hasBuildOutputs,
    artifactExists: path => existsSync(resolve(root, path)),
  })
  const knipEntry = fileURLToPath(import.meta.resolve('knip'))
  const knipBin = resolve(dirname(knipEntry), '..', 'bin', 'knip.js')
  let runtimeConfigWritten = false

  try {
    writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, undefined, 2)}\n`, { flag: 'wx' })
    runtimeConfigWritten = true
    const result = spawnSync(
      process.execPath,
      [knipBin, '--config', runtimeConfigPath, '--treat-config-hints-as-errors', ...args],
      { cwd: root, stdio: 'inherit' },
    )
    if (result.error) throw result.error
    return result.status ?? 1
  } finally {
    if (runtimeConfigWritten) rmSync(runtimeConfigPath, { force: true })
  }
}

process.exitCode = runKnip(process.argv.slice(2))
