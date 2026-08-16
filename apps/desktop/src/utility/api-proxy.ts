/** Desktop API Gateway：复用共享业务实现，只替换原生路径能力和客户端路径授权。 */
import type { Context } from '@deepseek-ai/cordis'
import ApiProxyService, { type Config } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-workspace'
import { authorizeDesktopWorkspacePath } from './path-authorizer.ts'

/** Desktop Gateway 除共享依赖外还必须等待 Main 控制端口。 */
export const inject = [...ApiProxyService.inject, 'desktopHost']

/** 让所有系统路径打开都经 Main，同时只授权客户端访问已登记 workspace。 */
export default class DesktopApiProxyService extends ApiProxyService {
  static override inject = inject
  static override Config = ApiProxyService.Config

  /** @param ctx - 已装配 workspace registry 与 Desktop Main 控制能力的 Utility Context。 */
  constructor(ctx: Context, config: Config) {
    super(ctx, config, {
      authorizeOpenPath: (path, signal) => authorizeDesktopWorkspacePath(
        ctx.workspaceRegistry.list(), path, signal,
      ),
      openPath: (path, signal) => ctx.desktopHost.openPath(path, 'default', signal),
      openTextFile: (path, signal) => ctx.desktopHost.openPath(path, 'text-editor', signal),
    })
  }
}
