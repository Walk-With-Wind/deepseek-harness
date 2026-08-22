import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeDesktopWorkspacePath } from '../src/utility/path-authorizer.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('authorizeDesktopWorkspacePath', () => {
  it('只返回登记 workspace 内现存目标的规范路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-path-policy-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const nested = join(workspace, 'nested')
    const file = join(nested, 'file.txt')
    await mkdir(nested, { recursive: true })
    await writeFile(file, 'ok')
    const canonicalWorkspace = await realpath(workspace)
    const canonicalFile = await realpath(file)

    await expect(authorizeDesktopWorkspacePath(
      [{ path: canonicalWorkspace }], file, new AbortController().signal,
    )).resolves.toBe(canonicalFile)
  })

  it('拒绝 workspace 外部目标和从 workspace 内逃逸的符号链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-path-policy-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside.txt')
    const link = join(workspace, 'link.txt')
    await mkdir(workspace)
    await writeFile(outside, 'outside')
    await symlink(outside, link)
    const canonicalWorkspace = await realpath(workspace)

    await expect(authorizeDesktopWorkspacePath(
      [{ path: canonicalWorkspace }], outside, new AbortController().signal,
    )).rejects.toThrow('不属于已登记工作区')
    await expect(authorizeDesktopWorkspacePath(
      [{ path: canonicalWorkspace }], link, new AbortController().signal,
    )).rejects.toThrow('不属于已登记工作区')
  })
})
