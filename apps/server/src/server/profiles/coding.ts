/**
 * 工作区 Agent 的 profile：标准装配（文件 / 命令 / web_fetch + 工作区提示词），
 * 再显式声明这一轮的能力。
 *
 * 工具插件本身（浏览器 / MCP / 客户端工具 / 磁盘插件）仍由 `chat-turn` 装配 ——
 * 它们与 run、审批通道、客户端通道耦合，属于 transport 层；本文件只负责把它们与
 * 「标准工作区能力」合成一份 `AgentAssembly`，并把能力声明收在一处。
 */
import {
  assembleStandard,
  type AgentAssembly,
  type AgentAssemblyDeps,
  type AgentSubagentOptions,
  type MountedPlugin
} from '@fizz/agent'
import { ASK_FOLLOWUP_HINT, BROWSER_PROMPT_SECTION } from '@fizz/tools'

export interface CodingProfileOptions {
  /** 这一轮额外挂的工具插件（客户端 / MCP / 浏览器 / 磁盘插件） */
  plugins: MountedPlugin[]
  /** 内置 browser_* 真的挂上了（决定提示词里要不要那段浏览器说明） */
  browser: boolean
  /** 子任务能力；不传 = 不挂派活工具 */
  subagents?: AgentSubagentOptions
}

export function buildCodingAssembly(
  deps: AgentAssemblyDeps,
  opts: CodingProfileOptions
): AgentAssembly {
  const assembly = assembleStandard({
    ...deps,
    plugins: opts.plugins,
    ...(opts.subagents ? { subagents: opts.subagents } : {}),
    // `ask` 工具这一轮恒挂（见 chat-turn 的插件装配），使用约定也随之恒在
    extraPrompt: [deps.extraPrompt, ASK_FOLLOWUP_HINT].filter(Boolean).join('\n\n')
  })
  /**
   * 浏览器说明**由挂工具的 profile 追加**，不进 `@fizz/agent` 的标准提示词：
   * 运行时不该认识「浏览器」这个具体能力，否则每加一项能力都要往核心包里塞一个开关。
   */
  if (opts.browser) assembly.instructions += '\n\n' + BROWSER_PROMPT_SECTION
  return assembly
}
