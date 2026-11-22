/**
 * 工具卡抬头：**标题与图标必须同一来源**。
 *
 * ## 防的是什么
 *
 * 外部 Agent（ACP）常常不报工具名（落成占位名 `"tool"`），真正的信息在 `kind` 里。
 * 抬头文案早就按类别兜底了（「读取」/「编辑文件」……），但卡片图标只认工具名 ——
 * 于是出现「文字写『读取』、图标是扳手」。修法是把类别从抬头一路带到头部
 * （`toolCardHead` → `ToolCallCard` → `ToolHeader` → `toolHeadIcon` 的兜底档），
 * 这里钉住第一步：抬头必须**把类别一起交出来**，否则后面几跳拿不到它。
 */
import { describe, expect, it } from 'vitest'
import {
  isAwaitingApproval,
  toolCardHead,
  toolLabel,
  toolState,
  type ToolCallPart
} from './parts'

const toolCall = (toolName: string, acpKind?: string): ToolCallPart =>
  ({
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName,
    ...(acpKind ? { acpKind } : {}),
    input: {}
  }) as ToolCallPart

describe('toolCardHead · 类别随抬头一起出去', () => {
  it('ACP 工具（只有类别）：acpKind 原样带出', () => {
    expect(toolCardHead(toolCall('tool', 'read'), undefined, false).acpKind).toBe('read')
  })

  it('内置工具：没有类别就不凭空造一个', () => {
    expect(toolCardHead(toolCall('bash'), undefined, false).acpKind).toBeUndefined()
  })
})

/**
 * 待办清单工具在 2026-11 由 `todo` 改名 `todowrite`（见 `tools/todowrite.ts`）。
 *
 * 老会话历史里落的还是 `todo`：显示层两个名字都得认，否则翻旧对话时那一张清单会
 * 掉进「入参 / 结果 JSON」的兜底卡（用户报的「清单变 JSON 了」就是这个）。
 */
describe('待办清单工具名 · 新旧两个名字都认', () => {
  it('旧名 todo 仍有中文标签', () => {
    expect(toolLabel('todo')).toBe(toolLabel('todowrite'))
  })
})

/**
 * 审批挂起期间的工具卡状态。
 *
 * 防的是：工具在等审批时还没有 output，`toolState` 会算成 `input-available`（执行中），
 * 卡片上那颗转圈和「命令运行中，暂无输出」都在说「命令已经在跑」。渲染层靠
 * `isAwaitingApproval` 把这档换成「等待审批」——这里钉住映射本身：只按审批表里的
 * `toolCallId` 命中，不误伤别的工具卡。
 */
describe('isAwaitingApproval · 审批挂起按 toolCallId 命中', () => {
  it('命中：同一 toolCallId 在审批表里', () => {
    const part = toolCall('bash')
    // 它同时也是「会被误判成执行中」的那一档，这正是要修的前提
    expect(toolState(part).state).toBe('input-available')
    expect(isAwaitingApproval(part, new Set(['call-1']))).toBe(true)
  })

  it('未命中 / 没有审批现场：不误伤别的工具卡', () => {
    const part = toolCall('bash')
    expect(isAwaitingApproval(part, new Set(['call-2']))).toBe(false)
    expect(isAwaitingApproval(part, undefined)).toBe(false)
  })

  it('非 tool-call：永远不是待审批', () => {
    const part = { type: 'text', text: 'hi' } as const
    expect(isAwaitingApproval(part, new Set(['call-1']))).toBe(false)
  })
})
