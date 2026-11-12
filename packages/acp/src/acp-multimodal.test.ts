/**
 * agent 回传的多模态内容（`ContentBlock::Image` → `file-part`）。
 *
 * 这条测试在防的回归：**「agent 说『图在下面』但下面什么都没有」**。
 * `agent_message_chunk` 原来只认 `type === 'text'`，图片块静默掉进 `return []`，
 * 用户侧表现为 agent 话说到一半就断了、截图 / 生成图一张都看不到。
 *
 * 同时钉住三条口径：
 * 1. 图片折成 `file` part 的素材（data URL），与用户附件同形 —— 渲染端复用同一个组件；
 * 2. `data:` 前缀重复时不能拼成 `data:data:`（少数 agent 会带前缀）；
 * 3. 超限要**说话**（一条 text-delta 说明），不能静默少一张图。
 */
import { describe, expect, it } from 'vitest'
import { toAcpStreamEvent } from './acp'

const imageUpdate = (content: Record<string, unknown>) => ({
  sessionUpdate: 'agent_message_chunk',
  content,
})

describe('toAcpStreamEvent：agent 回传图片', () => {
  it('image 块 → file-part（data URL + mimeType + 文件名）', () => {
    const events = toAcpStreamEvent(imageUpdate({
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    }))
    expect(events).toEqual([{
      type: 'file-part',
      url: 'data:image/png;base64,iVBORw0KGgo=',
      mediaType: 'image/png',
      name: 'image.png',
    }])
  })

  it('jpeg 的下载名是 .jpg', () => {
    const [event] = toAcpStreamEvent(imageUpdate({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'AAAA',
    }))
    expect(event).toMatchObject({ type: 'file-part', name: 'image.jpg' })
  })

  it('data 已带 `data:` 前缀时不重复拼接', () => {
    const [event] = toAcpStreamEvent(imageUpdate({
      type: 'image',
      mimeType: 'image/png',
      data: 'data:image/png;base64,AAAA',
    }))
    expect(event).toMatchObject({ url: 'data:image/png;base64,AAAA' })
  })

  it('不是 image/* 或缺 data 的块直接丢弃（不产生坏图）', () => {
    expect(toAcpStreamEvent(imageUpdate({ type: 'image', mimeType: 'image/png' }))).toEqual([])
    expect(toAcpStreamEvent(imageUpdate({ type: 'image', mimeType: 'text/plain', data: 'x' }))).toEqual([])
  })

  it('超过内联上限 → 一条说明，而不是一张 8MB 的图进 SSE', () => {
    const events = toAcpStreamEvent(imageUpdate({
      type: 'image',
      mimeType: 'image/png',
      data: 'a'.repeat(8 * 1024 * 1024 + 1),
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'text-delta' })
    expect(events[0]).toMatchObject({ delta: expect.stringContaining('超过内联上限') })
  })

  it('文本块仍按原样走 text-delta（没有回归）', () => {
    expect(toAcpStreamEvent(imageUpdate({ type: 'text', text: '好的' }))).toEqual([
      { type: 'text-delta', delta: '好的' },
    ])
  })
})

describe('toAcpStreamEvent：工具结果里的图片', () => {
  const toolCall = (content: unknown[]) => ({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read image',
    kind: 'read',
    status: 'completed',
    content,
  })

  it('content 里的 image 块原样保留成 acpContent（前端据此渲染缩略图）', () => {
    const [event] = toAcpStreamEvent(toolCall([
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
    ]))
    const acpContent = (event as { acpContent?: unknown[] }).acpContent
    expect(acpContent).toEqual([
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
    ])
  })

  it('超限的图换成一句说明（工具 update 会反复重发全量 content，不能每次都带 4MB+）', () => {
    const [event] = toAcpStreamEvent(toolCall([
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'a'.repeat(4 * 1024 * 1024 + 1) } },
    ]))
    const acpContent = (event as { acpContent?: { type: string; content?: { type?: string; text?: string } }[] })
      .acpContent
    expect(acpContent?.[0]).toMatchObject({ type: 'content' })
    expect(acpContent?.[0].content?.type).toBe('text')
    expect(acpContent?.[0].content?.text).toContain('超过内联上限')
  })

  it('缺 mimeType / data 的 image 块被丢弃，不产生坏图', () => {
    const [event] = toAcpStreamEvent(toolCall([
      { type: 'content', content: { type: 'image', data: 'AAAA' } },
    ]))
    expect((event as { acpContent?: unknown[] }).acpContent).toEqual([])
  })
})
