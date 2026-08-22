/** Community Desktop 无签名 Preview 工作流的隔离与不可变发布约束。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const root = resolve(import.meta.dirname, '..')
const workflowPath = resolve(root, '.github/workflows/desktop-community-preview.yml')

describe('Community Desktop unsigned preview workflow', () => {
  it('只允许受保护的人工发布，并拒绝 Pages 和更新通道权限', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('workflow_dispatch:')
    expect(source).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m)
    expect(source).toContain('environment: desktop-community-release')
    expect(source).toContain('contents: write')
    expect(source).not.toContain('pages: write')
    expect(source).not.toContain('id-token: write')
    expect(source).not.toContain('actions/deploy-pages')
    expect(source).not.toContain('desktop-pages')
  })

  it('只接受当前 master 上完成的三目标无签名矩阵', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('inputs.build_run_id')
    expect(source).toContain('.github/workflows/desktop.yml')
    expect(source).toContain('preview-matrix-complete')
    expect(source).toContain('head_branch')
    expect(source).toContain('git/ref/heads/master')
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      expect(source).toContain(`deepseek-harness-community-${target}-unsigned`)
    }
    expect(source).toContain('pnpm run desktop:community-preview')
    expect(source).toContain('--expected-version="$VERSION"')
    expect(source).toContain('--expected-source-commit="$SOURCE_COMMIT"')
  })

  it('在创建与复用 Release 时递归剥离 tag 并绑定冻结源码', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('git/ref/tags/$TAG')
    expect(source).toContain('git/tags/$tag_sha')
    expect(source).toContain('test "$tag_sha" = "$SOURCE_COMMIT"')
  })

  it('只向需要 GitHub API 的步骤注入写令牌', () => {
    const source = readFileSync(workflowPath, 'utf8')
    const parsed = load(source) as {
      env?: Record<string, string>
      jobs: { publish: { steps: Array<{ name?: string; env?: Record<string, string> }> } }
    }
    expect(parsed.env).not.toHaveProperty('GH_TOKEN')
    const install = parsed.jobs.publish.steps.find(step => step.name === 'Install dependencies')
    expect(install?.env).toBeUndefined()
    const validate = parsed.jobs.publish.steps.find(step => step.name?.startsWith('Validate complete'))
    expect(validate?.env).not.toHaveProperty('GH_TOKEN')
    for (const name of [
      'Resolve successful frozen-source build',
      'Resolve version and immutable Preview state',
      'Require repository immutable releases',
      'Create draft Preview with the complete asset set',
      'Verify downloaded draft Release bytes',
      'Publish and verify immutable Preview',
    ]) {
      const step = parsed.jobs.publish.steps.find(candidate => candidate.name === name)
      expect(step?.env).toHaveProperty('GH_TOKEN')
    }
  })

  it('先建立草稿并核对全部字节，再发布不可变 prerelease', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('DSH_RELEASE_ADMIN_TOKEN')
    expect(source).toContain('immutable-releases')
    expect(source).toContain('X-GitHub-Api-Version: 2026-03-10')
    expect(source).toContain('--draft')
    expect(source).toContain('--prerelease')
    expect(source).toContain('--target "$SOURCE_COMMIT"')
    expect(source).toContain('UNSIGNED PREVIEW')
    expect(source).toContain('Verify downloaded draft Release bytes')
    expect(source).toContain('gh release edit "$TAG" --draft=false')
    expect(source).toContain('isImmutable')
    expect(source).toContain('gh release verify "$TAG"')
    expect(source).toContain('gh release verify-asset "$TAG" "$asset"')
    expect(source).not.toContain('--clobber')
    expect(source).not.toContain('desktop-community-release-manifest.json')
    expect(source).toContain('desktop-community-preview-manifest.json')
  })

  it('锁定全部第三方 action 版本', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).not.toMatch(/uses:\s+(?:actions|pnpm\/action-setup)\/[^@\s]+@v\d/)
  })
})
