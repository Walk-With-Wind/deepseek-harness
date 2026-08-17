import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopJsonlLogger } from '../src/host/logging.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DesktopJsonlLogger', () => {
  it('仅写入白名单字段并对文件轮转', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-'))
    roots.push(home)
    const logger = new DesktopJsonlLogger(home, 'main', '1.0.0', 256, 3)
    for (let index = 0; index < 12; index += 1) {
      logger.write({
        level: 'info', event: 'host ready', generation: index,
        ...{ secret: 'sensitive-canary' },
      } as never)
    }
    const directory = join(home, 'logs', 'desktop')
    const files = readdirSync(directory).sort()
    expect(files).toEqual(['main.jsonl', 'main.jsonl.1', 'main.jsonl.2'])
    const content = files.map(file => readFileSync(join(directory, file), 'utf8')).join('')
    expect(content).not.toContain('sensitive-canary')
    expect(content).toContain('HOST_READY')
    for (const line of content.trim().split('\n')) {
      expect(() => { void JSON.parse(line) }).not.toThrow()
    }
  })

  it('日志目录或文件不可写时不中断产品运行', () => {
    const badHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-bad-home-'))
    roots.push(badHome)
    writeFileSync(join(badHome, 'logs'), '占用目录位置')

    expect(() => {
      const logger = new DesktopJsonlLogger(badHome, 'main', '1.0.0', 256, 3)
      logger.write({ level: 'error', event: 'still_running' })
    }).not.toThrow()

    const lateFailureHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-late-failure-'))
    roots.push(lateFailureHome)
    const logger = new DesktopJsonlLogger(lateFailureHome, 'main', '1.0.0', 256, 3)
    mkdirSync(join(lateFailureHome, 'logs', 'desktop', 'main.jsonl'))
    expect(() => { logger.write({ level: 'error', event: 'still_running' }) }).not.toThrow()
  })
})
