/**
 * 工具动作解释器:把「流里的项目管理工具调用」翻译成前端 UI 动作。
 *
 * 用户诉求:「前端收到调用某个工具后要做一些动作,比如刷新项目列表」。
 * - **数据刷新**不走这里:工具改了领域数据,`makeLiveStore` 自动标脏,state-ws 推
 *   `workspaces` / `conversations` 快照,列表自动更新(零前端代码);
 * - 这里只负责**显式动作**(打开项目要切工作区 + 跳页;建好会话要把那个会话打开) ——
 *   会话切片(`conversation.ts`)与助手切片(`assistant.ts`)收到 event 帧后跑一遍本文件,
 *   把动作经 `window` CustomEvent 广播出去,由 app-shell 全局订阅执行。
 *
 * 选前端解释器而不是新增 ServerEvent 通道:最贴合「收到工具调用 → 做动作」,且零服务端
 * 新通道(两个消费场景都在发这条流的页面里)。
 */
import type { AgentStreamEvent } from '@fizz/contracts/types'
import { APP_EVENTS } from '@fizz/agent-kit/shared/lib/app-events'

export type ProjectUiAction =
  | { action: 'open-workspace'; workspaceId: string }
  | { action: 'project-created'; workspaceId: string }
  | {
      action: 'conversation-created'
      conversationId: string
      workspaceId: string
      /** 预填到输入框的提示词（create_conversation 的 prompt 参数回传；没有就不填） */
      prompt?: string
    }
  /**
   * Agent 动用了浏览器（`browser_*` 工具，除 `browser_close`）：把该会话右侧的
   * 浏览器画面面板挂出来。带 conversationId 是为了让收方只在「正看的那个会话」
   * 里动作 —— 后台会话用浏览器不该把当前会话的面板抢出来。
   *
   * ⚠️ 这里只能按**工具名**判，而外部 playwright-mcp 与内置这套**完全同名**：光看名字
   * 分不出是谁在开浏览器。所以收方要再复核「这个会话真开了内置浏览器」才挂面板
   * （见 app-shell 的第三道闸）。
   */
  | { action: 'browser-active'; conversationId: string }

/** 只认这三个工具的结果;其余工具(哪怕成功)不触发任何 UI 动作 */
const PROJECT_ACTION_TOOLS = new Set(['open_project', 'create_project', 'create_conversation'])

/**
 * 「用了浏览器」的工具判定。排除 `browser_close`：那是收尾动作，没有画面要看，
 * 弹面板反而多余。用前缀判而不是白名单，新增 browser_* 工具时自动跟上。
 *
 * ⚠️ 前缀会**连带外部 MCP**：playwright-mcp 的工具同样叫 `browser_navigate` /
 * `browser_click`，它并不驱动内置浏览器（面板会空着）。因此这条判定只是「可能是浏览器」，
 * 真挂面板前收方还要确认这个会话开了内置浏览器。
 */
function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith('browser_') && toolName !== 'browser_close'
}

/**
 * 从工具结果里抠 id。工具结果在流里的形状可能有几层包装
 * (字符串 JSON / {output: 字符串} / 已解析的对象),逐层剥开,拿不到就当没有。
 */
function extractTargets(
  output: unknown
): { workspaceId: string | null; conversationId: string | null; prompt: string | null } {
  let candidate: unknown = output
  if (
    candidate &&
    typeof candidate === 'object' &&
    'output' in (candidate as Record<string, unknown>)
  ) {
    candidate = (candidate as Record<string, unknown>).output
  }
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return { workspaceId: null, conversationId: null, prompt: null }
    }
  }
  const id = (key: string): string | null => {
    const value = (candidate as Record<string, { id?: unknown }> | null)?.[key]?.id
    return typeof value === 'string' && value ? value : null
  }
  // 提示词是 create_conversation 的**顶层**字段（不是 conversation 对象里的），单独抠
  const rawPrompt = (candidate as Record<string, unknown> | null)?.prompt
  const prompt = typeof rawPrompt === 'string' && rawPrompt.trim() ? rawPrompt.trim() : null
  return { workspaceId: id('workspace'), conversationId: id('conversation'), prompt }
}

/**
 * 流事件 → UI 动作清单(通常 0 或 1 条)。
 *
 * `conversationId` = 这条流所属的会话（收方据此判断「是不是当前正看的会话」）。
 * 浏览器动作需要它；其余动作自带 id，不传也能照常工作。
 */
export function uiActionsFromEvent(
  event: AgentStreamEvent,
  sourceConversationId?: string
): ProjectUiAction[] {
  if (event.type !== 'tool-result' || event.isError) return []
  // 浏览器工具：Agent 一开浏览器就挂出画面面板（重复触发由收方去重，见 app-shell）
  if (isBrowserTool(event.toolName)) {
    return sourceConversationId ? [{ action: 'browser-active', conversationId: sourceConversationId }] : []
  }
  if (!PROJECT_ACTION_TOOLS.has(event.toolName)) return []
  const { workspaceId, conversationId, prompt } = extractTargets(event.output)
  if (event.toolName === 'create_conversation') {
    if (!workspaceId || !conversationId) return []
    return [{ action: 'conversation-created', conversationId, workspaceId, ...(prompt ? { prompt } : {}) }]
  }
  if (!workspaceId) return []
  return [
    {
      action: event.toolName === 'open_project' ? 'open-workspace' : 'project-created',
      workspaceId
    }
  ]
}

/** 广播一条 UI 动作(消费方在 app-shell 里 addEventListener) */
export function dispatchProjectUiAction(action: ProjectUiAction): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(APP_EVENTS.uiAction, { detail: action }))
}
