/** Community Desktop 受保护发布工作流的权限和晋级约束。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflowPath = resolve(root, '.github/workflows/desktop-community-publish.yml')

describe('Community Desktop publication workflow', () => {
  it('只允许受保护的人工发布，并使用最小写权限', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('workflow_dispatch:')
    expect(source).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m)
    expect(source).toContain('environment: desktop-community-release')
    expect(source).toContain('contents: write')
    expect(source).toContain('pages: write')
    expect(source).toContain('id-token: write')
  })

  it('从指定成功构建下载完整三目标候选并调用唯一发布验证器', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('inputs.build_run_id')
    expect(source).toContain('.github/workflows/desktop.yml')
    expect(source).toContain('release-matrix-complete')
    expect(source).toContain('head_branch')
    expect(source).toContain('git/ref/heads/master')
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      expect(source).toContain(`deepseek-harness-community-${target}-candidate`)
    }
    expect(source).toContain('pnpm run desktop:community-publish')
    expect(source).toContain('--expected-version="$VERSION"')
    expect(source).toContain('--expected-source-commit="$SOURCE_COMMIT"')
    expect(source).toContain('desktop-community-release-manifest.json')
  })

  it('保持 Release 字节不可变并在 stable 前要求 canary 与人工记录', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).not.toContain('--clobber')
    expect(source).toContain("inputs.channel == 'stable'")
    expect(source).toContain('inputs.canary_version')
    expect(source).toContain('inputs.acceptance_record')
    expect(source).toContain('--canary-manifest')
    expect(source).toContain('--stable-acceptance')
    expect(source).toContain('--existing-release-manifest')
    expect(source).toContain('git merge-base --is-ancestor')
    expect(source).toContain('immutable-releases')
    expect(source).toContain('X-GitHub-Api-Version: 2026-03-10')
    expect(source).toContain('--draft')
    expect(source).toContain('--target "$SOURCE_COMMIT"')
    expect(source).toContain('Verify downloaded immutable Release bytes')
    expect(source).toContain('gh release edit "$TAG" --draft=false')
    expect(source).toContain('isImmutable')
    expect(source).toContain('gh release verify "$TAG"')
    expect(source).toContain('gh release verify-asset "$TAG" "$asset"')
    expect(source).not.toContain('promote-stable')
  })

  it('将 Pages 状态持久化到专用分支，并锁定第三方 action 版本', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(source).toContain('ref: desktop-pages')
    expect(source).toContain('git -C .pages-state push origin HEAD:desktop-pages')
    expect(source).toContain('actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e')
    expect(source).not.toContain('continue-on-error: true')
    expect(source).not.toContain('ref: gh-pages')
    expect(source).not.toMatch(/uses:\s+(?:actions|pnpm\/action-setup)\/[^@\s]+@v\d/)
  })
})
