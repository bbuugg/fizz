/** 防回归：ACP 与内置会话采用同一 MCP 选择语义，并保留服务端凭据及旧配置兼容性。 */
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@fizz/mcp/types'
import { acpMcpServers } from './acp-mcp'

const servers: McpServerConfig[] = [
  { id: 'local', name: 'docs', command: ' npx ', args: ['-y', 'docs-mcp'], env: { KEY: 'secret', EMPTY: '' } },
  { id: 'web', name: 'web', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } },
  { id: 'legacy', name: 'legacy', transport: 'sse', url: 'https://example.com/sse' },
]

describe('acpMcpServers', () => {
  it('未选择、显式空选择、已删除 id 均不接入任何 MCP', () => {
    expect(acpMcpServers(servers)).toEqual([])
    expect(acpMcpServers(servers, [])).toEqual([])
    expect(acpMcpServers(servers, ['deleted'])).toEqual([])
  })

  it('只转换选中的服务，兼容缺省 stdio，保留参数和凭据且去重', () => {
    expect(acpMcpServers(servers, ['local', 'web', 'local', 'deleted'])).toEqual([
      { type: 'stdio', name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'], env: [{ name: 'KEY', value: 'secret' }, { name: 'EMPTY', value: '' }] },
      { type: 'http', name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer secret' }] },
    ])
    expect(servers[0]?.command).toBe(' npx ')
  })

  it('SSE 保留传输类型，缺省参数/环境/请求头转换为空数组', () => {
    expect(acpMcpServers(servers, ['legacy'])).toEqual([
      { type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] },
    ])
    expect(acpMcpServers([{ id: 'x', name: 'x', command: 'mcp' }], ['x'])).toEqual([
      { type: 'stdio', name: 'x', command: 'mcp', args: [], env: [] },
    ])
  })

  it('不把缺命令或 URL 的无效配置发给外部 Agent', () => {
    expect(acpMcpServers([
      { id: 'a', name: 'a', command: ' ' },
      { id: 'b', name: 'b', transport: 'http' },
    ], ['a', 'b'])).toEqual([])
  })
})
