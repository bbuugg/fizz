/** 防回归：运行中或新建会话期间锁住 MCP；其他标签建会话不能锁住当前空闲会话。 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentApp } from '../../shared/hooks/useAgentApp'

vi.mock('@fizz/agent-kit/features/chat/McpPicker', () => ({ McpPicker: () => null }))
import { McpSelect } from './McpSelect'

describe('McpSelect：轮次期间禁选', () => {
  it.each([
    { streaming: true, creatingConversation: false, activeConversationId: 'conv', disabled: true },
    { streaming: false, creatingConversation: true, activeConversationId: null, disabled: true },
    { streaming: false, creatingConversation: false, activeConversationId: 'conv', disabled: false },
    { streaming: false, creatingConversation: true, activeConversationId: 'conv', disabled: false },
  ])('$streaming / $creatingConversation / $activeConversationId → $disabled', ({ disabled, ...state }) => {
    const app = { ...state, mcpServers: [], mcpServerIds: [], setMcpServerIds: vi.fn() } as unknown as AgentApp

    expect(McpSelect({ app }).props.disabled).toBe(disabled)
  })
})
