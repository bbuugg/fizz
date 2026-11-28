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
  isDuplicateToolErrorText,
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
    expect(toolCardHead(toolCall('shell'), undefined, false).acpKind).toBeUndefined()
  })
})

/**
 * 待办清单工具在 2026-11 由 `todo` 改名 `todowrite`（见 `tools/todowrite.ts`）。
 *
 * 标签只认当前注册名；已移除的旧名与其他未知工具一样按原名兜底。
 */
describe('待办清单工具名 · 当前注册名与未知名兜底', () => {
  it('todowrite 使用中文标签，不恢复旧名 todo 的标签别名', () => {
    expect(toolLabel('todowrite')).toBe('更新待办清单')
    expect(toolLabel('todo')).toBe('todo')
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
    const part = toolCall('shell')
    // 它同时也是「会被误判成执行中」的那一档，这正是要修的前提
    expect(toolState(part).state).toBe('input-available')
    expect(isAwaitingApproval(part, new Set(['call-1']))).toBe(true)
  })

  it('未命中 / 没有审批现场：不误伤别的工具卡', () => {
    const part = toolCall('shell')
    expect(isAwaitingApproval(part, new Set(['call-2']))).toBe(false)
    expect(isAwaitingApproval(part, undefined)).toBe(false)
  })

  it('非 tool-call：永远不是待审批', () => {
    const part = { type: 'text', text: 'hi' } as const
    expect(isAwaitingApproval(part, new Set(['call-1']))).toBe(false)
  })
})

/**
 * ACP 命令失败时，过程更新里的 content 文本和最终 rawOutput 可能是同一份错误正文。
 * 前者在直显内容里、后者在统一错误块里各渲染一次；这里防止相同错误被重复展示。
 */
describe('isDuplicateToolErrorText · ACP 错误正文去重', () => {
  it('识别与最终错误输出相同的过程文本，包括嵌套 rawOutput', () => {
    expect(isDuplicateToolErrorText('permission denied', 'permission denied')).toBe(true)
    expect(isDuplicateToolErrorText('permission denied', { content: 'permission denied' })).toBe(true)
  })

  it('不隐藏与错误输出不同的过程文本', () => {
    expect(isDuplicateToolErrorText('partial stdout', { error: 'command failed' })).toBe(false)
  })
})
