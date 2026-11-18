/**
 * `withToolIntent` 的断言（工具卡标题的来源）。
 *
 * 这里要守的三件事，任何一条回归都会**静默失效**（界面上只是又变回「执行命令」）：
 * 1. `intent` 排在 schema **第一位** —— 入参是流式生成的，排后面标题就会等整段 JSON 收完才跳；
 * 2. 校验之后 `intent` **还在** —— zod 默认 strip 未知字段，不补回去 `tool-call` 的 input 里就没有它；
 * 3. 原 schema 是 `.strict()` 时**不能因为多出 intent 就校验失败**（校验前先摘掉）。
 */
import { describe, expect, it } from 'vitest'
import { asSchema, jsonSchema, tool } from 'ai'
import { z } from 'zod'
import { assembleStandard } from './agent'
import { TOOL_INTENT_FIELD, withToolIntent } from './engine'

/** 取注入后的 JSON Schema（`jsonSchema` 可能是 PromiseLike，统一 await） */
async function schemaOf(entry: unknown) {
  const schema = asSchema((entry as { inputSchema: never }).inputSchema)
  return schema.jsonSchema as Awaited<typeof schema.jsonSchema>
}

describe('withToolIntent', () => {
  it('把 intent 放在 schema 第一位并标记必填', async () => {
    const tools = await withToolIntent({
      write: tool({
        description: 'x',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async () => 'ok'
      })
    })
    const json = await schemaOf(tools.write)
    expect(Object.keys(json.properties ?? {})[0]).toBe(TOOL_INTENT_FIELD)
    expect(json.required?.[0]).toBe(TOOL_INTENT_FIELD)
    // 原字段一个不少
    expect(Object.keys(json.properties ?? {})).toEqual([TOOL_INTENT_FIELD, 'path', 'content'])
  })

  it('校验后 intent 仍在入参里（原字段照旧解析）', async () => {
    const tools = await withToolIntent({
      write: tool({
        description: 'x',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => 'ok'
      })
    })
    const parsed = await asSchema(
      (tools.write as { inputSchema: never }).inputSchema
    ).validate!({ [TOOL_INTENT_FIELD]: '  修复类型错误  ', path: 'a.ts' })
    expect(parsed.success).toBe(true)
    expect(parsed).toMatchObject({ value: { [TOOL_INTENT_FIELD]: '修复类型错误', path: 'a.ts' } })
  })

  it('原 schema 是 strict 时，多出来的 intent 不会让校验失败', async () => {
    const tools = await withToolIntent({
      strict_tool: tool({
        description: 'x',
        inputSchema: z.object({ path: z.string() }).strict(),
        execute: async () => 'ok'
      })
    })
    const parsed = await asSchema(
      (tools.strict_tool as { inputSchema: never }).inputSchema
    ).validate!({ [TOOL_INTENT_FIELD]: '看一眼', path: 'a.ts' })
    expect(parsed.success).toBe(true)
  })

  it('没有入参的工具（z.object({})）也能拿到 intent', async () => {
    const tools = await withToolIntent({
      open_project: { description: 'x', inputSchema: z.object({}), execute: async () => 'ok' }
    })
    const json = await schemaOf(tools.open_project)
    expect(json.properties?.[TOOL_INTENT_FIELD]).toBeDefined()
    expect(json.required).toContain(TOOL_INTENT_FIELD)
  })

  it('已经是 JSON Schema 的工具（MCP 那一路）同样被注入', async () => {
    const tools = await withToolIntent({
      mcp_tool: {
        description: 'x',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { query: { type: 'string' } },
          additionalProperties: false
        }),
        execute: async () => 'ok'
      }
    })
    const json = await schemaOf(tools.mcp_tool)
    expect(Object.keys(json.properties ?? {})).toEqual([TOOL_INTENT_FIELD, 'query'])
  })

  it('模型漏填 intent 时校验照样通过（界面退回工具名当标题）', async () => {
    const tools = await withToolIntent({
      write: tool({
        description: 'x',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => 'ok'
      })
    })
    const parsed = await asSchema(
      (tools.write as { inputSchema: never }).inputSchema
    ).validate!({ path: 'a.ts' })
    expect(parsed.success).toBe(true)
  })
})

describe('工具意图开关（设置 → AI → 通用）', () => {
  // 未绑定目录的会话：提示词走「只能对话」那一支，装配代价最小，但约定照样追加
  const base = {
    workspace: { id: 'w', name: 'w', path: '', createdAt: 0, updatedAt: 0 },
    skills: []
  }

  it('默认把「每次调用都要填 intent」写进提示词', () => {
    expect(assembleStandard(base).instructions).toContain('`intent`')
  })

  it('关掉后提示词里不再提 intent（schema 里也没有这个字段，不能让模型去填）', () => {
    expect(assembleStandard({ ...base, toolIntent: false }).instructions).not.toContain('`intent`')
  })
})
