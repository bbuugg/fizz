/**
 * 终端助手 profile：挂在某一条终端标签上的会话。
 *
 * 与项目管理助手是**两套身份**：这里刻意不出现任何项目管理内容 —— 那条会话绑定的是
 * 某一条终端，模型的任务是「看输出、跑命令」。项目能力在装配层就整组缺席。
 */
import { rawToolsPlugin, type AgentAssembly } from '@fizz/agent'

/** 终端助手的一轮装配输入 */
export interface TerminalAssistantDeps {
  /** 客户端声明并实现、由服务端转发执行的终端工具 */
  tools: Record<string, unknown>
  /** 同批工具的元信息（用来在提示词里列出可用能力） */
  specs: Array<{ name: string; description: string }>
}

export function buildTerminalAssistantInstructions(): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return [
    '你是 Fizz 的终端助手，挂在一个终端标签上，服务的是**这个终端**。',
    `当前时间：${now}。`,
    '约定：',
    '- 你可以读取该终端的输出、执行命令、发送按键（工具清单见下），作用于用户眼前这一条终端；',
    '- 执行命令前先简要说明要做什么；优先使用安全、无破坏性的命令（先看状态再动手）；',
    '- 涉及删除文件、重启服务、修改配置等危险操作时，先说明影响再执行；',
    '- 命令是串行执行的：上一条跑完并读到输出后下一条才开始，不要并发下发；',
    '- 执行命令后终端原始输出即为事实依据；失败时结合输出排查原因再尝试，不要盲目重试同一条命令；',
    '- 交互式 / 前台程序（htop、top、vim、nano、less、man、watch、python、node 等）会占住终端不返回提示符：执行这类命令后不要继续输入新命令，先用发送按键退出（多数用 "q"，卡住用 "C-c"，个别用 "exit" / "C-d"），确认回到 shell 提示符后再继续；',
    '- 用简洁的中文回复。'
  ].join('\n')
}

export function buildTerminalAssistantAssembly(deps: TerminalAssistantDeps): AgentAssembly {
  /** 给模型一段「你能操作终端」的说明，并列出可用工具名 */
  const terminalHint = deps.specs.length
    ? [
        '',
        '你**绑定了一个终端**(用户当前正在看的那个)。你可以通过下面这些工具直接操作它 —— 执行命令、读取输出、发送按键:',
        ...deps.specs.map((t) => `- ${t.name}:${t.description}`),
        '执行命令后终端输出即为事实依据;涉及删除 / 重启 / 改配置等危险操作前先说明影响。命令是串行执行的,不要并发下发。',
        '你不负责项目管理(建 / 删项目、worktree、定时任务),这类请求请让用户去项目面板或全局助手。'
      ].join('\n')
    : ''

  return {
    instructions: buildTerminalAssistantInstructions() + terminalHint,
    plugins:
      deps.specs.length > 0
        ? [
            {
              plugin: rawToolsPlugin('assistant:terminal', deps.tools, {
                origin: 'plugin',
                source: 'client'
              })
            }
          ]
        : []
  }
}
