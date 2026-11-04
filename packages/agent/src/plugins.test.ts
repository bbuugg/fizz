/**
 * 这条测试在防什么回归：**没装内置浏览器运行时不挂 `screenshot`**。
 *
 * `screenshot` 整个工具都靠无头浏览器。挂上去只有一种结果 —— 每次调用回一句「请先去设置里
 * 装」，白占 schema 与步数，模型还会反复试。`web_fetch` 相反：永远挂（fetch 引擎不需要
 * 浏览器），要不要暴露 `engine` 由它自己判（见 tools 包的 web-fetch.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, PluginObject } from '@fizz/plugin'

const runtime = vi.hoisted(() => ({ installed: false }))

vi.mock('@fizz/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fizz/tools')>()
  return {
    ...actual,
    browserRuntimeInfo: () => ({ installed: runtime.installed }),
    // 真 builder 会拉 playwright 类型 / turndown；这里只关心「挂没挂」，替成占位对象
    buildWebFetchTool: () => ({ web_fetch: { description: 'web_fetch' } }),
    buildScreenshotTool: () => ({ screenshot: { description: 'screenshot' } })
  }
})

import { webToolsPlugin } from './plugins'

/** 收集插件 apply 期间实际登记的工具名（挂载判据只体现在这一处） */
function mounted(plugin: PluginObject): string[] {
  const names: string[] = []
  const ctx = {
    tools: {
      registerAll: (tools: Record<string, unknown>) => {
        names.push(...Object.keys(tools))
      }
    }
  }
  plugin.apply(ctx as unknown as Context, undefined)
  return names
}

describe('webToolsPlugin 的挂载判据', () => {
  beforeEach(() => {
    runtime.installed = false
  })

  it('没装浏览器运行时：只挂 web_fetch', () => {
    expect(mounted(webToolsPlugin(''))).toEqual(['web_fetch'])
  })

  it('装了浏览器运行时：web_fetch 与 screenshot 都挂', () => {
    runtime.installed = true
    expect(mounted(webToolsPlugin(''))).toEqual(['web_fetch', 'screenshot'])
  })
})
