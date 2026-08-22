/** Web SessionLogSaver provider 的 invariant companion。 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-log-saver-web'

/** Cordis companion 插件名。 */
export const name = 'session-log-saver-web-invariant'
/** 注册 invariant 前需要全局服务。 */
export const inject = ['invariants']

/** No runtime invariant: provider 只提供一个不可变 saver，不持有跨插件可变关系。 */
const install: InvariantInstaller = () => {}

/**
 * 注册包所有权 companion。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 注册 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
