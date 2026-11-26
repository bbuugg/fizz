/** 防回归：设置中的 MCP 必须经过能力过滤，并同时进入新建与恢复请求；两版 wire 形状不同。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpConnection, AcpMcpServer } from './types'

const mock = vi.hoisted(() => ({ context: null as any }))

function client() {
  const builder = {
    onRequest: () => builder,
    onNotification: () => builder,
    connectWith: (_stream: unknown, connected: (ctx: any) => Promise<void>) => connected(mock.context),
  }
  return builder
}

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agentclientprotocol/sdk')>(),
  client: () => client(),
  ndJsonStream: () => ({}),
}))
vi.mock('@agentclientprotocol/sdk/experimental/v2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agentclientprotocol/sdk/experimental/v2')>(),
  client: () => client(),
  ndJsonStream: () => ({}),
}))

import { v1Factory } from './v1'
import { v2Factory } from './v2'

const servers: AcpMcpServer[] = [
  { type: 'stdio', name: 'local', command: '/bin/mcp', args: ['--docs'], env: [{ name: 'TOKEN', value: 'secret' }] },
  { type: 'http', name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer secret' }] },
  { type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] },
]

let connection: AcpConnection | undefined
afterEach(() => { connection?.close(); connection = undefined })

async function connect(version: 'v1' | 'v2', capabilities: unknown) {
  const attached: unknown[] = []
  const builder = {
    withMcpServer: (server: unknown) => { attached.push(server); return builder },
    start: vi.fn(async () => ({ sessionId: 'new', newSessionResponse: {}, modes: null })),
  }
  const request = vi.fn(async () => version === 'v1'
    ? { agentCapabilities: { mcpCapabilities: capabilities } }
    : { capabilities: { session: { mcp: capabilities } } })
  mock.context = { request, buildSession: vi.fn(() => builder) }
  connection = await (version === 'v1' ? v1Factory : v2Factory).connect({
    toAgent: {} as WritableStream<Uint8Array>,
    fromAgent: {} as ReadableStream<Uint8Array>,
    handlers: { onPermission: async () => ({ approved: false }) },
  })
  await connection.initialize()
  return { connection, attached, request }
}

describe('ACP MCP 配置透传', () => {
  it('v1 新建与恢复均透传配置，stdio 不带 type', async () => {
    const { connection, attached, request } = await connect('v1', { http: true, sse: true })
    const { type: _type, ...stdio } = servers[0]!
    const expected = [stdio, servers[1], servers[2]]
    await connection.newSession('/workspace', servers)
    expect(attached).toEqual(expected)
    await connection.resumeSession('old', '/workspace', servers)
    expect(request.mock.calls.at(-1)).toEqual(expect.arrayContaining([
      { sessionId: 'old', cwd: '/workspace', mcpServers: expected },
    ]))
  })

  it.each([undefined, {}, { http: false, sse: false }])('v1 没广告网络传输时仍支持 stdio（%j）', async (caps) => {
    const { connection, attached } = await connect('v1', caps)
    await connection.newSession('/workspace', servers)
    expect(attached).toHaveLength(1)
    expect(attached[0]).not.toHaveProperty('type')
  })

  it('v2 使用显式 stdio 类型、对象能力位，且不把 SSE 伪装成 HTTP', async () => {
    const { connection, attached, request } = await connect('v2', { stdio: {}, http: {} })
    const expected = servers.slice(0, 2)
    await connection.newSession('/workspace', servers)
    expect(attached).toEqual(expected)
    await connection.resumeSession('old', '/workspace', servers)
    expect(request.mock.calls.at(-1)).toEqual(expect.arrayContaining([
      { sessionId: 'old', cwd: '/workspace', replayFrom: { type: 'start' }, mcpServers: expected },
    ]))
  })

  it.each([undefined, null, {}, { stdio: null, http: null }])('v2 缺省或 null 能力不会发送 MCP 配置（%j）', async (caps) => {
    const { connection, attached, request } = await connect('v2', caps)
    await connection.newSession('/workspace', servers)
    expect(attached).toEqual([])
    await connection.resumeSession('old', '/workspace', servers)
    expect(request.mock.calls.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ mcpServers: [] }),
    ]))
  })

  it('v2 只声明 HTTP 时不会把 stdio 当成默认能力', async () => {
    const { connection, attached } = await connect('v2', { http: {} })
    await connection.newSession('/workspace', servers)
    expect(attached).toEqual([servers[1]])
  })
})
