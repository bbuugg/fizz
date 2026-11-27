/** 宿主读回附件并内联到容器请求副本，不改变落盘历史，也不要求容器回连宿主。 */
import { createInlineBudget, planAttachments } from '@fizz/agent'
import type { AgentChatMessage } from '@fizz/contracts/types'
import { createAttachmentResolver } from '../upload/attachments'

export async function inlineAttachments(history: AgentChatMessage[]): Promise<AgentChatMessage[]> {
  const files = history.flatMap((message) =>
    message.role === 'user' ? message.parts.filter((part) => part.type === 'file') : []
  )
  const planned = await planAttachments(files, {
    resolveAttachment: createAttachmentResolver(),
    budget: createInlineBudget()
  })
  let index = 0
  return history.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (message.role !== 'user' || part.type !== 'file') return part
      const { resolved } = planned[index++]!
      if (resolved.kind === 'text') return { type: 'text' as const, text: resolved.text }
      return resolved.kind === 'inline'
        ? { ...part, url: `data:${part.mediaType};base64,${Buffer.from(resolved.bytes).toString('base64')}` }
        : { type: 'text' as const, text: resolved.note ?? `（附件「${part.name}」未随本轮发送）` }
    })
  }))
}
