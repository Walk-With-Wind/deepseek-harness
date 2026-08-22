/** DeepSeek Harness Desktop 的唯一 Forge 发行配置。 */
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { flipFuses, FuseVersion, FuseV1Options, type FuseConfig } from '@electron/fuses'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'
import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DMG_VOLUME_NAME,
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_PUBLISHER,
  DESKTOP_WINDOWS_SETUP_EXE,
  DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
  desktopNativeVersions,
} from './src/shared/release-policy.ts'
import { emitDesktopPackageDiagnosticForPath } from '../../scripts/lib/desktop-package-diagnostics.ts'

const appRoot = import.meta.dirname
const assets = resolve(appRoot, 'assets')
const signingEnabled = process.env.DSH_DESKTOP_SIGNING === '1'
const desktopManifest = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')) as {
  version?: unknown
}
if (typeof desktopManifest.version !== 'string') throw new Error('Desktop manifest 缺少版本')
const nativeBuildSequenceText = process.env.DSH_DESKTOP_BUILD_SEQUENCE ?? '1'
if (!/^\d+$/.test(nativeBuildSequenceText)) throw new Error('DSH_DESKTOP_BUILD_SEQUENCE 必须是正整数')
const nativeVersions = desktopNativeVersions(desktopManifest.version, Number(nativeBuildSequenceText))
// Forge 的执行宿主与打包目标可能不同，macOS 和 Windows 共享库都必须进入解包白名单。
const sharedLibraryUnpack = '{**/*.dylib,**/*.dll}'

/** Electron 43 全部 V1 fuse 的显式发行状态。 */
export const desktopFuseConfig = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
} satisfies FuseConfig

/** 在 Forge 复制完成、签名开始前定位原始 Electron 可执行文件。 */
function electronExecutablePath(buildPath: string, platform: string): string {
  const basePath = resolve(buildPath, '../..')
  if (platform === 'darwin' || platform === 'mas') return join(basePath, 'MacOS', 'Electron')
  return join(basePath, platform === 'win32' ? 'electron.exe' : 'electron')
}

function requiredSigningValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (value === undefined || value === '') {
    throw new Error(`Desktop 签名已启用，但受保护环境缺少 ${name}`)
  }
  return value
}

function macSigningOptionsForFile(
  mainEntitlements: string,
  inheritedEntitlements: string,
  hardenedRuntime: boolean,
  timestamp?: string,
) {
  return (filePath: string) => ({
    entitlements: filePath.includes('.app/') ? inheritedEntitlements : mainEntitlements,
    hardenedRuntime,
    ...(timestamp === undefined ? {} : { timestamp }),
  })
}

/**
 * 解析 macOS 完整应用签名配置；无发行证书时使用临时签名保证原生更新器可读取应用身份。
 * @param environment - 当前构建环境变量。
 * @param productionSigningEnabled - 是否启用发行签名与公证。
 * @returns Electron Packager 的 macOS 签名配置。
 */
export function resolveMacSigningConfig(
  environment: NodeJS.ProcessEnv,
  productionSigningEnabled: boolean,
) {
  if (!productionSigningEnabled) {
    const adhocEntitlements = resolve(assets, 'entitlements.mac.adhoc.plist')
    return {
      osxSign: {
        identity: '-',
        identityValidation: false,
        optionsForFile: macSigningOptionsForFile(
          adhocEntitlements,
          adhocEntitlements,
          false,
          'none',
        ),
      },
    }
  }
  const mainEntitlements = resolve(assets, 'entitlements.mac.plist')
  const inheritedEntitlements = resolve(assets, 'entitlements.mac.inherit.plist')
  return {
    osxSign: {
      identity: requiredSigningValue(environment, 'DSH_MAC_SIGN_IDENTITY'),
      optionsForFile: macSigningOptionsForFile(mainEntitlements, inheritedEntitlements, true),
    },
    osxNotarize: {
      appleApiKey: requiredSigningValue(environment, 'DSH_APPLE_API_KEY_PATH'),
      appleApiKeyId: requiredSigningValue(environment, 'DSH_APPLE_API_KEY_ID'),
      appleApiIssuer: requiredSigningValue(environment, 'DSH_APPLE_API_ISSUER'),
    },
  }
}

const macSigning = process.platform === 'darwin'
  ? resolveMacSigningConfig(process.env, signingEnabled)
  : {}

/** Windows 只选择 PFX 或受保护签名服务参数之一，避免互相覆盖。 */
export function resolveWindowsSigningConfig(environment: NodeJS.ProcessEnv) {
  const common = {
    hashes: ['sha256'] as ['sha256'],
    timestampServer: 'http://timestamp.digicert.com',
  }
  const signWithParams = environment.DSH_WINDOWS_SIGN_WITH_PARAMS
  if (signWithParams !== undefined && signWithParams !== '') return { signWithParams, ...common }
  const certificateFile = environment.DSH_WINDOWS_CERTIFICATE_PATH
  const certificatePassword = environment.DSH_WINDOWS_CERTIFICATE_PASSWORD
  if (certificateFile === undefined || certificateFile === ''
    || certificatePassword === undefined || certificatePassword === '') {
    throw new Error('Desktop Windows 签名已启用，但必须提供签名服务参数或完整 PFX 凭据')
  }
  return { certificateFile, certificatePassword, ...common }
}

const squirrelSigning = signingEnabled && process.platform === 'win32'
  ? resolveWindowsSigningConfig(process.env)
  : {}

const config = {
  outDir: resolve(appRoot, '../../.artifacts/desktop/out'),
  packagerConfig: {
    name: DESKTOP_PRODUCT_NAME,
    ...nativeVersions,
    executableName: DESKTOP_EXECUTABLE_NAME,
    appBundleId: DESKTOP_APPLICATION_ID,
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: `Copyright © ${DESKTOP_PUBLISHER}`,
    asar: {
      unpack: `{**/*.node,${sharedLibraryUnpack},**/*-spawn-helper,**/spawn-helper,**/@vscode/ripgrep*/**/rg,**/@vscode/ripgrep*/**/rg.exe}`,
    },
    icon: process.platform === 'darwin'
      ? resolve(assets, 'icon.icns')
      : process.platform === 'win32'
        ? resolve(assets, 'icon.ico')
        : resolve(assets, 'icon.png'),
    overwrite: true,
    prune: false,
    junk: true,
    ignore: [/\/forge\.config\.(?:ts|mts|js|mjs)$/],
    extendInfo: {
      NSHumanReadableCopyright: `Copyright © ${DESKTOP_PUBLISHER}`,
      NSSupportsAutomaticGraphicsSwitching: true,
    },
    ...macSigning,
    ...(signingEnabled && process.platform === 'win32' ? { windowsSign: squirrelSigning } : {}),
  },
  rebuildConfig: {
    force: true,
    // Electron Rebuild 的 onlyModules 仍会递归生产依赖图；空 types 配合 extraModules 只遍历明确原生模块。
    types: [],
    extraModules: ['koffi', 'node-pty'],
  },
  hooks: {
    packageAfterCopy: async (forgeConfig, buildPath, _electronVersion, platform, arch) => {
      await emitDesktopPackageDiagnosticForPath('packager-copy-complete', buildPath)
      const osxSign = forgeConfig.packagerConfig.osxSign
      const hasMacSigning = (typeof osxSign === 'object' && Object.keys(osxSign).length > 0)
        || Boolean(osxSign)
      await flipFuses(electronExecutablePath(buildPath, platform), {
        resetAdHocDarwinSignature: !hasMacSigning
          && (platform === 'darwin' || platform === 'mas')
          && arch === 'arm64',
        ...desktopFuseConfig,
      })
    },
  },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ format: 'ULFO', name: DESKTOP_DMG_VOLUME_NAME, overwrite: true }, ['darwin']),
    new MakerSquirrel({
      name: DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
      authors: DESKTOP_PUBLISHER,
      setupExe: DESKTOP_WINDOWS_SETUP_EXE,
      noMsi: true,
      ...(signingEnabled && process.platform === 'win32'
        ? { windowsSign: squirrelSigning }
        : {}),
    }),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
} satisfies ForgeConfig

export default config
