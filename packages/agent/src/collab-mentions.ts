/**
 * 从用户消息里解析 `@智能体` 点名。
 *
 * 为什么按名字而不是 id：用户在输入框里键入的就是 `@名字`，消息本身是唯一真源；
 * 渲染端插入候选时也只写名字。名字可以重复，重复时视为同时点名（各跑一次）。
 *
 * 用**最长名字优先**匹配并从文本里摘掉命中的片段，避免 `调研员` 与 `调研` 同时
 * 存在时一个 `@调研员` 把两个人都叫起来。英文名额外要求后面不是单词字符，
 * 否则 `@Bob` 会把 `@Bobby` 误判成 Bob；中文名没有词边界，允许后面直接接正文。
 */
import type { CollabAgentConfig } from '@fizz/contracts/types'

export function resolveCollabMentions(
  text: string,
  agents: readonly CollabAgentConfig[]
): CollabAgentConfig[] {
  let rest = text
  const matched = new Set<string>()
  const ordered = [...agents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of ordered) {
    const name = agent.name.trim()
    if (!name) continue
    const token = `@${name}`
    let from = 0
    while (true) {
      const index = rest.indexOf(token, from)
      if (index < 0) break
      const after = rest[index + token.length]
      // 英文名撞到更长的英文单词（@Bob 命中 @Bobby）就跳过这一处
      if (after && /[A-Za-z0-9_]/.test(after) && /[A-Za-z]/.test(name)) {
        from = index + token.length
        continue
      }
      matched.add(agent.id)
      rest = `${rest.slice(0, index)} ${rest.slice(index + token.length)}`
      from = index
    }
  }
  return agents.filter((agent) => matched.has(agent.id))
}
