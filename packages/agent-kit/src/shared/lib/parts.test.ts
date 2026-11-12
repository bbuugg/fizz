/**
 * `toolCardHead` 的头部组装规则。
 *
 * 防的回归：
 * ① `execute_command` 的命令明细被当成「与结果正文重复的噪音」摘掉 —— 头部必须保留
 * `$ 命令`（挤不下就截断 + Tooltip，别让它消失），否则折叠状态下完全看不出跑的什么；
 * ② 有意图时明细丢了工具名 —— 「为什么」和「用什么干的」得同时看得到。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart, AgentStreamEvent } from '@fizz/contracts/types'
import {
  applyEvent,
  coalescePartFragments,
  isStoppableToolName,
  toolCardHead,
  toolCardTitle,
  type ToolCallPart
} from './parts'

/** 造一个最小的 tool-call part（只填头部用得上的字段） */
const call = (toolName: string, input: Record<string, unknown> = {}): ToolCallPart =>
  ({ type: 'tool-call', toolCallId: 'call-1', toolName, input }) as ToolCallPart

describe('toolCardHead', () => {
  it('execute_command 的命令进明细（无意图时与工具名并列）', () => {
    expect(toolCardHead(call('execute_command'), '$ npm run dev')).toEqual({
      title: '执行命令',
      detail: '$ npm run dev'
    })
  })

  it('execute_command 有意图时：意图当标题，明细是「工具名 · 命令」', () => {
    const head = toolCardHead(call('execute_command', { intent: '启动开发服务器' }), '$ npm run dev')
    expect(head.title).toBe('启动开发服务器')
    expect(head.detail).toBe('执行命令 · $ npm run dev')
  })

  it('终端工具同口径（命令进明细）', () => {
    const head = toolCardHead(call('run_in_terminal'), '$ pnpm test')
    expect(head.title).toBe(toolCardTitle('run_in_terminal'))
    expect(head.detail).toBe('$ pnpm test')
  })

  it('文件类工具：无意图时明细是路径，有意图时拼成「工具名 · 路径」', () => {
    expect(toolCardHead(call('read_file'), 'src/parts.ts')).toEqual({
      title: toolCardTitle('read_file'),
      detail: 'src/parts.ts'
    })
    expect(toolCardHead(call('read_file', { intent: '看实现' }), ' src/parts.ts ').detail).toBe(
      `${toolCardTitle('read_file')} · src/parts.ts`
    )
  })

  it('关掉「工具意图」开关：标题回到工具名，明细仍是明细', () => {
    expect(toolCardHead(call('execute_command', { intent: '启动开发服务器' }), '$ npm run dev', false)).toEqual(
      { title: '执行命令', detail: '$ npm run dev' }
    )
  })
})

/**
 * 派活工具（`agent-<id>`）也能单条停止。
 *
 * 防的回归：判据被收紧回 `STOPPABLE_TOOLS.has(...)` —— 那样所有派活卡的停止钮都会消失，
 * 而且不会有任何地方报错（服务端照样登记了 stop，只是前端不给入口）。
 */
describe('isStoppableToolName', () => {
  it('命令 / 抓取 / 派活都算，普通工具不算', () => {
    expect(isStoppableToolName('execute_command')).toBe(true)
    expect(isStoppableToolName('web_fetch')).toBe(true)
    // 前缀判定，不依赖具体 id：新增的 SubagentId 自动就有停止钮
    expect(isStoppableToolName('agent-explorer')).toBe(true)
    expect(isStoppableToolName('read_file')).toBe(false)
  })
})

/**
 * 增量合并 / 老数据收敛。
 *
 * 防的回归：ACP 侧（以及部分网关）把思考与正文**交替**流出来时，parts 又退化成一堆几字长的
 * 碎片 —— 界面上表现为一串「思考过程」分组 + 被拆碎的段落，看着像解析错乱；整轮结束后
 * 除最后那一小段正文，其余全被收进折叠条。
 */
describe('applyEvent 的增量合并', () => {
  it('思考与正文交替流出时各自收成一条', () => {
    let parts: AgentMessagePart[] = []
    const events: AgentStreamEvent[] = [
      { type: 'reasoning-delta', delta: '想' },
      { type: 'text-delta', delta: '正' },
      { type: 'reasoning-delta', delta: '一' },
      { type: 'text-delta', delta: '文' }
    ]
    for (const event of events) parts = applyEvent(parts, event)
    expect(parts).toEqual([
      { type: 'reasoning', text: '想一' },
      { type: 'text', text: '正文' }
    ])
  })

  it('不原地改入参数组（上一帧的快照不能被污染）', () => {
    const parts: AgentMessagePart[] = [{ type: 'text', text: 'a' }]
    const next = applyEvent(parts, { type: 'text-delta', delta: 'b' })
    expect(parts).toEqual([{ type: 'text', text: 'a' }])
    expect(next).toEqual([{ type: 'text', text: 'ab' }])
  })
})

describe('coalescePartFragments', () => {
  it('把交替落成的碎片合并回「一条思考 + 一条正文」，并给出新→原下标', () => {
    const { parts, originIndex } = coalescePartFragments([
      { type: 'reasoning', text: '想' },
      { type: 'text', text: '正' },
      { type: 'reasoning', text: '一' },
      { type: 'text', text: '文' }
    ])
    expect(parts).toEqual([
      { type: 'reasoning', text: '想一' },
      { type: 'text', text: '正文' }
    ])
    expect(originIndex).toEqual([0, 1])
  })

  it('工具卡是边界：跨过它不合并，下标原样', () => {
    const { parts, originIndex } = coalescePartFragments([
      { type: 'text', text: '动手前' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: {} },
      { type: 'text', text: '看到了' }
    ])
    expect(parts.map((part) => part.type)).toEqual(['text', 'tool-call', 'text'])
    expect(originIndex).toEqual([0, 1, 2])
  })
})

describe('applyEvent：agent 回传图片', () => {
  const image: AgentStreamEvent = {
    type: 'file-part',
    url: 'data:image/png;base64,AAAA',
    mediaType: 'image/png',
    name: 'image.png'
  }

  it('file-part 折成 file part（与用户附件同形）', () => {
    expect(applyEvent([], image)).toEqual([
      { type: 'file', name: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }
    ])
  })

  it('图片之后的文本另起一段，不会并到图片前面', () => {
    const parts = applyEvent(applyEvent([{ type: 'text', text: '截图：' }], image), {
      type: 'text-delta',
      delta: '看到了'
    })
    expect(parts.map((part) => part.type)).toEqual(['text', 'file', 'text'])
    expect(parts[0]).toMatchObject({ type: 'text', text: '截图：' })
  })
})
