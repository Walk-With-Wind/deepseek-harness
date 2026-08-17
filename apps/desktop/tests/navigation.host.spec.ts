import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isTrustedRendererUrl } from '../src/main/navigation.ts'

describe('Desktop navigation policy', () => {
  it('只信任固定 app origin 的主文档', () => {
    expect(isTrustedRendererUrl('app://localhost/index.html')).toBe(true)
    expect(isTrustedRendererUrl('app://localhost.evil/index.html')).toBe(false)
    expect(isTrustedRendererUrl('https://localhost/index.html')).toBe(false)
  })

  it('外部打开仅允许 HTTPS 的明确产品域名', () => {
    expect(isAllowedExternalUrl('https://github.com/deepseek-ai/deepseek-harness/issues')).toBe(true)
    expect(isAllowedExternalUrl('https://api-docs.deepseek.com/')).toBe(true)
    expect(isAllowedExternalUrl('http://github.com/deepseek-ai/deepseek-harness')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com/other/project')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
