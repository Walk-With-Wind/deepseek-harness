/** Desktop 原生菜单模板；平台差异只决定更新入口文案。 */
import type { MenuItemConstructorOptions } from 'electron'
import {
  assertDesktopReleasePlatform,
  DESKTOP_PRODUCT_NAME,
} from '../shared/release-policy.ts'
import type { DesktopBuildInfo } from './build-info.ts'

export interface DesktopMenuActions {
  readonly checkForUpdates: () => void
  readonly exportDiagnostics: () => void
}

export interface DesktopMenuOptions {
  readonly releaseMode: DesktopBuildInfo['releaseMode']
}

/** 构造带标准编辑/窗口角色的最小产品菜单。 */
export function createDesktopMenuTemplate(
  platform: NodeJS.Platform,
  actions: DesktopMenuActions,
  options: DesktopMenuOptions,
): MenuItemConstructorOptions[] {
  assertDesktopReleasePlatform(platform)
  const updatesEnabled = options.releaseMode === 'signed'
  const updateItem: MenuItemConstructorOptions = {
    label: updatesEnabled
      ? '检查更新…'
      : options.releaseMode === 'unsigned-preview'
        ? 'Unsigned Preview 不提供自动更新'
        : '开发构建不提供自动更新',
    enabled: updatesEnabled,
    click: actions.checkForUpdates,
  }
  const applicationMenu: MenuItemConstructorOptions = {
    label: DESKTOP_PRODUCT_NAME,
    submenu: [
      { role: 'about', label: `关于 ${DESKTOP_PRODUCT_NAME}` },
      updateItem,
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  const common: MenuItemConstructorOptions[] = [
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    { label: '帮助', submenu: [{ label: '导出诊断包…', click: actions.exportDiagnostics }] },
  ]
  if (platform === 'darwin') return [applicationMenu, ...common]
  return [
    { label: '应用', submenu: [updateItem, { label: '导出诊断包…', click: actions.exportDiagnostics }, { type: 'separator' }, { role: 'quit' }] },
    ...common.slice(0, -1),
  ]
}
