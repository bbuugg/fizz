/**
 * 把 `CoreData.prefs`（字符串表，见 `@fizz/contracts` 的 `PREF_KEYS`）解析成服务端要用的
 * 类型化一份，**给不经过渲染端的链路用**：定时任务（`scheduler.ts`）、项目助手
 * （`assistant-turn.ts`）、主会话（`chat-turn.ts`）的缺省值。
 *
 * ## 为什么服务端要自己读，而不是信请求体
 *
 * 这几个值（重试次数 / 步数上限 / 工具并发 / 工具意图 / 审批超时 / 权限档）是 **agent 循环
 * 真正读取的语义**。客户端请求体里带的只是「本次会话的覆盖」，而**定时任务不经过任何
 * 渲染端**（`scheduler.ts` 直接 `startTurn`）—— 以前它们拿不到用户填的值，只能吃
 * `runAgent` 的缺省。现在服务端有一份权威副本，这条缝就补上了。
 *
 * 请求体仍然优先（兼容旧客户端、也允许会话级覆盖），见 `chat-turn.ts` 的 `input.xxx ?? prefs.xxx`。
 *
 * ⚠️ 这里只读、不写：写入只有 `POST /api/prefs` 一条路（`domain.savePrefs`）。
 */
import type { AiPermissionMode, CommandSandboxMode } from '@fizz/contracts/types'
import { domain } from './state'

/** 服务端执行语义相关的偏好（已归一化：数字一定在合法区间、枚举一定在集合内） */
export interface ServerAgentPrefs {
  permissionMode: AiPermissionMode
  /** 命令沙箱：off / workspace-write（没有可用后端的平台由工具层 fail closed） */
  sandboxMode: CommandSandboxMode
  /** 审批超时（毫秒）；0 = 一直等 */
  confirmTimeoutMs: number
  maxRetries: number
  maxSteps: number
  toolCallConcurrency: number
  toolIntent: boolean
}

export function agentPrefs(): ServerAgentPrefs {
  const prefs = domain.getPrefs()
  return {
    permissionMode: prefs['fizz.web.permissionMode'] as AiPermissionMode,
    sandboxMode: prefs['fizz.web.sandboxMode'] as CommandSandboxMode,
    // 前端存的是**分钟**（设置页的输入单位），这里换成毫秒给 confirm-gate
    confirmTimeoutMs: Number(prefs['fizz.web.confirmTimeout']) * 60_000,
    maxRetries: Number(prefs['fizz.web.maxRetries']),
    maxSteps: Number(prefs['fizz.web.maxSteps']),
    toolCallConcurrency: Number(prefs['fizz.web.toolCallConcurrency']),
    toolIntent: prefs['fizz.web.toolIntent'] === '1'
  }
}
