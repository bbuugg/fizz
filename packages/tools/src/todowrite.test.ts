/** Keep the task-list tool name, schema descriptions and status/priority fields stable. */
import { describe, expect, it } from 'vitest'
import { asSchema } from 'ai'
import { buildTodoWriteTool, TODOWRITE_DESCRIPTION } from './todowrite'

describe('todowrite', () => {
  it('保留完整行为描述和字符串 schema', async () => {
    const tool = buildTodoWriteTool()
    expect(tool.description).toBe(TODOWRITE_DESCRIPTION)
    expect(tool.description).toContain("don't batch completions")
    expect(tool.description).toContain('cancelled')
    const schema = JSON.stringify(await asSchema(tool.inputSchema).jsonSchema)
    expect(schema).toContain('Priority level of the task: high, medium, low')
    expect(schema).toContain('Brief description of the task')
    expect(schema).toContain('Current status of the task: pending, in_progress, completed, cancelled')
    expect(schema).toContain('The updated todo list')
    expect(schema).not.toContain('"enum"')
    expect(schema).toContain('"priority"')
  })
  it('原样返回整份列表，支持取消及空列表，不改写命令', async () => {
    const tool = buildTodoWriteTool()
    const todos = [{ content: ' npm run check -- --flag  ', priority: 'high', status: 'cancelled' }]
    expect(await tool.execute!({ todos }, { toolCallId: 't', messages: [], context: {} })).toEqual(todos)
    expect(await tool.execute!({ todos: [] }, { toolCallId: 't', messages: [], context: {} })).toEqual([])
  })
})
