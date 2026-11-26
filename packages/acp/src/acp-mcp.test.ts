/** 防回归：聊天、恢复回放、切档激活和 load 失败兜底均不能丢失 MCP；全部使用假进程/连接。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AcpConnection, AcpMcpServer, AcpTurnSource } from './protocol/types'
import type { RunAcpAgentOptions } from './acp'

const mock = vi.hoisted(() => ({ connection: null as unknown as AcpConnection }))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  })),
}))
vi.mock('./protocol', async (importOriginal) => ({
  ...await importOriginal<typeof import('./protocol')>(),
  resolveAcpFactory: () => ({ connect: async () => mock.connection }),
}))

import { disposeAcpSessions, replayAcpSession, runAcpAgent, setAcpSessionMode } from './acp'

const servers: AcpMcpServer[] = [{
  type: 'http', name: 'docs', url: 'https://example.com/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer secret' }],
}]
const agent = { id: 'agent', name: 'Agent', command: 'mock-agent', args: [] }
const options: RunAcpAgentOptions = {
  agent, conversationId: 'conversation', requestId: 'request', mcpServers: servers,
  workspace: { id: 'workspace', name: 'Workspace', path: '/workspace', createdAt: 0, updatedAt: 0 },
  history: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: 0 }],
}

beforeEach(() => {
  const source: AcpTurnSource = {
    sessionId: 'session', prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => ({ kind: 'stop' as const, stopReason: 'end_turn' })),
    drainAll: vi.fn(() => []),
  }
  const result = { source, configOptions: null, modes: null }
  mock.connection = {
    version: 'v1',
    initialize: vi.fn(async () => ({
      promptImage: null, canList: false, canDelete: false, canFork: false,
      canClose: false, canCancel: true, authMethods: [],
    })),
    newSession: vi.fn(async () => result), resumeSession: vi.fn(async () => result),
    forkSession: vi.fn(async () => result), closeSession: vi.fn(), cancelTurn: vi.fn(),
    setConfigOption: vi.fn(), setMode: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(),
    login: vi.fn(), logout: vi.fn(), close: vi.fn(),
  }
})
afterEach(() => { disposeAcpSessions(); vi.restoreAllMocks() })

describe('ACP 会话引擎 MCP 链路', () => {
  it('新建传入 MCP；后续轮次复用活会话，不做热更新', async () => {
    expect((await runAcpAgent(options)).finishReason).toBe('done')
    expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
    await runAcpAgent({ ...options, mcpServers: [] })
    expect(mock.connection.newSession).toHaveBeenCalledTimes(1)
    expect(mock.connection.resumeSession).not.toHaveBeenCalled()
  })

  it('恢复会话传入 MCP', async () => {
    expect((await runAcpAgent({ ...options, loadSessionId: 'old' })).finishReason).toBe('done')
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
    expect(mock.connection.newSession).not.toHaveBeenCalled()
  })

  it('恢复失败退回新建时保留同一份 MCP', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(mock.connection.resumeSession).mockRejectedValueOnce(new Error('not supported'))
    expect((await runAcpAgent({ ...options, loadSessionId: 'old' })).finishReason).toBe('done')
    expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
  })

  it('打开会话/重启所用的回放入口透传 MCP', async () => {
    await replayAcpSession({ agent, conversationId: 'conversation', workspacePath: '/workspace', sessionId: 'old', mcpServers: servers })
    expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
  })

  it.each([undefined, 'old'])('切档自动激活也携带 MCP（绑定会话：%s）', async (loadSessionId) => {
    await setAcpSessionMode(agent.id, 'conversation', 'mode', {
      agent, workspacePath: '/workspace', loadSessionId, mcpServers: servers,
    })
    if (loadSessionId) {
      expect(mock.connection.resumeSession).toHaveBeenCalledWith('old', '/workspace', servers)
    } else {
      expect(mock.connection.newSession).toHaveBeenCalledWith('/workspace', servers)
    }
  })
})
