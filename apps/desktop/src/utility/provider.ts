/** Electron Main 原生能力在 Utility Cordis 树中的 provider。 */
import type { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'

/** Main 控制能力必须先于 Desktop provider 安装。 */
export const inject = ['desktopHost']

/** 复用现有 DirectoryPicker 接缝，不让业务插件感知 Electron。 */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability

  /** @param ctx - 已提供 Desktop Main 控制端口的 Utility Context。 */
  constructor(ctx: Context) {
    super(ctx)
    this.nativeCapability = { kind: 'native', pick: signal => ctx.desktopHost.pickDirectory(signal) }
  }

  /** @inheritdoc */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
