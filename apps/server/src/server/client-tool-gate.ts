/**
 * 客户端工具的执行通道：把「模型的工具调用」桥接到**发起请求的那个客户端**执行。
 *
 * ## 为什么要有它
 *
 * 有些东西服务端够不着 —— 最典型的是渲染端正在看的**终端**：xterm 的滚动缓冲、
 * 它自己那条 WebSocket 都只在客户端。服务端没有活会话注册表（SSH / 本机 PTY 的
 * 会话 id 是临时的、只绑在自己的 socket 上），所以「让 AI 操作用户眼前那台终端」
 * 只能由客户端执行。
 *
 * ## 与 confirm / ask-followup 同一条反向通道
 *
 * SSE 只有下行，客户端要回话必须另开一条 HTTP 请求。所以流程是：
 *
 * 1. 工具 execute 被调用 → `emit` 一帧 `client-tool-call`（带 callId / 工具名 / 入参）；
 * 2. 调用挂进 `pendingClientTools`（共享注册表，跨 Turbopack / tsx 加载器）；
 * 3. 客户端执行完 → `POST /api/chat/client-tool-result` → 解开 await；
 * 4. 同一个回合继续往下跑（历史照常累积，模型看到的是正常的工具结果）。
 *
 * ## 权限闸在服务端，档位来自客户端
 *
 * 客户端工具是客户端自己声明、自己执行的 —— 但**闸门不能因此留在客户端**：工具是模型
 * 直接调用的，客户端那边只有「执行」一个入口，漏掉任何一条路径就是裸跑（终端里跑
 * `rm -rf` 没有任何提示）。所以审批统一在这里套，与插件工具的 `mutating` 闸同一套语义：
 *
 * | 档位 | 声明了 `mutating` 的客户端工具 |
 * | --- | --- |
 * | `readonly` | 直接拒绝，不执行、也不弹确认 |
 * | `confirm` | 先问用户；同意才执行 |
 * | `full` | 直接执行（不问） |
 *
 * 依据的 `permissionMode` 仍然是**客户端随请求上送的** —— 用户照样是在界面上做的选择，
 * 服务端只是不假设「客户端一定会自己拦」。审批帧走 `confirm-gate`（与内置工具、ACP 权限
 * 同一张卡），所以客户端不需要为它新写任何 UI。
 *
 * 拒绝时**返回一句说明而不是抛错**（与内置闸门一致）：回绝是预期内的结果，让模型看到原因
 * 后能向用户解释；抛错会变成一次工具错误，把整轮打断。
 *
 * ## 收尾纪律（与 confirm-gate 一致）
 *
 * 一轮结束 / 中止时必须 `releaseAll()`，否则挂起的 Promise 永不 settle、整轮卡死。
 * 另加一层超时兜底：客户端崩了 / 通道断了也不能把这一轮吊死。
 */
import { randomUUID } from 'node:crypto'
import { dynamicTool, jsonSchema } from 'ai'
import type { ClientToolSpec } from '@fizz/contracts/agent-api'
import type { AgentConfirmInput, AiPermissionMode } from '@fizz/contracts/types'
import { emit, type ChatRun } from './chat-run'
import { pendingClientTools } from './state'

/**
 * 单次客户端工具调用的等待上限。
 *
 * 客户端执行的是本地操作（读写终端缓冲、发按键），正常都在毫秒级；给 60s 是留给
 * 「执行一条慢命令」的场景。超时**不静默**：按失败收场，让模型看到「没拿到结果」。
 */
export const CLIENT_TOOL_TIMEOUT_MS = 60_000

/** 把某条 run 挂着的客户端工具调用全部按失败放行（整轮结束 / 中止时调用，幂等） */
export function releaseClientToolsFor(requestId: string, reason: string): void {
  for (const [id, entry] of [...pendingClientTools]) {
    if (entry.requestId !== requestId) continue
    pendingClientTools.delete(id)
    entry.resolve({ ok: false, error: reason })
  }
}

export interface ClientToolGate {
  /** 执行一次客户端工具调用：推帧 → 挂起 → 等客户端回填 */
  invoke(name: string, input: unknown): Promise<unknown>
  /** 把这条 run 挂着的调用全部按失败放行（整轮结束 / 中止时调用，幂等） */
  releaseAll(): void
}

export function createClientToolGate(input: {
  run: ChatRun
  timeoutMs?: number
}): ClientToolGate {
  const { run } = input
  const timeoutMs = input.timeoutMs ?? CLIENT_TOOL_TIMEOUT_MS

  const invoke = (name: string, toolInput: unknown): Promise<unknown> => {
    const callId = randomUUID()
    emit(run, {
      type: 'client-tool-call',
      requestId: run.requestId,
      clientToolCallId: callId,
      clientToolName: name,
      clientToolInput: toolInput ?? null
    })
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      const settle = (payload: { ok: boolean; result?: unknown; error?: string }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        pendingClientTools.delete(callId)
        if (payload.ok) resolve(payload.result ?? '（无返回值）')
        else reject(new Error(payload.error || '客户端工具执行失败'))
      }
      const timer = setTimeout(
        () => settle({ ok: false, error: `客户端工具「${name}」调用超时（客户端未在限时内回填结果）` }),
        timeoutMs
      )
      timer.unref?.()
      pendingClientTools.set(callId, { requestId: run.requestId, resolve: settle })
    })
  }

  return {
    invoke,
    releaseAll: () => releaseClientToolsFor(run.requestId, '对话已结束，客户端工具调用被取消')
  }
}

/** 客户端工具的审批依据（`permissionMode` 来自客户端请求，`requestConfirm` 来自 confirm-gate） */
export interface ClientToolApproval {
  /**
   * 这一轮的权限档；缺省 `full`。
   * ⚠️ 缺省刻意与 `plugins.ts` 的 `wrapToolsWithApproval` 保持一致（`?? 'full'`）——
   * 两边对「没传档位」的解释必须一样，否则同一次请求里两套工具的行为会分叉。
   */
  permissionMode?: AiPermissionMode
  /**
   * **运行中实时读取权限档**（优先于 `permissionMode`）。工具集一轮建一次，静态档会把
   * 权限快照死在整轮里；传 getter 则闸门**每次调用现取**，用户中途切档立刻生效
   * （server 传 `() => run.permissionMode`）。
   */
  getPermissionMode?: () => AiPermissionMode
  /** 审批通道（`createConfirmGate` 的 `requestConfirm`）；不传 = confirm 档下没有可确认的地方 */
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
}

/**
 * 审批卡里显示的调用描述。
 *
 * 与 `plugins.ts` 的 `describeToolCall` 同款（名字 + 紧凑入参、超长截断），但**优先把要跑
 * 的命令 / 要发的按键顶到最前面** —— 用户审批终端操作时看的就是这一行，把
 * `{"command":"rm -rf build"}` 埋在 JSON 里远不如直接写出来。
 */
function describeClientToolCall(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  if (typeof args.command === 'string' && args.command.trim()) return `在终端执行：${args.command}`
  if (typeof args.keys === 'string' && args.keys.trim()) return `向终端发送按键：${args.keys}`
  let body: string
  try {
    body = JSON.stringify(input ?? {})
  } catch {
    // JSON.stringify 遇到循环引用 / BigInt 会抛 —— 那不是「没描述」，是入参本身有问题，
    // 如实回一句比让整个审批流程挂掉好
    body = '(入参无法序列化)'
  }
  if (body.length > 300) body = `${body.slice(0, 300)}…`
  return `${name}${body}`
}

/** 返回 `null` = 放行；返回字符串 = 直接作为工具结果（回绝说明） */
async function guardClientToolCall(
  name: string,
  input: unknown,
  toolCallId: string,
  approval: ClientToolApproval,
  mode: AiPermissionMode
): Promise<string | null> {
  if (mode === 'readonly') {
    return (
      `当前是只读模式：已拒绝调用「${name}」（它会改动终端状态）。` +
      '请把这一点告诉用户 —— 他可以在输入框左侧把工具权限切成「确认模式」或「完全访问」，' +
      '不要反复尝试同类操作。'
    )
  }
  if (mode !== 'confirm') return null
  if (!approval.requestConfirm) {
    // 与 plugins.ts 的 wrapToolsWithApproval 同一取舍：这里刻意失败关闭
    return (
      `「${name}」需要用户确认，但当前环境没有可用的确认通道（无界面 / 未接入审批），` +
      '已取消这次调用。请告诉用户这次没有执行。'
    )
  }
  const approved = await approval.requestConfirm({
    toolCallId,
    toolName: name,
    command: describeClientToolCall(name, input)
  })
  return approved
    ? null
    : `用户拒绝了这次调用：未执行「${name}」。请询问用户接下来希望怎么做，不要擅自重试同一步。`
}

/**
 * 把请求携带的客户端工具**声明**装成可执行的工具集。
 *
 * ⚠️ `inputSchema` 是 JSON Schema（跨进程传输的形状），服务端只把它转交给模型；
 * 客户端没给就按空对象入参（模型仍能调用，只是没有参数）。
 *
 * 声明了 `mutating` 的工具按**调用时现取**的权限档套闸（见文件头那张表）：`full` 档下
 * execute 里同步早退、直接转发，行为与不套闸一致；`confirm` / `readonly` 才真的拦。
 * ⚠️ 之所以不在 build 期按当前档决定「包不包」：权限档要能在运行中变（切档立刻生效），
 * 包不包若在 build 期定死，运行中把 `full` 改成 `confirm` 就拦不住了。
 *
 * 返回 `Record<string, unknown>`，调用方经 `rawToolsPlugin` 挂进 `AgentAssembly.plugins`。
 */
export function buildClientToolset(
  specs: readonly ClientToolSpec[],
  gate: ClientToolGate,
  approval: ClientToolApproval = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of specs) {
    const name = spec.name?.trim()
    if (!name || out[name]) continue
    const run = (toolInput: unknown): Promise<unknown> => gate.invoke(name, toolInput)
    // 只读工具不套闸。**改动类一律套**（不再按当前档判断要不要包）——权限档要能在运行中
    // 变，包不包不能在 build 期定死，得每次调用现取（`full` 档下只是多一次同步早退）。
    const gated = spec.mutating === true
    out[name] = dynamicTool({
      description: spec.description || name,
      inputSchema: jsonSchema(spec.inputSchema ?? { type: 'object', properties: {} }),
      execute: gated
        ? async (toolInput: unknown, options: { toolCallId?: string } | undefined) => {
            // 每次调用现取：传了 getter 就以它为准（运行中切档立刻生效），否则退回静态快照
            const mode = approval.getPermissionMode?.() ?? approval.permissionMode ?? 'full'
            if (mode === 'full') return run(toolInput)
            const denial = await guardClientToolCall(
              name,
              toolInput,
              options?.toolCallId ?? '',
              approval,
              mode
            )
            if (denial) return denial
            return run(toolInput)
          }
        : async (toolInput: unknown) => run(toolInput)
    })
  }
  return out
}
