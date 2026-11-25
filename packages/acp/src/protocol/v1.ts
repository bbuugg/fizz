/**
 * ACP v1（stable）连接适配器。
 *
 * 把 `@agentclientprotocol/sdk` 的 Client / ActiveSession 包成协议版本无关的
 * `AcpConnection`。行为与重构前的 `acp.ts` 逐字节一致：
 * - 新建会话走 `ctx.buildSession().start()`（SDK 帮忙路由 session/update）；
 * - 恢复会话走 `session/load` + 手写队列（SDK 的 ActiveSession 不挂 load）；
 * - 权限选项原样透传；中止仍由上层杀进程（这里不处理 signal）。
 */
import * as acp from '@agentclientprotocol/sdk'
import { ManualTurnSource } from './manual'
import type {
  AcpAuthMethod,
  AcpConnectInput,
  AcpConnection,
  AcpConnectionFactory,
  AcpElicitationReply,
  AcpElicitationRequest,
  AcpInitResult,
  AcpModesSnapshot,
  AcpNewSessionResult,
  AcpPermissionRequest,
  AcpResumeResult,
  AcpSessionInfo,
  AcpTurnMessage,
  AcpTurnSource,
} from './types'

const CLIENT_INFO = { name: 'Fizz Server', version: '0.1.0' }

/** v1 权限请求 → 规范化结构 */
function normalizePermission(params: any): AcpPermissionRequest {
  const toolCall = params?.toolCall ?? {}
  const options = Array.isArray(params?.options)
    ? params.options.map((o: any) => ({
        optionId: String(o?.optionId ?? ''),
        name: String(o?.name ?? ''),
        kind: String(o?.kind ?? ''),
      }))
    : []
  return {
    toolCallId: String(toolCall?.toolCallId ?? ''),
    title: typeof toolCall?.title === 'string' ? toolCall.title : '',
    ...(typeof toolCall?.name === 'string' && toolCall.name ? { name: toolCall.name } : {}),
    ...(typeof toolCall?.kind === 'string' && toolCall.kind ? { kind: toolCall.kind } : {}),
    options,
  }
}

/** 规范化答复 → v1 的 RequestPermissionResponse */
function toOutcome(reply: { approved: boolean; optionId?: string }): acp.RequestPermissionResponse {
  if (reply.optionId) return { outcome: { outcome: 'selected', optionId: reply.optionId } }
  return { outcome: { outcome: 'cancelled' } }
}

/** v1 的 modes 字段 → 快照 */
function normalizeModes(modes: any): AcpModesSnapshot | null {
  if (!modes) return null
  return {
    availableModes: (modes.availableModes ?? []).map((m: any) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.description ? { description: m.description } : {}),
    })),
    currentModeId: modes.currentModeId ?? null,
  }
}

/** v1 的 authMethods（字段名是 `id`）→ 统一结构 */
function normalizeAuthMethods(raw: any): AcpAuthMethod[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((m: any): AcpAuthMethod | null => {
      const id = typeof m?.id === 'string' ? m.id : typeof m?.methodId === 'string' ? m.methodId : ''
      if (!id) return null
      return {
        id,
        name: typeof m?.name === 'string' && m.name ? m.name : id,
        ...(typeof m?.description === 'string' && m.description ? { description: m.description } : {}),
        ...(typeof m?.type === 'string' && m.type ? { type: m.type } : {}),
      }
    })
    .filter((m): m is AcpAuthMethod => m !== null)
}

/** v1 的 elicitation/create 参数 → 统一结构 */
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

/** 统一答复 → v1 的 CreateElicitationResponse */
function toElicitationResponse(reply: AcpElicitationReply): any {
  if (reply.action === 'accept') {
    return { action: 'accept', ...(reply.content ? { content: reply.content } : {}) }
  }
  return { action: reply.action }
}

/** 把 ActiveSession 包成版本无关的轮次来源 */
function wrapActiveSession(session: acp.ActiveSession): AcpTurnSource {
  return {
    sessionId: session.sessionId,
    async prompt(blocks) {
      await session.prompt(blocks as acp.ContentBlock[])
    },
    async nextUpdate(): Promise<AcpTurnMessage> {
      const message = await session.nextUpdate()
      if (message.kind === 'stop') {
        return { kind: 'stop', stopReason: message.stopReason ?? 'end_turn' }
      }
      return {
        kind: 'session_update',
        update: message.update as unknown as { sessionUpdate: string; [k: string]: unknown },
      }
    },
    drainAll: () => [],
  }
}

class V1Connection implements AcpConnection {
  readonly version = 'v1' as const
  private init: AcpInitResult | null = null
  private readonly manual = new Map<string, ManualTurnSource>()

  constructor(
    private readonly ctx: acp.ClientContext,
    private readonly release: () => void,
  ) {}

  async initialize(): Promise<AcpInitResult> {
    if (this.init) return this.init
    const response = await this.ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: {} } },
      clientInfo: CLIENT_INFO,
    })
    const caps = (response as any)?.agentCapabilities
    const sessionCaps = caps?.sessionCapabilities
    const image = caps?.promptCapabilities?.image
    this.init = {
      promptImage: typeof image === 'boolean' ? image : null,
      canList: Boolean(sessionCaps?.list),
      canDelete: Boolean(sessionCaps?.delete),
      canFork: Boolean(sessionCaps?.fork),
      canClose: Boolean(sessionCaps?.close),
      // v1 的 session/cancel 是通知、没有单独的能力位（有 session 就能发）
      canCancel: true,
      authMethods: normalizeAuthMethods((response as any)?.authMethods),
    }
    return this.init
  }

  async newSession(cwd: string): Promise<AcpNewSessionResult> {
    const session = await this.ctx.buildSession(cwd).start()
    return {
      source: wrapActiveSession(session),
      configOptions: (session.newSessionResponse?.configOptions as unknown[]) ?? null,
      modes: normalizeModes(session.modes),
    }
  }

  private manualSource(sessionId: string): ManualTurnSource {
    const source = new ManualTurnSource(sessionId, async (blocks) => {
      const response = await this.ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks as acp.ContentBlock[],
      })
      return response.stopReason ?? 'end_turn'
    })
    this.manual.set(sessionId, source)
    return source
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpResumeResult> {
    const source = this.manualSource(sessionId)
    // mcpServers 是 load 请求的必填字段（与 session/new 不同，这里没有 builder 兜底）
    const response = (await this.ctx.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    })) as any
    return {
      source,
      configOptions: response?.configOptions ?? null,
      modes: normalizeModes(response?.modes),
    }
  }

  async forkSession(sessionId: string, cwd: string): Promise<AcpResumeResult> {
    const response = (await this.ctx.request(acp.methods.agent.session.fork, {
      sessionId,
      cwd,
    })) as any
    const forkedId = String(response?.sessionId ?? '')
    if (!forkedId) throw new Error('session/fork 没有返回新的 sessionId')
    return {
      source: this.manualSource(forkedId),
      configOptions: response?.configOptions ?? null,
      modes: normalizeModes(response?.modes),
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.ctx.request(acp.methods.agent.session.close, { sessionId })
    this.manual.delete(sessionId)
  }

  async cancelTurn(sessionId: string): Promise<void> {
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  async login(methodId: string): Promise<void> {
    await this.ctx.request(acp.methods.agent.authenticate, { methodId })
  }

  async logout(): Promise<void> {
    throw new Error('ACP v1 没有 logout（只有 authenticate）')
  }

  /** 供 onNotification 路由 session/update 到由 resume 恢复出来的会话 */
  routeUpdate(params: any): void {
    const source = this.manual.get(params?.sessionId)
    if (!source) return
    const update = params.update as { sessionUpdate: string; [k: string]: unknown }
    source.handleUpdate(update)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<unknown[] | null> {
    const response = (await this.ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    })) as any
    return (response?.configOptions as unknown[]) ?? null
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId })
  }

  async listSessions(cwd?: string): Promise<AcpSessionInfo[]> {
    const response = await this.ctx.request(
      acp.methods.agent.session.list,
      cwd ? { cwd } : {},
    )
    return response.sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ctx.request(acp.methods.agent.session.delete, { sessionId })
  }

  close(): void {
    this.manual.clear()
    this.release()
  }
}

/** v1 连接工厂 */
export const v1Factory: AcpConnectionFactory = {
  version: 'v1',
  connect(input: AcpConnectInput): Promise<AcpConnection> {
    return new Promise<AcpConnection>((resolve, reject) => {
      let release: (() => void) | null = null
      const closed = new Promise<void>((r) => {
        release = r
      })
      let connection: V1Connection | null = null
      void acp
        .client({ name: 'Fizz Server' })
        .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
          const reply = await input.handlers.onPermission(
            normalizePermission(ctx.params as any),
          )
          return toOutcome(reply)
        })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          connection?.routeUpdate(ctx.params as any)
        })
        .onRequest(acp.methods.client.elicitation.create, async (ctx) => {
          // 没有追问 UI 时按 decline 答，别把 agent 挂住
          const reply: AcpElicitationReply = input.handlers.onElicitation
            ? await input.handlers.onElicitation(normalizeElicitation(ctx.params))
            : { action: 'decline' }
          return toElicitationResponse(reply)
        })
        .onNotification(acp.methods.client.elicitation.complete, (ctx) => {
          const id = (ctx.params as any)?.elicitationId
          if (typeof id === 'string' && id) input.handlers.onElicitationComplete?.(id)
        })
        .connectWith(acp.ndJsonStream(input.toAgent, input.fromAgent), async (ctx) => {
          connection = new V1Connection(ctx, () => release?.())
          resolve(connection)
          await closed
        })
        .catch((err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        )
    })
  },
}
