/** Desktop Renderer 路径请求的 workspace 授权策略。 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

interface WorkspacePathRoot {
  readonly path: string
}

/** 判断规范目标是否位于一个规范 workspace 根内。 */
function containsPath(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === ''
    || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * 把 Renderer 提交的路径解析为现存真实路径，并限制在已登记 workspace 内。
 * @param workspaces - Host registry 当前持有的规范 workspace 根。
 * @param requestedPath - Renderer 经业务 API 提交的候选路径。
 * @param signal - 当前请求的取消信号。
 * @returns 可交给 Main 的规范绝对路径。
 */
export async function authorizeDesktopWorkspacePath(
  workspaces: readonly WorkspacePathRoot[],
  requestedPath: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  let canonical: string
  try {
    canonical = await realpath(requestedPath)
  } catch {
    throw new Error('路径不存在或不可访问')
  }
  signal.throwIfAborted()
  if (!workspaces.some(workspace => containsPath(workspace.path, canonical))) {
    throw new Error('路径不属于已登记工作区')
  }
  return canonical
}
