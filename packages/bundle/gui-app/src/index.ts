/**
 * @deepseek-ai/dsh-gui-app 是 Web 与 Desktop 共用的 GUI profile 组合包。
 * 实际组合由 manifest 指向的 cordis.patch.yml 提供；本模块只暴露随包资源根及其产品 overlay。
 * @module @deepseek-ai/dsh-gui-app
 */

import { fileURLToPath } from 'node:url'

/** GUI bundle 随安装交付且禁止用户修改的 Agent Preset 根。 */
export const SHIPPED_AGENT_PRESET_ROOT = fileURLToPath(new URL('../agent-presets/', import.meta.url))

/** 产品启动器应用共享 GUI 资源所需的最小配置行。 */
export interface GuiAppResourceOverlay {
  /** 被覆盖的共享组合行。 */
  readonly id: 'agent-presets'
  /** 保留部署配置并固定可信 preset 资源根。 */
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * 为包含 Agent Preset registry 的最终组合注入共享只读资源根。
 * @param rows - 产品其他 overlay 应用前的组合行索引。
 * @returns registry 不存在时为空，否则返回一条可直接组合的资源 overlay。
 */
export function guiAppResourceOverlays(
  rows: ReadonlyMap<string, { readonly config?: unknown }>,
): GuiAppResourceOverlay[] {
  const row = rows.get('agent-presets')
  if (row === undefined) return []
  const config = typeof row.config === 'object' && row.config !== null
    ? row.config as Record<string, unknown>
    : {}
  return [{
    id: 'agent-presets',
    config: {
      ...config,
      roots: [{ path: SHIPPED_AGENT_PRESET_ROOT, trust: 'system' }],
    },
  }]
}
