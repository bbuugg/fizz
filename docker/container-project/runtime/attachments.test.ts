// 防止入库的容器运行时保留 URL 回退，导致宿主虽已改成 base64、镜像里却仍跑旧逻辑。
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type * as Conversion from '../../../packages/agent/src/model-messages'

// 只执行 bundle 内零依赖的消息转换模块，不加载容器服务、模型 SDK 或工具运行时。
const bundle = readFileSync(new URL('./runtime.mjs', import.meta.url), 'utf8')
const start = bundle.indexOf('// packages/agent/src/model-messages.ts')
const end = bundle.indexOf('// packages/agent/src/context.ts', start)
if (start < 0 || end < 0) throw new Error('容器运行时缺少消息转换模块')
const conversion = runInNewContext(
  `${bundle.slice(start, end)}\n;({ attachmentParts, createInlineBudget })`,
  { Uint8Array, atob, TextEncoder }
) as Pick<typeof Conversion, 'attachmentParts' | 'createInlineBudget'>

describe('入库容器运行时的附件行为', () => {
  it('文档提取结果是原生 text part，受文字与字节双重预算限制', async () => {
    const file = { name: 'notes.txt', mediaType: 'text/plain', url: '/api/uploads/notes.txt' }
    const budget = conversion.createInlineBudget()
    const result = await conversion.attachmentParts([file], {
      budget,
      resolveAttachment: async () => ({ kind: 'text', text: '文档内容' })
    })
    expect(result.parts).toEqual([{ type: 'text', text: '文档内容' }])
    expect(budget.remainingTextChars).toBe(100_000 - 4)
    expect(budget.remainingBytes).toBe(15 * 1024 * 1024 - 12)
    const tooLong = await conversion.attachmentParts([{ ...file, url: '/api/uploads/long.txt' }], {
      budget,
      resolveAttachment: async () => ({ kind: 'text', text: 'a'.repeat(100_000) })
    })
    expect(tooLong.parts).toEqual([])
    expect(tooLong.notes[0]).toContain('文档文字上限')
  })

  it('重复文档读取前去重，从新到旧串行解析', async () => {
    const files = ['old', 'new', 'new'].map((name) => ({ name, mediaType: 'text/plain', url: `/api/uploads/${name}.txt` }))
    const calls: string[] = []
    let active = false
    const result = await conversion.attachmentParts(files, {
      budget: conversion.createInlineBudget(),
      resolveAttachment: async (file) => {
        expect(active).toBe(false)
        active = true
        calls.push(file.name)
        await Promise.resolve()
        active = false
        return { kind: 'text', text: file.name }
      }
    })
    expect(calls).toEqual(['new', 'old'])
    expect(result.parts).toEqual([{ type: 'text', text: 'old' }, { type: 'text', text: 'new' }])
    expect(result.notes[0]).toContain('重复附件')
  })

  it('base64 图片和 PDF 还原为二进制，保留非 UTF-8 字节', async () => {
    const result = await conversion.attachmentParts([
      { name: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AID/' },
      { name: 'file.pdf', mediaType: 'application/pdf', url: 'data:application/pdf;base64,AID/' }
    ])
    expect(result.notes).toEqual([])
    expect(result.parts).toEqual([
      { type: 'image', mediaType: 'image/png', image: new Uint8Array([0, 128, 255]) },
      { type: 'file', mediaType: 'application/pdf', filename: 'file.pdf', data: new Uint8Array([0, 128, 255]) }
    ])
  })

  it.each(['/api/uploads/image.png', 'https://cdn.example/image.png'])('绝不将 %s 当模型 URL 发送', async (url) => {
    const result = await conversion.attachmentParts([{ name: 'image.png', mediaType: 'image/png', url }])
    expect(result.parts).toEqual([])
    expect(result.notes[0]).toContain('读取失败')
  })

  it('data URL 仍受整轮字节预算约束', async () => {
    const result = await conversion.attachmentParts([
      { name: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AID/' }
    ], { budget: conversion.createInlineBudget(2) })
    expect(result.parts).toEqual([])
    expect(result.notes[0]).toContain('本轮附件体积上限')
  })
})
