import { describe, expect, it } from 'vitest'
import { normalizeDesktopAsarEntry } from './desktop-artifact.ts'

describe('normalizeDesktopAsarEntry', () => {
  it('normalizes POSIX and Windows ASAR entry paths', () => {
    expect(normalizeDesktopAsarEntry('/package.json')).toBe('package.json')
    expect(normalizeDesktopAsarEntry('/lib/main.js')).toBe('lib/main.js')
    expect(normalizeDesktopAsarEntry('\\package.json')).toBe('package.json')
    expect(normalizeDesktopAsarEntry('\\lib\\main.js')).toBe('lib/main.js')
  })
})
