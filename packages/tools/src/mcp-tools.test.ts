/**
 * 这组用例在防什么回归：
 *
 * 1. `domain.saveMcpServer` 是**整份重建**：`args` 缺省写 `[]`，`env` / `headers` 不给就从
 *    结果里消失。所以「只改个名字」必须把其余字段原样带回 —— 早写错一次就是
 *    「改个名字，参数与环境变量全没了」，而 MCP 少了参数就再也起不来。
 * 2. `env` / `headers` 的三态（缺省保持 / `null` 清空 / 对象整份替换）分不清的话，
 *    「不清空」会变成「清空」，用户刚填的 token 静默消失。
 * 3. `summarizeMcpServer` 是给模型看的视图，**绝不能**把 env / headers 的**值**带进上下文
 *    （那里放的是 token）。
 */
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@fizz/mcp/types'
import { describeMcpChanges, mergeMcpServerInput, summarizeMcpServer } from './mcp-tools'

/** 每例一份新对象：这些函数都是纯函数，但共享 fixture 迟早被某条用例改脏 */
function stdioFixture(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'm1',
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
    env: { API_KEY: 'secret-token' },
    ...over
  }
}

function httpFixture(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'm2',
    name: 'remote',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret-token' },
    ...over
  }
}

describe('mergeMcpServerInput', () => {
  it('只改名字时，命令 / 参数 / 环境变量原样带回', () => {
    const next = mergeMcpServerInput(stdioFixture(), { name: 'fs2' })
    expect(next).toEqual({
      name: 'fs2',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
      env: { API_KEY: 'secret-token' }
    })
  })

  it('env 三态：缺省保持、null 清空、对象整份替换', () => {
    const current = stdioFixture()
    // 缺省（不传 env）：保持
    expect(mergeMcpServerInput(current, { command: 'uvx' }).env).toEqual({ API_KEY: 'secret-token' })
    // null：清空 —— 结果里连 env 这个键都不该有（saveMcpServer 见不到它就写不进去）
    expect('env' in mergeMcpServerInput(current, { env: null })).toBe(false)
    // 对象：整份替换，旧键不留
    expect(mergeMcpServerInput(current, { env: { OTHER: 'x' } }).env).toEqual({ OTHER: 'x' })
    // 空对象等同清空（键一个都不剩，不值得落盘）
    expect('env' in mergeMcpServerInput(current, { env: {} })).toBe(false)
  })

  it('headers 同一条口径（http 侧）', () => {
    const current = httpFixture()
    expect(mergeMcpServerInput(current, { url: 'https://other.example/mcp' }).headers).toEqual({
      Authorization: 'Bearer secret-token'
    })
    expect('headers' in mergeMcpServerInput(current, { headers: null })).toBe(false)
  })

  it('切传输方式不清空另一组字段（切回去还在，domain 层就是这么存的）', () => {
    const next = mergeMcpServerInput(stdioFixture(), { transport: 'http', url: 'https://x.example/mcp' })
    expect(next.transport).toBe('http')
    expect(next.command).toBe('npx')
    expect(next.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'])
  })

  it('名字留空回落到命令 / 地址，不会存出个没名字的条目', () => {
    expect(mergeMcpServerInput(stdioFixture(), { name: '   ' }).name).toBe('npx')
    expect(mergeMcpServerInput(httpFixture(), { name: '' }).name).toBe('https://example.com/mcp')
  })

  it('存量配置没有 transport 时按 stdio 处理', () => {
    const legacy = stdioFixture()
    delete legacy.transport
    expect(mergeMcpServerInput(legacy, {}).transport).toBe('stdio')
  })
})

describe('describeMcpChanges', () => {
  it('没有实际变化时返回空数组（调用方据此回「没给要改的字段」而不是弹一张空审批卡）', () => {
    const current = stdioFixture()
    expect(describeMcpChanges(current, mergeMcpServerInput(current, {}))).toEqual([])
  })

  it('逐项列出改了什么，且只说键名不泄露值', () => {
    const current = stdioFixture()
    const next = mergeMcpServerInput(current, {
      command: 'uvx',
      env: { OTHER_TOKEN: 'super-secret' }
    })
    const changes = describeMcpChanges(current, next)
    expect(changes).toContain('启动命令改为 uvx')
    expect(changes).toContain('环境变量改为 OTHER_TOKEN')
    expect(changes.join('、')).not.toContain('super-secret')
  })

  it('清空环境变量 / 换传输方式都能被描述出来', () => {
    const current = stdioFixture()
    const changes = describeMcpChanges(current, mergeMcpServerInput(current, { env: null, transport: 'sse', url: 'https://x/mcp' }))
    expect(changes).toContain('清空环境变量')
    expect(changes).toContain('传输方式改为 sse')
  })
})

describe('summarizeMcpServer', () => {
  it('stdio：只报 env 的键名，值不进上下文', () => {
    const view = summarizeMcpServer(stdioFixture())
    expect(view).toEqual({
      id: 'm1',
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
      envKeys: ['API_KEY']
    })
    expect(JSON.stringify(view)).not.toContain('secret-token')
  })

  it('http：只报 url 与 header 的键名', () => {
    const view = summarizeMcpServer(httpFixture())
    expect(view).toEqual({
      id: 'm2',
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headerKeys: ['Authorization']
    })
    expect(JSON.stringify(view)).not.toContain('Bearer')
  })

  it('环境变量为空时不带 envKeys（空数组只会占上下文）', () => {
    expect('envKeys' in summarizeMcpServer(stdioFixture({ env: {} }))).toBe(false)
  })
})
