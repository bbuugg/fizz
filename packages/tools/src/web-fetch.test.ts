/**
 * 这条测试在防什么回归：**没装内置浏览器时，`web_fetch` 不该把 `engine` 这个入参暴露给模型**。
 *
 * 背景：`engine="browser"` 依赖 Playwright headless shell。早先的做法是「照挂，调用时回一句
 * 『没装，请改用 fetch』」—— 模型看到有这个选项就会先试一遍 browser 才死心，白烧一步，还把
 * 落空的失败信息灌进上下文。现在装配期现读运行时（`browserRuntimeInfo().installed`）：
 * 没装就只有 fetch 一个引擎，schema 里连字段都没有，模型无从选错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ installed: false }))

// 只替「装没装」这一个判据：真去查盘会把测试绑到跑测机器上的 ms-playwright 目录
vi.mock('./playwright-browsers', () => ({
  browserRuntimeInfo: () => ({
    installed: runtime.installed,
    path: null,
    sizeBytes: null,
    revision: null,
    downloading: false
  })
}))

import { buildWebFetchTool } from './web-fetch'

/**
 * 从 AI SDK 的 tool 定义里取入参字段名。
 * zod schema 上挂 `shape`；被转成 JSON Schema 的形态挂在 `jsonSchema.properties`。
 */
function paramNames(def: unknown): string[] {
  const schema = (def as { inputSchema?: unknown }).inputSchema as
    | { shape?: Record<string, unknown>; jsonSchema?: { properties?: Record<string, unknown> } }
    | undefined
  if (schema?.shape) return Object.keys(schema.shape)
  return Object.keys(schema?.jsonSchema?.properties ?? {})
}

/** 拿 web_fetch 那一个工具定义（`ToolSet` 的值的类型对断言没帮助，按形状取用即可） */
function webFetch(): { description: string; inputSchema: unknown } {
  return buildWebFetchTool('/tmp/ws').web_fetch as unknown as {
    description: string
    inputSchema: unknown
  }
}

describe('web_fetch 暴露几个抓取引擎', () => {
  beforeEach(() => {
    runtime.installed = false
  })

  it('没装浏览器运行时：只留 fetch 引擎，schema 里没有 engine', () => {
    const tool = webFetch()
    expect(paramNames(tool)).toEqual(['url', 'timeoutMs', 'maxChars'])
    // 描述里不能再有「设置 engine=browser」这种引导，否则模型照样会照着试
    expect(tool.description).not.toContain('engine="browser"')
  })

  it('装了浏览器运行时：engine 出现在 schema 里，描述给出两种引擎', () => {
    runtime.installed = true
    const tool = webFetch()
    expect(paramNames(tool)).toContain('engine')
    expect(tool.description).toContain('engine="browser"')
  })
})
