/** @module @deepseek-ai/dsh-gui-app/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-gui-app'

/** Cordis companion 的稳定插件名。 */
export const name = 'gui-app-invariant'
/** 注册 invariant 前所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包只拥有静态 patch 列表；各行由所属包校验自身运行时关系。 */
const install: InvariantInstaller = () => {}

/**
 * 注册包级 invariant companion。
 * @param ctx - 提供 invariant registry 的 Cordis 上下文。
 * @returns 注册完成后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
