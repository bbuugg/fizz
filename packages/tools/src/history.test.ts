/** 防止压缩后的证据无法分页找回，或检索工具接受跨会话访问参数。 */
import { describe, expect, it } from 'vitest'
import { buildHistoryTools, summarizeToolEvidence } from './history'
import type { AgentChatMessage } from '@fizz/contracts/types'

const history: AgentChatMessage[] = [{ id: 'a1', role: 'assistant', createdAt: 1, parts: [
  { type: 'text', text: '修改完成，未验证' },
  { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { command: 'typecheck' },
    output: `${'x'.repeat(9000)}TS2322` }
] }]
const options = { toolCallId: 'test', messages: [] }

describe('会话证据工具', () => {
  it('长命令日志保留中段错误与尾部退出状态，且不超预算', () => {
    const text = `${'start\n'.repeat(1000)}error TS2322: incompatible type\n${'noise\n'.repeat(1000)}[exit code: 1]`
    const summary = summarizeToolEvidence('bash', text, 2000)
    expect(summary).toContain('error TS2322')
    expect(summary).toContain('[exit code: 1]')
    expect(summary.length).toBeLessThanOrEqual(2000)
    expect(summarizeToolEvidence('read', 'short')).toBe('short')
  })
  it('按字面搜索尾部错误并返回原始来源', async () => {
    const tools = buildHistoryTools(history)
    const matches = await tools.history_search.execute!({ query: 'ts2322', limit: 10 }, options)
    if (!Array.isArray(matches)) throw new Error('Expected search results')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ messageId: 'a1', toolCallId: 't1' })
    expect(matches[0]!.excerpt).toContain('TS2322')
  })

  it('按工具 id 分页读取，并拒绝当前历史之外的 id', async () => {
    const tools = buildHistoryTools(history)
    const first = await tools.history_read.execute!({ messageId: 'a1', toolCallId: 't1', offset: 0, limit: 100 }, options)
    expect(first).toMatchObject({ offset: 0, nextOffset: 100 })
    const missing = await tools.history_read.execute!({ messageId: 'other-conversation', offset: 0, limit: 100 }, options)
    expect(missing).toHaveProperty('error')
  })

  it('动态证据源在本轮工具完成后可见，不复用首次搜索的旧缓存', async () => {
    const live: AgentChatMessage[] = []
    const tools = buildHistoryTools(() => live)
    expect(await tools.history_search.execute!({ query: 'TS2322', limit: 10 }, options)).toEqual([])
    live.push(...history)
    const result = await tools.history_search.execute!({ query: 'TS2322', limit: 10 }, options)
    expect(result).toHaveLength(1)
  })

  it('只用稳定工具调用 id 找回跨轮落盘后的证据', async () => {
    const tools = buildHistoryTools(history)
    const result = await tools.history_read.execute!({ toolCallId: 't1', offset: 9000, limit: 1000 }, options)
    expect(result).toMatchObject({ messageId: 'a1', toolCallId: 't1', nextOffset: null })
    expect(result).toHaveProperty('text', expect.stringContaining('TS2322'))
    expect(await tools.history_read.execute!({ offset: 0, limit: 100 }, options)).toHaveProperty('error')
  })
})
