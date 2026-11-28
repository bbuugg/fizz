/**
 * 一轮对话「过程分组」的抬头口径（`turn-step.ts`）。
 *
 * 防的回归：
 * ① 整轮还没结束就报「已工作 N 秒」（那个数每秒都在变，抬头看不出在干什么）；
 * ② 左格按工具类型写死成「执行命令中…」/「正在执行『X』…」，模型填的 `intent` 被吞掉 ——
 *    那正是「这一步到底在干什么」最具体的一句话，用户看到的却是一行空话；
 * ③ 右格（内容预览）取错了东西：思考该跟最后一行、命令该带 `$` 前缀、路径该原样；
 *    流式入参（`inputText` 半截 JSON）也得认得，否则跑命令时右格一直是空的；
 * ④ 等用户作答的提问卡被当成「正在执行」，抬头一直转圈（那一轮其实在等人）；
 * ⑤ 耗时的取整 / 进位跑偏（0ms 显示成「0 秒」、119.6s 少算一分钟）。
 */
import { describe, expect, it } from 'vitest'
import {
  formatWorkDuration,
  isStepInFlight,
  turnStepActivity,
  turnStepPreview,
  turnStepSummary,
  workDurationLabel
} from './turn-step'
import { ASK_FOLLOWUP_TOOL, toolCardTitle, type ToolCallPart } from './parts'
import type { AgentMessagePart } from '@fizz/contracts/types'

/** 造一个最小的 tool-call part（只填抬头判定用得上的字段） */
const call = (toolName: string, extra: Partial<ToolCallPart> = {}): AgentMessagePart =>
  ({ type: 'tool-call', toolCallId: 'call-1', toolName, input: {}, ...extra }) as ToolCallPart

const reasoning = (text = '先看看实现'): AgentMessagePart => ({ type: 'reasoning', text })

describe('turnStepSummary', () => {
  it('按类型计数，提问单独算', () => {
    expect(
      turnStepSummary([
        reasoning(),
        call('read'),
        call('shell'),
        call(ASK_FOLLOWUP_TOOL)
      ])
    ).toBe('思考 ×1 · 工具调用 ×2 · 提问 ×1')
  })

  it('空数组 / 只有正文时兜底成「执行过程」', () => {
    expect(turnStepSummary([])).toBe('执行过程')
    expect(turnStepSummary([{ type: 'text', text: '结论' }])).toBe('执行过程')
  })
})

describe('isStepInFlight', () => {
  it('思考 / 还没拿到结果的工具算在跑', () => {
    expect(isStepInFlight(reasoning())).toBe(true)
    expect(isStepInFlight(call('shell'))).toBe(true)
  })

  it('拿到结果、等用户作答、正文都不算在跑', () => {
    expect(isStepInFlight(call('shell', { output: '退出码 0' }))).toBe(false)
    expect(isStepInFlight(call(ASK_FOLLOWUP_TOOL))).toBe(false)
    expect(isStepInFlight({ type: 'text', text: '结论' })).toBe(false)
  })
})

describe('turnStepActivity（左格：最后做的那件事）', () => {
  it('思考：还在跑才说「思考中…」，落地后只说「思考过程」', () => {
    expect(turnStepActivity([reasoning()], { active: true })).toBe('思考中…')
    // 落地（模型已经转去写正文 / 整轮结束）还写「思考中…」= 看上去像卡住了
    expect(turnStepActivity([reasoning()])).toBe('思考过程')
    expect(turnStepActivity([])).toBe('思考过程')
  })

  it('工具报模型填的 intent（跑没跑完都是同一句话）', () => {
    const running = call('shell', { input: { command: 'pnpm test', intent: '跑一下单测' } })
    const done = call('shell', {
      input: { command: 'pnpm test', intent: '跑一下单测' },
      output: '退出码 0'
    })
    expect(turnStepActivity([running])).toBe('跑一下单测')
    expect(turnStepActivity([done])).toBe('跑一下单测')
  })

  it('没有 intent 退回工具名（命令类不再是「执行命令中…」）', () => {
    expect(turnStepActivity([call('shell', { input: { command: 'pnpm test' } })])).toBe(
      toolCardTitle('shell')
    )
    expect(turnStepActivity([call('read', { input: { file_path: 'a.ts' }, output: 'ok' })])).toBe(
      toolCardTitle('read')
    )
    expect(turnStepActivity([call(ASK_FOLLOWUP_TOOL)])).toBe(toolCardTitle(ASK_FOLLOWUP_TOOL))
  })

  it('关掉「工具意图」开关：历史里的 intent 也不显示（与工具卡同一开关）', () => {
    const part = call('read', { input: { file_path: 'a.ts', intent: '看看落盘' } })
    expect(turnStepActivity([part])).toBe('看看落盘')
    expect(turnStepActivity([part], { showIntent: false })).toBe(toolCardTitle('read'))
  })

  it('只看最后一步：前面的历史不影响抬头', () => {
    expect(
      turnStepActivity([reasoning(), call('read', { output: 'ok' }), reasoning('再想想')], {
        active: true
      })
    ).toBe('思考中…')
    expect(
      turnStepActivity([
        reasoning(),
        call('read', { output: 'ok' }),
        call('shell', { input: { command: 'ls', intent: '列一下目录' } })
      ])
    ).toBe('列一下目录')
  })
})

describe('turnStepPreview（右格：这一步的内容）', () => {
  const lastLine = '第一行\n**第二**行 `x`'

  it('思考取最后一行，并剥掉 markdown 记号', () => {
    expect(turnStepPreview([reasoning(lastLine)])).toEqual({
      text: '第二行 x',
      lineKey: lastLine.lastIndexOf('\n')
    })
  })

  it('命令压成一行并带 $ 前缀（与工具卡内容区同一写法）', () => {
    expect(turnStepPreview([call('shell', { input: { command: 'pnpm test\n  && echo hi' } })])).toEqual({
      text: '$ pnpm test && echo hi',
      lineKey: -1
    })
  })

  it('文件类工具报路径、搜索类报搜索词', () => {
    expect(turnStepPreview([call('read', { input: { file_path: 'src/parts.ts' } })])).toEqual({
      text: 'src/parts.ts',
      lineKey: -1
    })
    expect(turnStepPreview([call('grep', { input: { pattern: 'compactHistory' } })])).toEqual({
      text: 'compactHistory',
      lineKey: -1
    })
  })

  it('编辑文件也要报路径（内置 file_path / ACP 的 filePath 两种形状）', () => {
    expect(
      turnStepPreview([
        call('edit', { input: { file_path: 'src/parts.ts', old_string: 'a', new_string: 'b' } })
      ])
    ).toEqual({ text: 'src/parts.ts', lineKey: -1 })
    expect(
      turnStepPreview([
        call('edit', { input: { filePath: 'packages/agent/src/engine.ts', oldString: 'a', newString: 'b' } })
      ])
    ).toEqual({ text: 'packages/agent/src/engine.ts', lineKey: -1 })
  })

  it('入参只给了 ACP title 时用它兜底（否则编辑文件抬头右侧是空的）', () => {
    expect(turnStepPreview([call('edit', { input: {}, title: 'src/app/app-shell.tsx' })])).toEqual({
      text: 'src/app/app-shell.tsx',
      lineKey: -1
    })
  })

  it('尾巴是孤儿 tool-result 时，往前找最近一条有内容的 tool-call', () => {
    expect(
      turnStepPreview([
        call('read', { input: { file_path: 'README.md' }, output: 'ok' }),
        { type: 'tool-result', toolCallId: 'orphan', toolName: 'read', output: 'ok' }
      ] as AgentMessagePart[])
    ).toEqual({ text: 'README.md', lineKey: -1 })
  })

  it('入参还在流式生成（inputText 半截 JSON）也要认得', () => {
    expect(
      turnStepPreview([call('shell', { inputText: '{"command": "pnpm test", "path": ' })])
    ).toEqual({ text: '$ pnpm test', lineKey: -1 })
  })

  it('没有可看的内容就是 undefined（抬头只留名字）', () => {
    expect(turnStepPreview([])).toBeUndefined()
    expect(turnStepPreview([reasoning('   ')])).toBeUndefined()
    expect(turnStepPreview([call('todowrite', { input: { todos: [] } })])).toBeUndefined()
  })

  it('长命令保留完整文本以支持横向滚动查看', () => {
    const command = `node ${'long-file-name'.repeat(30)}.js`
    expect(turnStepPreview([call('shell', { input: { command } })]))
      .toEqual({ text: `$ ${command}`, lineKey: -1 })
  })
})

describe('formatWorkDuration / workDurationLabel', () => {
  it('不足 1 秒按 1 秒算（不显示「0 秒」）', () => {
    expect(formatWorkDuration(0)).toBe('1 秒')
    expect(formatWorkDuration(900)).toBe('1 秒')
  })

  it('秒 / 分 / 分秒三档', () => {
    expect(formatWorkDuration(12_400)).toBe('12 秒')
    expect(formatWorkDuration(65_000)).toBe('1 分 5 秒')
    expect(formatWorkDuration(120_000)).toBe('2 分')
  })

  it('抬头是「已工作 …」', () => {
    expect(workDurationLabel(65_000)).toBe('已工作 1 分 5 秒')
  })
})
