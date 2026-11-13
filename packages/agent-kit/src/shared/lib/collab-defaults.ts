/**
 * 新建「多智能体协作」会话时的默认班子：一个调研、一个审查。
 *
 * 现在没有画布，也没有主智能体：所有 Agent 平级挂在同一条会话上。用户在输入框里
 * `@` 点名谁就由谁处理；不点名时全体 Agent 各自判断是否接手。
 */
import { DEFAULT_COLLAB_SETTINGS, createCollabAgent, type CollabSettings } from '@fizz/contracts/types'

export function defaultCollabSettings(): CollabSettings {
  const agents = [
    createCollabAgent({
      name: '调研员',
      role: '检索代码与文档，给出带文件 / 行号出处的结论',
      tools: ['read', 'glob', 'grep', 'web_fetch']
    }),
    createCollabAgent({
      name: '审查员',
      role: '审查方案与改动，找风险、遗漏与不一致',
      tools: ['read', 'glob', 'grep']
    })
  ]
  return {
    ...DEFAULT_COLLAB_SETTINGS,
    agents
  }
}
