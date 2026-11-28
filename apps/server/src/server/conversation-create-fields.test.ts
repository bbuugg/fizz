/**
 * 这些用例在防什么回归：
 *
 * 用户报「新建会话时开了浏览器、勾了 MCP，消息一发出去，浏览器变回关闭、MCP 一个不剩」。
 * 根因在 `POST /api/conversations`：请求体类型里没有 `mcpServerIds` / `browserSettings`，
 * 路由只挑自己认识的那几个字段交给 `saveConversation`，于是落库的会话是「全不选 + 关」；
 * 前端那一刻是乐观改的清单项，下一次刷新被服务端那份覆盖，用户看到的就是「设置没了」。
 *
 * 所以这里钉住的是：**草稿页的两项选择必须原样进 `ConversationInput`**，以及「没给的字段
 * 不要凭空出现」（否则会覆盖会话已有的值）。
 * ACP 分叉时也必须保留权限答复策略，不能在创建映射里静默丢掉。
 */
import { describe, expect, it } from 'vitest'
import { conversationCreateFields } from './conversation-create-fields'

describe('conversationCreateFields：新建会话要落哪些字段', () => {
  it('草稿页选的 MCP 与开的浏览器必须一起落库', () => {
    const fields = conversationCreateFields({
      mcpServerIds: ['chrome-devtools', 'filesystem'],
      browserSettings: { enabled: true, channel: 'bundled' }
    })

    expect(fields.mcpServerIds).toEqual(['chrome-devtools', 'filesystem'])
    expect(fields.browserSettings).toEqual({ enabled: true, channel: 'bundled' })
  })

  it('显式的空选择保留为空数组（= 一个都不用），不能当成「没传」', () => {
    expect(conversationCreateFields({ mcpServerIds: [] }).mcpServerIds).toEqual([])
  })

  it.each(['allow', 'confirm'] as const)('ACP 分叉继承权限答复策略：%s', (acpPermissionMode) => {
    expect(conversationCreateFields({ backend: 'acp', acpPermissionMode }))
      .toEqual({ backend: 'acp', acpPermissionMode })
  })

  it('非法的 ACP 权限答复策略不进入落库参数', () => {
    expect(conversationCreateFields({ acpPermissionMode: 'invalid' as never })).toEqual({})
  })

  it('没给的字段一律不出现，免得覆盖会话已有的值', () => {
    expect(conversationCreateFields({ title: '新会话' })).toEqual({ title: '新会话' })
  })

  it('模型 / 思考强度 / 首条消息照常透传', () => {
    const fields = conversationCreateFields({
      modelId: 'gpt-5',
      reasoningEffort: 'high',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 1 }
      ]
    })

    expect(fields.modelId).toBe('gpt-5')
    expect(fields.reasoningEffort).toBe('high')
    expect(fields.messages).toHaveLength(1)
  })

})
