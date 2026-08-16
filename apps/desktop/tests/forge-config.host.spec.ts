import { FuseV1Options } from '@electron/fuses'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config, {
  desktopFuseConfig,
  resolveMacSigningConfig,
  resolveWindowsSigningConfig,
} from '../forge.config.ts'

describe('Desktop Forge config', () => {
  it('启用 ASAR、原生解包与全部安全 fuse', () => {
    expect(config.packagerConfig.asar).toBeTruthy()
    const asar = config.packagerConfig.asar
    if (typeof asar !== 'object' || asar === null) throw new Error('测试需要对象形式的 ASAR 配置')
    expect(asar.unpack).toMatch(/dylib/)
    expect(asar.unpack).toMatch(/\.dll/)
    expect(asar.unpack).toMatch(/\.so/)
    expect(asar.unpack).toMatch(/landlock-run/)
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

  it('只为各平台声明首发安装格式', () => {
    const makers = config.makers.map(maker => ({ name: maker.name, platforms: maker.platforms }))
    expect(makers).toEqual([
      { name: 'zip', platforms: ['darwin'] },
      { name: 'dmg', platforms: ['darwin'] },
      { name: 'squirrel', platforms: ['win32'] },
      { name: 'deb', platforms: ['linux'] },
      { name: 'rpm', platforms: ['linux'] },
    ])
  })

  it('Squirrel maker 与应用 manifest 都声明稳定发行身份', () => {
    const squirrel = config.makers.find(maker => maker.name === 'squirrel') as unknown as {
      configOrConfigFetcher: { name?: string; authors?: string }
    }
    const deb = config.makers.find(maker => maker.name === 'deb') as unknown as {
      configOrConfigFetcher: { options?: { bin?: string; maintainer?: string } }
    }
    const rpm = config.makers.find(maker => maker.name === 'rpm') as unknown as {
      configOrConfigFetcher: { options?: { bin?: string } }
    }
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      author?: string
      devDependencies?: Record<string, string>
      productName?: string
    }
    expect(squirrel.configOrConfigFetcher).toMatchObject({ name: 'DeepSeekHarness', authors: 'DeepSeek AI' })
    expect(deb.configOrConfigFetcher.options).toMatchObject({
      bin: 'deepseek-harness',
      maintainer: 'DeepSeek AI',
    })
    expect(rpm.configOrConfigFetcher.options).toMatchObject({ bin: 'deepseek-harness' })
    expect(manifest).toMatchObject({ author: 'DeepSeek AI', productName: 'DeepSeek Harness' })
    expect(manifest.devDependencies?.['electron-winstaller']).toBe('5.4.4')
  })

  it('Windows 签名配置在 PFX 与签名服务之间二选一', () => {
    expect(resolveWindowsSigningConfig({ DSH_WINDOWS_SIGN_WITH_PARAMS: '/csp protected' }))
      .toEqual({ signWithParams: '/csp protected' })
    expect(resolveWindowsSigningConfig({
      DSH_WINDOWS_CERTIFICATE_PATH: 'certificate.pfx',
      DSH_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    })).toEqual({ certificateFile: 'certificate.pfx', certificatePassword: 'secret' })
    expect(() => resolveWindowsSigningConfig({})).toThrow(/必须提供/)
  })

  it('macOS 未配置发行证书时仍对完整应用执行临时签名', () => {
    expect(resolveMacSigningConfig({}, false)).toEqual({
      osxSign: {
        identity: '-',
        identityValidation: false,
        hardenedRuntime: false,
        timestamp: 'none',
      },
    })
    expect(() => resolveMacSigningConfig({}, true)).toThrow(/DSH_MAC_SIGN_IDENTITY/)
    expect(resolveMacSigningConfig({
      DSH_MAC_SIGN_IDENTITY: 'Developer ID Application: Test',
      DSH_APPLE_API_KEY_PATH: '/tmp/AuthKey_TEST.p8',
      DSH_APPLE_API_KEY_ID: 'TEST',
      DSH_APPLE_API_ISSUER: 'issuer',
    }, true)).toMatchObject({
      osxSign: { identity: 'Developer ID Application: Test', hardenedRuntime: true },
      osxNotarize: {
        appleApiKey: '/tmp/AuthKey_TEST.p8',
        appleApiKeyId: 'TEST',
        appleApiIssuer: 'issuer',
      },
    })
  })
})
