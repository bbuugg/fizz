/**
 * 命令面板「主机」二级视图的展示字段。
 *
 * 钉住的是「数据里出现本版本不认识 / 字段不全的主机时不许崩」：
 * - cmdk 会对 `keywords` 逐个 `.trim()`（`keywords.map(k => k.trim())`），数组里混进
 *   一个 undefined 就是整块命令面板白屏（`Cannot read properties of undefined
 *   (reading 'trim')`）—— 而「打开主机」正是渲染这一屏的入口，一崩就进不去主机列表；
 * - 这种记录确实会出现在磁盘上：`kind: 'vnc'` 是别的版本写进去的，服务端 `toHostView`
 *   原样透传（只认 `local` / 其余当 ssh），于是这条记录没有 `username`；
 * - 摘要也不许拼出 `undefined@127.0.0.1:5901` 这种给人看的假地址。
 */
import { describe, expect, it } from 'vitest'
import { hostPaletteFields, hostSummary, parseKeepaliveInput, parsePortInput } from './host-format'
import type { HostConfig } from '@fizz/contracts/types'

function sshHost(overrides: Partial<Record<string, unknown>> = {}): HostConfig {
  return {
    id: 'h1',
    name: '腾讯云',
    host: 'router.example.com',
    port: 8022,
    username: 'root',
    authType: 'password',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as unknown as HostConfig
}

function localHost(overrides: Partial<Record<string, unknown>> = {}): HostConfig {
  return {
    id: 'h2',
    kind: 'local',
    name: 'Pwsh',
    shellName: 'PowerShell 7',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as unknown as HostConfig
}

/** 本版本不认识的类型：只能当 ssh 主机渲染，而且没有 username */
function unknownKindHost(): HostConfig {
  return {
    id: 'h3',
    kind: 'vnc',
    name: 'local',
    host: '127.0.0.1',
    port: 5901,
    createdAt: 0,
    updatedAt: 0
  } as unknown as HostConfig
}

const allStrings = (keywords: string[]): boolean =>
  keywords.every((k) => typeof k === 'string' && k.length > 0)

describe('hostPaletteFields', () => {
  it('SSH 主机：副标题是 user@host:port，关键词带地址与用户名', () => {
    const fields = hostPaletteFields(sshHost())
    expect(fields.label).toBe('腾讯云')
    expect(fields.subtitle).toBe('root@router.example.com:8022')
    expect(fields.keywords).toContain('root')
    expect(fields.keywords).toContain('router.example.com')
    expect(allStrings(fields.keywords)).toBe(true)
  })

  it('本机终端：副标题是 shell 名 + 参数个数', () => {
    const fields = hostPaletteFields(localHost({ args: ['-NoLogo', '-NoProfile'] }))
    expect(fields.label).toBe('Pwsh')
    expect(fields.subtitle).toBe('PowerShell 7 · 2 个参数')
    expect(allStrings(fields.keywords)).toBe(true)
  })

  it('本机终端没有 shellName：副标题回落「默认终端」', () => {
    const fields = hostPaletteFields(localHost({ shellName: undefined }))
    expect(fields.subtitle).toBe('默认终端')
  })

  // 这条就是回归本身：`kind: 'vnc'` 走了 ssh 分支，`username` 是 undefined
  it('不认识的 kind（vnc，缺 username）：不抛错，关键词全是字符串，摘要不出现 undefined', () => {
    const host = unknownKindHost()
    const fields = hostPaletteFields(host)
    expect(allStrings(fields.keywords)).toBe(true)
    expect(fields.subtitle).toBe('127.0.0.1:5901')
    expect(fields.subtitle).not.toContain('undefined')
    expect(fields.label).toBe('local')
  })

  it('name 缺失：标题用地址兜底', () => {
    const fields = hostPaletteFields(sshHost({ name: undefined }))
    expect(fields.label).toBe('root@router.example.com:8022')
  })

  it('连地址都缺失：不抛错，也不拼出 undefined', () => {
    const fields = hostPaletteFields({ id: 'h4' } as unknown as HostConfig)
    expect(fields.label).toBe('未命名主机')
    expect(fields.subtitle).toBe('地址未填写')
    expect(allStrings(fields.keywords)).toBe(true)
  })
})

describe('parseKeepaliveInput', () => {
  // 回归：保存时用真值判断会把 0 丢掉，服务端于是「保留上一次的值」
  it('0 是合法值（关闭保活），必须原样带出', () => {
    expect(parseKeepaliveInput('0')).toBe(0)
  })

  it('留空 = undefined：提交时不带该字段，服务端保留原值', () => {
    expect(parseKeepaliveInput('')).toBeUndefined()
    expect(parseKeepaliveInput('   ')).toBeUndefined()
  })

  it('非数字 = undefined', () => {
    expect(parseKeepaliveInput('abc')).toBeUndefined()
  })

  it('正常秒数原样解析（忽略首尾空白）', () => {
    expect(parseKeepaliveInput(' 45 ')).toBe(45)
  })
})

describe('parsePortInput', () => {
  // 回归：省略 port 在服务端 = 保留旧值，清空端口改回 22 会静默失效
  it('留空 = 默认 22', () => {
    expect(parsePortInput('')).toBe(22)
    expect(parsePortInput('   ')).toBe(22)
  })

  it('正常端口原样解析（忽略首尾空白）', () => {
    expect(parsePortInput(' 8022 ')).toBe(8022)
  })

  it('非法 / 越界一律回默认 22（与服务端 normalizeSshPort 同口径）', () => {
    expect(parsePortInput('abc')).toBe(22)
    expect(parsePortInput('0')).toBe(22)
    expect(parsePortInput('70000')).toBe(22)
    expect(parsePortInput('22.5')).toBe(22)
  })
})

describe('hostSummary', () => {
  it('完整字段：user@host:port', () => {
    expect(hostSummary(sshHost() as never)).toBe('root@router.example.com:8022')
  })

  it('缺 username：只留 host:port', () => {
    expect(hostSummary(sshHost({ username: undefined }) as never)).toBe('router.example.com:8022')
  })
})
