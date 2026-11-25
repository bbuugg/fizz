/**
 * ACP v2（draft）连接适配器。
 *
 * v2 与 v1 的关键差异（都在这里消化，向上仍给 v1 形状）：
 * - 恢复会话是 `session/resume`（没有 `session/load`）；
 * - `session/set_mode` 被移除，模式改走 `session/set_config_option`；
 * - `session/prompt` 只回「已插入」，完成信号是 idle 的 `state_update`；
 * - `SessionUpdate` 是可扩展 union，新增 `agent_message` / `tool_call_content_chunk` 等，
 *   这里折回 v1 的 `agent_message_chunk` / `tool_call_update`。
 *
 * ⚠️ v2 仍是 draft：wire protocol / 类型可能不兼容变更，升级 SDK 前请看 CHANGELOG。
 */
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2'
import { ManualTurnSource } from './manual'
import type {
  AcpAuthMethod,
  AcpConnectInput,
  AcpConnection,
  AcpConnectionFactory,
  AcpElicitationReply,
  AcpElicitationRequest,
  AcpInitResult,
  AcpNewSessionResult,
  AcpPermissionRequest,
  AcpResumeResult,
  AcpSessionInfo,
  AcpTurnMessage,
  AcpTurnSource,
} from './types'

const CLIENT_INFO = { name: 'Fizz Server', version: '0.1.0' }

/** v2 权限请求 → 规范化结构（v2 把细节放在 `subject` 里） */
function normalizePermission(params: any): AcpPermissionRequest {
  const subject = params?.subject ?? {}
  const toolCall = subject?.type === 'tool_call' ? (subject.toolCall ?? {}) : {}
  const options = Array.isArray(params?.options)
    ? params.options.map((o: any) => ({
        optionId: String(o?.optionId ?? ''),
        name: String(o?.name ?? ''),
        kind: String(o?.kind ?? ''),
      }))
    : []
  const toolCallId = String(
    toolCall?.toolCallId ?? subject?.toolCallId ?? '',
  )
  return {
    toolCallId,
    title:
      typeof params?.title === 'string'
        ? params.title
        : typeof toolCall?.title === 'string'
          ? toolCall.title
          : typeof subject?.command === 'string'
            ? subject.command
            : '',
    ...(typeof toolCall?.name === 'string' && toolCall.name
      ? { name: toolCall.name }
      : {}),
    ...(typeof toolCall?.kind === 'string' && toolCall.kind
      ? { kind: toolCall.kind }
      : {}),
    options,
  }
}

/** v2 的 authMethods（字段名是 `methodId`）→ 统一结构 */
function normalizeAuthMethods(raw: any): AcpAuthMethod[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((m: any): AcpAuthMethod | null => {
      const id =
        typeof m?.methodId === 'string' ? m.methodId : typeof m?.id === 'string' ? m.id : ''
      if (!id) return null
      return {
        id,
        name: typeof m?.name === 'string' && m.name ? m.name : id,
        ...(typeof m?.description === 'string' && m.description
          ? { description: m.description }
          : {}),
        ...(typeof m?.type === 'string' && m.type ? { type: m.type } : {}),
      }
    })
    .filter((m): m is AcpAuthMethod => m !== null)
}

/** v2 的 elicitation/create 参数 → 统一结构 */
function normalizeElicitation(params: any): AcpElicitationRequest {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(typeof params?.toolCallId === 'string' && params.toolCallId
      ? { toolCallId: params.toolCallId }
      : {}),
    mode: typeof params?.mode === 'string' ? params.mode : 'form',
    message: typeof params?.message === 'string' ? params.message : '',
    ...(typeof params?.url === 'string' ? { url: params.url } : {}),
    ...(params?.requestedSchema !== undefined ? { schema: params.requestedSchema } : {}),
  }
}

/** 统一答复 → v2 的 CreateElicitationResponse */
function toElicitationResponse(reply: AcpElicitationReply): any {
  if (reply.action === 'accept') {
    return { action: 'accept', ...(reply.content ? { content: reply.content } : {}) }
  }
  return { action: reply.action }
}

/** 把内容块数组里的文本拼起来（v2 的整条消息用） */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
}

/**
 * v2 的 SessionUpdate → v1 形状。
 *
 * ⚠️ `agent_message` / `agent_thought` 在 v2 里是**整条替换**（带 messageId），不是增量；
 * 直接当成 chunk 下发会把已经显示过的文字再发一遍（界面出现重复段落）。这里按 messageId
 * 记住上一次的全文，只发新增的部分。增量型的 `*_chunk` 才原样透传。
 */
export class V2UpdateNormalizer {
  /** messageId → 上一次收到的全文（v2 会整条重发同一条消息） */
  private readonly lastText = new Map<string, string>()

  /** 返回 null 表示这条更新没有可下发的内容（整条重发且没有新增） */
  normalize(raw: any): { sessionUpdate: string; [key: string]: unknown } | null {
    const type = raw?.sessionUpdate
    if (
      type === 'agent_message_chunk' ||
      type === 'agent_thought_chunk' ||
      type === 'tool_call_update' ||
      type === 'usage_update'
    ) {
      return raw
    }
    if (type === 'agent_message' || type === 'agent_thought') {
      const key = `${type}:${String(raw.messageId ?? '')}`
      const full = textOf(raw.content)
      const previous = this.lastText.get(key) ?? ''
      this.lastText.set(key, full)
      // 正常是追加；agent 改了历史内容时退回整段重发（宁可重复也不能丢）
      const text = full.startsWith(previous) ? full.slice(previous.length) : full
      if (!text) return null
      return {
        ...raw,
        sessionUpdate: type === 'agent_message' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text },
      }
    }
    if (type === 'tool_call_content_chunk') {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: raw.toolCallId,
        content: Array.isArray(raw.content) ? raw.content : [raw.content],
      }
    }
    return raw
  }
}

/** 把 v2 的 ActiveSession 包成版本无关的轮次来源 */
function wrapActiveSession(session: any, normalizer: V2UpdateNormalizer): AcpTurnSource {
  return {
    sessionId: session.sessionId,
    async prompt(blocks) {
      // v2 的 prompt 只回「已插入」；完成由 idle state_update → nextUpdate 的 stop 告知
      await session.prompt(blocks as any)
    },
    async nextUpdate(): Promise<AcpTurnMessage> {
      for (;;) {
        const message = await session.nextUpdate()
        if (message.kind === 'stop') {
          return { kind: 'stop', stopReason: message.stopReason ?? 'end_turn' }
        }
        const update = normalizer.normalize(message.update)
        // 整条重发但没有新增：不占一条消息，继续等真正的增量
        if (update) return { kind: 'session_update', update }
      }
    },
    drainAll: () => [],
  }
}

class V2Connection implements AcpConnection {
  readonly version = 'v2' as const
  private init: AcpInitResult | null = null
  private readonly manual = new Map<string, ManualTurnSource>()
  /** 每个会话一份 v2→v1 规整器（agent_message 的「上次全文」是会话内状态） */
  private readonly normalizers = new Map<string, V2UpdateNormalizer>()

  private normalizerFor(sessionId: string): V2UpdateNormalizer {
    let normalizer = this.normalizers.get(sessionId)
    if (!normalizer) {
      normalizer = new V2UpdateNormalizer()
      this.normalizers.set(sessionId, normalizer)
    }
    return normalizer
  }

  constructor(
    private readonly ctx: acpV2.ClientContext,
    private readonly release: () => void,
  ) {}

  async initialize(): Promise<AcpInitResult> {
    if (this.init) return this.init
    const response = await this.ctx.request(acpV2.methods.agent.initialize, {
      protocolVersion: acpV2.PROTOCOL_VERSION,
      info: CLIENT_INFO,
    } as any)
    const caps = (response as any)?.capabilities
    const sessionCaps = caps?.session
    this.init = {
      promptImage: Boolean(sessionCaps?.prompt?.image),
      // v2 里 `capabilities.session` 出现即表示支持基线 list/resume/close
      canList: Boolean(sessionCaps),
      canDelete: Boolean(sessionCaps?.delete),
      canFork: Boolean(sessionCaps?.fork),
      canClose: Boolean(sessionCaps),
      canCancel: Boolean(sessionCaps),
      authMethods: normalizeAuthMethods((response as any)?.authMethods),
    }
    return this.init
  }

  async newSession(cwd: string): Promise<AcpNewSessionResult> {
    const session = await this.ctx.buildSession(cwd).start()
    return {
      source: wrapActiveSession(session, this.normalizerFor(session.sessionId)),
      configOptions: ((session as any).configOptions as unknown[]) ?? null,
      // v2 没有独立的 modes 字段：模式是 configOptions 里 category='mode' 的一项
      modes: null,
    }
  }

  private manualSource(sessionId: string): ManualTurnSource {
    const source = new ManualTurnSource(sessionId, async (blocks) => {
      // 只回插入确认；stop 由 idle state_update 推入（见 routeUpdate）
      await this.ctx.request(acpV2.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks as any,
      })
      return null
    })
    this.manual.set(sessionId, source)
    return source
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpResumeResult> {
    const source = this.manualSource(sessionId)
    const response = (await this.ctx.request(acpV2.methods.agent.session.resume, {
      sessionId,
      cwd,
      replayFrom: { type: 'start' },
    } as any)) as any
    return {
      source,
      configOptions: (response?.configOptions as unknown[]) ?? null,
      modes: null,
    }
  }

  async forkSession(sessionId: string, cwd: string): Promise<AcpResumeResult> {
    const response = (await this.ctx.request(acpV2.methods.agent.session.fork, {
      sessionId,
      cwd,
    } as any)) as any
    const forkedId = String(response?.sessionId ?? '')
    if (!forkedId) throw new Error('session/fork 没有返回新的 sessionId')
    return {
      source: this.manualSource(forkedId),
      configOptions: (response?.configOptions as unknown[]) ?? null,
      modes: null,
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.ctx.request(acpV2.methods.agent.session.close, { sessionId })
    this.manual.delete(sessionId)
  }

  async cancelTurn(sessionId: string): Promise<void> {
    await this.ctx.notify(acpV2.methods.agent.session.cancel, { sessionId })
  }

  async login(methodId: string): Promise<void> {
    await this.ctx.request(acpV2.methods.agent.auth.login, { methodId })
  }

  async logout(): Promise<void> {
    await this.ctx.request(acpV2.methods.agent.auth.logout, {})
  }

  /** onNotification 分发：idle state_update 折成 stop，其余按 v1 形状入队 */
  routeUpdate(params: any): void {
    const source = this.manual.get(params?.sessionId)
    if (!source) return
    const update = params.update as any
    if (update?.sessionUpdate === 'state_update') {
      // 只有 idle 才是「这一轮结束」；running / requires_action 不是
      if (update.state !== 'idle') return
      const stopReason = update?.stopReason
      source.stop(typeof stopReason === 'string' && stopReason ? stopReason : 'end_turn')
      return
    }
    const normalized = this.normalizerFor(String(params?.sessionId ?? '')).normalize(update)
    if (normalized) source.handleUpdate(normalized)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<unknown[] | null> {
    const response = (await this.ctx.request(
      acpV2.methods.agent.session.setConfigOption,
      // v2 的 value 带 `type: 'id'` 判别式（v1 是裸 string）
      { sessionId, configId, value, type: 'id' },
    )) as any
    return (response?.configOptions as unknown[]) ?? null
  }

  async setMode(): Promise<void> {
    // v2 移除了 session/set_mode：模式统一走 session/set_config_option。
    // 上层（setAcpSessionMode）在 v2 下本来就走 modeOptionSelector 的分支，不会调到这里。
    throw new Error('ACP v2 不支持 session/set_mode（请改用 set_config_option）')
  }

  async listSessions(cwd?: string): Promise<AcpSessionInfo[]> {
    const response = (await this.ctx.request(
      acpV2.methods.agent.session.list,
      cwd ? { cwd } : {},
    )) as any
    return (response?.sessions ?? []).map((s: any) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ctx.request(acpV2.methods.agent.session.delete, { sessionId })
  }

  close(): void {
    this.manual.clear()
    this.normalizers.clear()
    this.release()
  }
}

/** v2 连接工厂 */
export const v2Factory: AcpConnectionFactory = {
  version: 'v2',
  connect(input: AcpConnectInput): Promise<AcpConnection> {
    return new Promise<AcpConnection>((resolve, reject) => {
      let release: (() => void) | null = null
      const closed = new Promise<void>((r) => {
        release = r
      })
      let connection: V2Connection | null = null
      void acpV2
        .client({ name: 'Fizz Server' })
        .onRequest(acpV2.methods.client.session.requestPermission, async (ctx: any) => {
          const reply = await input.handlers.onPermission(
            normalizePermission(ctx.params),
          )
          if (reply.optionId) {
            return { outcome: { outcome: 'selected', optionId: reply.optionId } }
          }
          return { outcome: { outcome: 'cancelled' } }
        })
        .onNotification(acpV2.methods.client.session.update, (ctx: any) => {
          connection?.routeUpdate(ctx.params)
        })
        .onRequest(acpV2.methods.client.elicitation.create, async (ctx: any) => {
          const reply: AcpElicitationReply = input.handlers.onElicitation
            ? await input.handlers.onElicitation(normalizeElicitation(ctx.params))
            : { action: 'decline' }
          return toElicitationResponse(reply)
        })
        .onNotification(acpV2.methods.client.elicitation.complete, (ctx: any) => {
          const id = ctx.params?.elicitationId
          if (typeof id === 'string' && id) input.handlers.onElicitationComplete?.(id)
        })
        .connectWith(
          acpV2.ndJsonStream(input.toAgent, input.fromAgent),
          async (ctx: any) => {
            connection = new V2Connection(ctx, () => release?.())
            resolve(connection)
            await closed
          },
        )
        .catch((err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        )
    })
  },
}
