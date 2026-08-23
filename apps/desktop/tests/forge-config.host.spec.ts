import { FuseV1Options } from '@electron/fuses'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config, {
  desktopFuseConfig,
  resolveMacSigningConfig,
  resolveWindowsSigningConfig,
} from '../forge.config.ts'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DMG_VOLUME_NAME,
  DESKTOP_EXECUTABLE_NAME,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_PUBLISHER,
  DESKTOP_REPOSITORY,
  DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
  desktopNativeVersions,
} from '../src/shared/release-policy.ts'

describe('Desktop Forge config', () => {
  it('启用 ASAR、原生解包与全部安全 fuse', () => {
    expect(config.packagerConfig.asar).toBeTruthy()
    const asar = config.packagerConfig.asar
    if (typeof asar !== 'object' || asar === null) throw new Error('测试需要对象形式的 ASAR 配置')
    expect(asar.unpack).toMatch(/dylib/)
    expect(asar.unpack).toMatch(/\.dll/)
    expect(asar.unpack).not.toMatch(/\.so/)
    expect(asar.unpack).not.toMatch(/landlock-run/)
    expect(config.packagerConfig.prune).toBe(false)
    expect(config.plugins.map(plugin => plugin.name)).toEqual(['auto-unpack-natives'])
    expect(config.hooks.packageAfterCopy).toBeTypeOf('function')
    expect(desktopFuseConfig.strictlyRequireAllFuses).toBe(true)
    expect(desktopFuseConfig[FuseV1Options.RunAsNode]).toBe(false)
    expect(desktopFuseConfig[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(desktopFuseConfig[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(desktopFuseConfig[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
    expect(desktopFuseConfig[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
    expect(desktopFuseConfig[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]).toBe(false)
    expect(desktopFuseConfig[FuseV1Options.WasmTrapHandlers]).toBe(true)
  })

  it('原生重建只遍历明确声明的模块，不扫描完整生产依赖图', () => {
    expect(config.rebuildConfig).toEqual({
      force: true,
      types: [],
      extraModules: ['koffi', 'node-pty'],
    })
  })

  it('只为各平台声明首发安装格式', () => {
    const makers = config.makers.map(maker => ({ name: maker.name, platforms: maker.platforms }))
    expect(makers).toEqual([
      { name: 'zip', platforms: ['darwin'] },
      { name: 'dmg', platforms: ['darwin'] },
      { name: 'squirrel', platforms: ['win32'] },
    ])
  })

  it('DMG 使用不超过 macOS Alias 限制的独立卷标', () => {
    const dmg = config.makers.find(maker => maker.name === 'dmg') as unknown as {
      configOrConfigFetcher: { name?: string }
    }
    expect(DESKTOP_DMG_VOLUME_NAME).toBe('DeepSeek Harness Community')
    expect(dmg.configOrConfigFetcher.name).toBe(DESKTOP_DMG_VOLUME_NAME)
    expect(DESKTOP_DMG_VOLUME_NAME.length).toBeLessThanOrEqual(27)
  })

  it('Squirrel maker 与应用 manifest 都声明稳定发行身份', () => {
    const squirrel = config.makers.find(maker => maker.name === 'squirrel') as unknown as {
      configOrConfigFetcher: { name?: string; authors?: string; setupExe?: string }
    }
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      author?: string
      devDependencies?: Record<string, string>
      productName?: string
      repository?: { url?: string }
    }
    expect(DESKTOP_PRODUCT_NAME).toBe('DeepSeek Harness Community Build')
    expect(DESKTOP_PUBLISHER).toBe('Walk-With-Wind')
    expect(DESKTOP_APPLICATION_ID).toBe('io.github.walk-with-wind.deepseek-harness')
    expect(DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID).toBe('DeepSeekHarnessCommunity')
    expect(DESKTOP_EXECUTABLE_NAME).toBe('deepseek-harness-community')
    expect(DESKTOP_REPOSITORY).toBe('https://github.com/Walk-With-Wind/deepseek-harness')
    const buildSequence = Number(process.env.DSH_DESKTOP_BUILD_SEQUENCE ?? '1')
    expect(config.packagerConfig).toMatchObject({
      name: DESKTOP_PRODUCT_NAME,
      appVersion: '0.1.0',
      buildVersion: desktopNativeVersions('0.1.0-rc.8', buildSequence).buildVersion,
      executableName: DESKTOP_EXECUTABLE_NAME,
      appBundleId: DESKTOP_APPLICATION_ID,
      appCopyright: `Copyright © ${DESKTOP_PUBLISHER}`,
      extendInfo: {
        NSHumanReadableCopyright: `Copyright © ${DESKTOP_PUBLISHER}`,
      },
    })
    expect(squirrel.configOrConfigFetcher).toMatchObject({
      name: DESKTOP_WINDOWS_SQUIRREL_PACKAGE_ID,
      authors: DESKTOP_PUBLISHER,
      setupExe: 'DeepSeek-Harness-Community-Setup.exe',
    })
    expect(squirrel.configOrConfigFetcher).not.toHaveProperty('certificateFile')
    expect(readFileSync(resolve(import.meta.dirname, '../forge.config.ts'), 'utf8'))
      .toContain('{ windowsSign: squirrelSigning }')
    expect(manifest).toMatchObject({
      author: DESKTOP_PUBLISHER,
      productName: DESKTOP_PRODUCT_NAME,
      repository: { url: `git+${DESKTOP_REPOSITORY}.git` },
    })
    expect(manifest.devDependencies).not.toHaveProperty('electron-winstaller')
    expect(manifest.devDependencies).not.toHaveProperty('@electron-forge/maker-deb')
    expect(manifest.devDependencies).not.toHaveProperty('@electron-forge/maker-rpm')
  })

  it('Windows 签名配置在 PFX 与签名服务之间二选一', () => {
    expect(resolveWindowsSigningConfig({ DSH_WINDOWS_SIGN_WITH_PARAMS: '/csp protected' }))
      .toEqual({
        signWithParams: '/csp protected',
        hashes: ['sha256'],
        timestampServer: 'http://timestamp.digicert.com',
      })
    expect(resolveWindowsSigningConfig({
      DSH_WINDOWS_CERTIFICATE_PATH: 'certificate.pfx',
      DSH_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    })).toEqual({
      certificateFile: 'certificate.pfx',
      certificatePassword: 'secret',
      hashes: ['sha256'],
      timestampServer: 'http://timestamp.digicert.com',
    })
    expect(() => resolveWindowsSigningConfig({})).toThrow(/必须提供/)
  })

  it('macOS 未配置发行证书时仍对完整应用执行临时签名', () => {
    const adhoc = resolveMacSigningConfig({}, false)
    expect(adhoc.osxSign).toMatchObject({ identity: '-', identityValidation: false })
    expect(adhoc.osxSign.optionsForFile).toBeTypeOf('function')
    const adhocEntitlements = resolve(import.meta.dirname, '../assets/entitlements.mac.adhoc.plist')
    expect(adhoc.osxSign.optionsForFile?.('/tmp/Product.app')).toEqual({
      entitlements: adhocEntitlements,
      hardenedRuntime: false,
      timestamp: 'none',
    })
    expect(adhoc.osxSign.optionsForFile?.('/tmp/Product.app/Contents/Frameworks/Helper.app')).toEqual({
      entitlements: adhocEntitlements,
      hardenedRuntime: false,
      timestamp: 'none',
    })
    expect(() => resolveMacSigningConfig({}, true)).toThrow(/DSH_MAC_SIGN_IDENTITY/)
    const production = resolveMacSigningConfig({
      DSH_MAC_SIGN_IDENTITY: 'Developer ID Application: Test',
      DSH_APPLE_API_KEY_PATH: '/tmp/AuthKey_TEST.p8',
      DSH_APPLE_API_KEY_ID: 'TEST',
      DSH_APPLE_API_ISSUER: 'issuer',
    }, true)
    expect(production).toMatchObject({
      osxSign: { identity: 'Developer ID Application: Test' },
      osxNotarize: {
        appleApiKey: '/tmp/AuthKey_TEST.p8',
        appleApiKeyId: 'TEST',
        appleApiIssuer: 'issuer',
      },
    })
    expect(production.osxSign.optionsForFile?.('/tmp/Product.app')).toEqual({
      entitlements: resolve(import.meta.dirname, '../assets/entitlements.mac.plist'),
      hardenedRuntime: true,
    })
    expect(production.osxSign.optionsForFile?.('/tmp/Product.app/Contents/Frameworks/Helper.app')).toEqual({
      entitlements: resolve(import.meta.dirname, '../assets/entitlements.mac.inherit.plist'),
      hardenedRuntime: true,
    })
  })
})
