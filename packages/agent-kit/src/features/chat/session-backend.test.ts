/** 回归：ACP 新对话和已有会话都允许选择 MCP，只有内置浏览器继续受后端限制。 */
import { describe, expect, it } from 'vitest'
import type { AgentApp } from '../../shared/hooks/useAgentApp'
import { composerToolbarState } from './session-backend'

describe('composerToolbarState', () => {
  it.each([null, 'conv-acp'])('ACP 的 MCP 可用，不显示内置浏览器开关（会话 %s）', (id) => {
    const app = {
      activeConversationId: id,
      conversations: [{ id: 'conv-acp', backend: 'acp' }],
      chatTarget: { backend: 'acp' },
      browserInstalled: true,
      mcpServers: [{ id: 'mcp-files' }]
    } as AgentApp

    expect(composerToolbarState(app)).toEqual({
      browser: false,
      browserPlaceholder: id === null,
      mcp: true
    })
  })

  it('已有内置会话不受草稿 ACP 目标影响', () => {
    const app = {
      activeConversationId: 'conv-builtin',
      conversations: [{ id: 'conv-builtin', backend: 'builtin' }],
      chatTarget: { backend: 'acp' },
      browserInstalled: true,
      mcpServers: [{ id: 'mcp-files' }]
    } as AgentApp

    expect(composerToolbarState(app)).toEqual({
      browser: true,
      browserPlaceholder: false,
      mcp: true
    })
  })

  it.each(['builtin', 'acp'])('没装浏览器、没配 MCP 时不占工具条高度（%s）', (backend) => {
    const app = {
      activeConversationId: null,
      conversations: [],
      chatTarget: { backend },
      browserInstalled: false,
      mcpServers: []
    } as AgentApp

    expect(composerToolbarState(app)).toEqual({
      browser: false,
      browserPlaceholder: false,
      mcp: false
    })
  })
})
