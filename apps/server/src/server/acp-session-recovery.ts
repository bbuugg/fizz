/**
 * ACP 会话恢复的唯一编排入口：旧 restart 与 transcript 共用回放和历史快照。
 * 空闲回放占用与发消息相同的启动位；运行中只读快照，不 teardown 正在工作的进程。
 */
import { replayAcpSession } from '@fizz/acp'
import type { AcpTranscriptResult } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { ensurePiConfirmExtension } from '@/lib/server/acp-extension'
import { refreshAcpSessionState } from '@/lib/server/acp-session-state'
import { acpMcpServers } from '@/lib/server/acp-mcp'
import {
  findActiveByConversation, summarize, reserveConversationRunStart, releaseConversationRunStart,
} from '@/lib/server/chat-run'
import {
  acpTranscriptView, getAcpTranscript, setAcpTranscript,
  carryOverIds, carryOverErrors, carryOverDurations,
} from '@/lib/server/acp-transcripts'

export class AcpSessionRecoveryError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'AcpSessionRecoveryError'
  }
}

const recoveries = new Map<string, Promise<AcpTranscriptResult>>()

export async function recoverAcpConversation(
  agentId: string,
  conversationId: string,
  options: { restartOnly?: boolean } = {},
): Promise<AcpTranscriptResult> {
  const conversation = domain.getConversation(conversationId)
  if (!conversation) throw new AcpSessionRecoveryError(404, '会话不存在')
  if (conversation.backend !== 'acp' || conversation.configId !== agentId) {
    throw new AcpSessionRecoveryError(400, '会话与外部 Agent 不匹配')
  }

  const active = findActiveByConversation(conversationId)
  if (active) {
    if (options.restartOnly) {
      throw new AcpSessionRecoveryError(409, '会话正在生成或等待答复，不能重启；请先停止当前轮次')
    }
    return acpTranscriptView(conversationId, summarize(active))
  }
  const existing = recoveries.get(conversationId)
  if (existing) return existing

  // 只信服务端会话记录，不用调用方传来的 sessionId / cwd 覆盖恢复目标。
  if (!conversation.acpSessionId) {
    if (options.restartOnly) return acpTranscriptView(conversationId, null)
    throw new AcpSessionRecoveryError(400, '尚未建立 Agent 会话，无需恢复历史')
  }
  const workspace = domain.getWorkspace(conversation.workspaceId)
  if (!workspace?.path) {
    throw new AcpSessionRecoveryError(400, '工作区目录不可用，无法恢复会话')
  }
  const agent = domain.resolveAcpAgent(agentId)
  // 同步检查并占位：避免「检查为空闲 → 新一轮开始 → 回放杀进程」的竞争窗口。
  if (!reserveConversationRunStart(conversationId)) {
    throw new AcpSessionRecoveryError(409, '会话正在启动，请稍后重新加载')
  }

  const pending = Promise.resolve().then(async (): Promise<AcpTranscriptResult> => {
    try {
      try {
        ensurePiConfirmExtension(agent, workspace.path)
      } catch (err) {
        // 扩展补装是附赠动作，失败不影响原会话恢复，但不能静默吞错。
        console.warn('[acp-recovery] 权限扩展准备失败:', err)
      }
      const before = getAcpTranscript(conversationId)
      const messages = await replayAcpSession({
        agent, conversationId, workspacePath: workspace.path,
        sessionId: conversation.acpSessionId!,
        mcpServers: acpMcpServers(domain.listMcpServers(), conversation.mcpServerIds),
      })
      const after = getAcpTranscript(conversationId) ?? []
      const appended = before ? after.slice(before.length) : after
      if (before) {
        // 先对齐 id，再补工作台错误和耗时，避免重复消息、错误消失及折叠条退化。
        carryOverIds(before, messages)
        carryOverErrors(before, messages)
        carryOverDurations(before, messages)
      }
      refreshAcpSessionState(conversationId, agentId)
      setAcpTranscript(conversationId, [...messages, ...appended])
      return acpTranscriptView(conversationId, null)
    } finally {
      releaseConversationRunStart(conversationId)
      if (recoveries.get(conversationId) === pending) recoveries.delete(conversationId)
    }
  })
  recoveries.set(conversationId, pending)
  return pending
}
