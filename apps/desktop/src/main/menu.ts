/** Desktop 原生菜单模板；平台差异只决定更新入口文案。 */
import type { MenuItemConstructorOptions } from 'electron'

export interface DesktopMenuActions {
  readonly checkForUpdates: () => void
  readonly openReleasePage: () => void
  readonly exportDiagnostics: () => void
}

/** 构造带标准编辑/窗口角色的最小产品菜单。 */
export function createDesktopMenuTemplate(
  platform: NodeJS.Platform,
  updatesSupported: boolean,
  actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
  const updateItem: MenuItemConstructorOptions = updatesSupported
    ? { label: '检查更新…', click: actions.checkForUpdates }
    : { label: '查看升级说明…', click: actions.openReleasePage }
  const applicationMenu: MenuItemConstructorOptions = {
    label: 'DeepSeek Harness',
    submenu: [
      { role: 'about', label: '关于 DeepSeek Harness' },
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
