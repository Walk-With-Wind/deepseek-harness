import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type InstallerPhase = 'initial' | 'reinstall'

interface InstallerCycleModule {
  exerciseInstallerLifecycle: <T>(lifecycle: {
    install(phase: InstallerPhase): T
    smoke(installation: T, phase: InstallerPhase): void
    uninstall(phase: InstallerPhase): void
  }) => void
}

async function loadInstallerCycle(): Promise<InstallerCycleModule> {
  const modulePath = resolve(import.meta.dirname, 'desktop-installer-cycle.mjs')
  expect(existsSync(modulePath)).toBe(true)
  return await import(pathToFileURL(modulePath).href) as InstallerCycleModule
}

describe('Desktop installer lifecycle', () => {
  it('首次验收后卸载，并对重装结果再次运行 smoke', async () => {
    const { exerciseInstallerLifecycle } = await loadInstallerCycle()
    const calls: string[] = []

    exerciseInstallerLifecycle({
      install(phase) {
        calls.push(`install:${phase}`)
        return `${phase}-executable`
      },
      smoke(executable, phase) {
        calls.push(`smoke:${phase}:${executable}`)
      },
      uninstall(phase) {
        calls.push(`uninstall:${phase}`)
      },
    })

    expect(calls).toEqual([
      'install:initial',
      'smoke:initial:initial-executable',
      'uninstall:initial',
      'install:reinstall',
      'smoke:reinstall:reinstall-executable',
      'uninstall:reinstall',
    ])
  })

  it('首次 smoke 失败时清理安装且不继续重装', async () => {
    const { exerciseInstallerLifecycle } = await loadInstallerCycle()
    const calls: string[] = []

    expect(() => {
      exerciseInstallerLifecycle({
        install(phase) {
          calls.push(`install:${phase}`)
          return 'executable'
        },
        smoke(_executable, phase) {
          calls.push(`smoke:${phase}`)
          throw new Error('smoke failed')
        },
        uninstall(phase) {
          calls.push(`uninstall:${phase}`)
        },
      })
    }).toThrow('smoke failed')

    expect(calls).toEqual(['install:initial', 'smoke:initial', 'uninstall:initial'])
  })

  it('重装失败时仍执行幂等卸载清理', async () => {
    const { exerciseInstallerLifecycle } = await loadInstallerCycle()
    const calls: string[] = []

    expect(() => {
      exerciseInstallerLifecycle({
        install(phase) {
          calls.push(`install:${phase}`)
          if (phase === 'reinstall') throw new Error('reinstall failed')
          return 'executable'
        },
        smoke(_executable, phase) {
          calls.push(`smoke:${phase}`)
        },
        uninstall(phase) {
          calls.push(`uninstall:${phase}`)
        },
      })
    }).toThrow('reinstall failed')

    expect(calls).toEqual([
      'install:initial',
      'smoke:initial',
      'uninstall:initial',
      'install:reinstall',
      'uninstall:reinstall',
    ])
  })
})
