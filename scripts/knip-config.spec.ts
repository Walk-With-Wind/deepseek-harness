/** Knip 必须只分析源码平面，构建产物由其他 artifact 门禁负责。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveKnipConfigForArtifacts } from './knip-config.ts'

describe('Knip source-plane configuration', () => {
  it('源码配置不永久忽略尚不存在的 lib 目录', () => {
    const config = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'knip.json'), 'utf8')) as {
      ignore?: string[]
    }

    expect(config.ignore ?? []).not.toContain('**/lib/**')
  })

  it('仅在构建产物存在时忽略 lib 并撤销对应的 zod 源码豁免', () => {
    const config = {
      ignore: ['retained-pattern'],
      workspaces: {
        'packages/extensions/cordis-host-runner': {
          ignoreDependencies: ['zod', 'retained-dependency'],
        },
        'packages/interaction/commands': {
          ignoreDependencies: ['zod'],
        },
      },
    }

    const resolved = resolveKnipConfigForArtifacts(config, {
      hasBuildOutputs: true,
      artifactExists: path => path.includes('cordis-host-runner'),
    })

    expect(resolved.ignore).toEqual(['retained-pattern', '**/lib/**'])
    expect(resolved.workspaces?.['packages/extensions/cordis-host-runner']?.ignoreDependencies).toEqual([
      'retained-dependency',
    ])
    expect(resolved.workspaces?.['packages/interaction/commands']?.ignoreDependencies).toEqual(['zod'])
    expect(config.workspaces['packages/extensions/cordis-host-runner'].ignoreDependencies).toEqual([
      'zod',
      'retained-dependency',
    ])
  })

  it('干净树保留生成依赖豁免且不加入 lib 排除', () => {
    const config = {
      workspaces: {
        'packages/interaction/commands': {
          ignoreDependencies: ['zod'],
        },
      },
    }

    const resolved = resolveKnipConfigForArtifacts(config, {
      hasBuildOutputs: false,
      artifactExists: () => false,
    })

    expect(resolved.ignore).toBeUndefined()
    expect(resolved.workspaces?.['packages/interaction/commands']?.ignoreDependencies).toEqual(['zod'])
  })
})
