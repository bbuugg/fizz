/**
 * 内置能力 → 插件。
 *
 * 这里把「系统原本手工塞进工具集的东西」改写成 **priority 0 的内置插件**：
 * 文件 / 命令工具、web_fetch / screenshot，以及「把一批现成工具挂进注册表」的通用袋子
 * （extraTools、已构建好的 MCP 工具集都走它）。装配入口仍是 `buildAgentSetup`，
 * 只是它现在**只消费注册表产出的结果**，不再手工 `Object.assign` 拼工具集。
 *
 * 为什么放 @fizz/agent 而不是 @fizz/plugin：Core 要保持轻（谁都能依赖），
 * 而这些插件要 import `@fizz/tools` 的具体实现。分工与 Cordis 的「core vs 官方插件」一致。
 *
 * priority / origin 的取值都写死为「内置」——覆盖内置工具必须由插件显式调高 priority，
 * 见 `@fizz/plugin` 的 ToolsService 注释。
 */
import {
  browserRuntimeInfo,
  buildAgentTools,
  buildScreenshotTool,
  buildWebFetchTool,
  type AgentToolOptions
} from '@fizz/tools'
import { HOOKS, hookValue } from '@fizz/plugin'
import type { HooksService, Plugin, PluginObject, ResolvedTool, ToolOrigin } from '@fizz/plugin'
import type { AgentConfirmInput, AiPermissionMode } from '@fizz/contracts/types'

/** 挂载一个插件时携带的配置（`ctx.plugin(plugin, config)` 的 config） */
export interface MountedPlugin {
  plugin: Plugin
  config?: unknown
}

const BUILTIN_ORIGIN: ToolOrigin = 'builtin'

/**
 * 文件 / 命令工具插件（list_files / read_file / write_file / execute_command …）。
 * `root` 为空（未绑定工作区的「任务」会话）时**不注册任何工具** —— 与从前的行为一致，
 * 避免工具拿空路径当 cwd 乱写文件。
 */
export function fileToolsPlugin(root: string, options: AgentToolOptions): PluginObject {
  return {
    name: 'builtin:file-tools',
    apply(ctx) {
      if (!root) return
      ctx.tools.registerAll(buildAgentTools(root, options), {
        priority: 0,
        origin: BUILTIN_ORIGIN,
        source: 'builtin:file-tools'
      })
    }
  }
}

/**
 * 全局只读的联网工具插件：web_fetch + screenshot。不依赖工作区，任何会话都可用
 * （无工作区时 `root` 传空串 = 超长正文只截断不落盘，见 spillToWorkspace）。
 *
 * 两个工具的**挂载条件不同**，别一起当成「总是挂」：
 * - `web_fetch`：总是挂（fetch 引擎不需要浏览器）；装没装浏览器由它自己决定要不要暴露
 *   `engine` 这个入参，见 `buildWebFetchTool`。
 * - `screenshot`：整个工具都靠无头浏览器，**没装运行时就不挂**。挂上去只有一种结果 ——
 *   每次调用都回一句「请先去设置里装」，白占 schema 与步数，模型还可能反复试。
 */
export function webToolsPlugin(
  root: string,
  /** 单条抓取的停止钩子（与 execute_command 同一张表，见 agent.ts 的 commandStops） */
  stopHooks: Parameters<typeof buildWebFetchTool>[1] = {}
): PluginObject {
  return {
    name: 'builtin:web-tools',
    apply(ctx) {
      ctx.tools.registerAll(buildWebFetchTool(root, stopHooks), {
        priority: 0,
        origin: BUILTIN_ORIGIN,
        source: 'builtin:web_fetch'
      })
      // 装配期现读（与 chat-turn 里 browser_* 的装配闸同源判据）：装好后下一轮自然挂上，
      // 不用重启；卸掉运行时则下一轮就不挂了。
      if (!browserRuntimeInfo().installed) return
      ctx.tools.registerAll(buildScreenshotTool(), {
        priority: 0,
        origin: BUILTIN_ORIGIN,
        source: 'builtin:screenshot'
      })
    }
  }
}

/**
 * 通用「工具袋」插件：把一批**已经构建好**的工具原样挂进注册表。
 * 用于 `extraTools`（transport 相关工具，如 ask_followup_question）与已连接好的 MCP 工具集。
 */
export function rawToolsPlugin(
  name: string,
  tools: Record<string, unknown>,
  opts: { origin?: ToolOrigin; source?: string; priority?: number } = {}
): PluginObject {
  return {
    name,
    apply(ctx) {
      const count = Object.keys(tools).length
      if (count === 0) return
      ctx.tools.registerAll(tools, {
        priority: opts.priority ?? 0,
        origin: opts.origin ?? 'plugin',
        source: opts.source ?? name
      })
    }
  }
}

/**
 * 给工具集套上钩子：`tool:call` 可改写入参、`tool:result` 可改写返回
 * （钩子名与范式见 `@fizz/plugin` 的 hooks.ts）。
 *
 * 只包「有 `execute` 的工具」——AI SDK 的工具约定；没有 `execute` 的对象
 * **原样返回**，保持引用不变（测试里的假工具就是这种）。
 *
 * 钩子里抛的错**不吞**：照常冒出去变成一次 tool-error（仓库「不许静默失败」的价值观）。
 */
/** 审批闸门要的东西：权限模式 + 交互式确认通道（都来自调用方） */
export interface ToolApprovalDeps {
  permissionMode?: AiPermissionMode
  /**
   * **运行中实时读取权限档**（优先于 `permissionMode`）。工具集一轮建一次，静态档会在
   * 整轮里被快照死；用户中途切档（确认 ↔ 完全访问）时靠它**每次调用现取**，立刻生效。
   */
  getPermissionMode?: () => AiPermissionMode
  requestConfirm?: (req: AgentConfirmInput) => Promise<boolean>
}

/**
 * 调用的文字描述（确认对话框里显示的就是它）。
 *
 * 只有名字 + 紧凑入参：插件工具的入参形状千奇百怪，硬凑「好看的一句话」必然要么漏信息、
 * 要么在某个入参上崩掉。带上来源（哪个插件）；超长截断，免得一个大 `executeBody` 把
 * 确认条撑爆。`JSON.stringify` 遇到循环引用 / BigInt 会抛 —— 那不是「没描述」，而是
 * 参数本身就有问题，如实回一句比让确认流程整个挂掉好。
 */
function describeToolCall(name: string, source: string, input: unknown): string {
  let args: string
  try {
    args = JSON.stringify(input ?? {})
  } catch {
    args = '(入参无法序列化)'
  }
  if (args.length > 300) args = `${args.slice(0, 300)}…`
  return `${name}${args}（来自插件 ${source}）`
}

/**
 * 给**声明了 `mutating: true`** 的工具套上审批闸门。
 *
 * 为什么在装配期做、而不是让插件自己问：插件是第三方代码，它「愿不愿意问」不能决定
 * 「用户有没有被问过」。宿主按注册声明统一套闸门，与内置文件工具的 `guardWrite` 同一套
 * 语义（`permissionMode`：`readonly` 拒绝 / `confirm` 询问 / `full` 放行）：
 *
 * | 模式 | `mutating: true` 的工具 |
 * | --- | --- |
 * | `readonly` | 直接拒绝，不执行、也不弹确认 |
 * | `confirm` | 先问用户；同意才执行 |
 * | `full` | 直接执行（不问） |
 *
 * 拒绝时**返回一句说明而不是抛错**（与内置闸门一致）：回绝是预期内的结果，让模型看到
 * 原因后能向用户解释；抛错会变成一次工具错误，把整轮打断。
 *
 * ⚠️ 与内置文件工具的一处**刻意差异**：`confirm` 模式下**没有确认通道**时这里**失败关闭**
 * （内置的 `guardWrite` 是放行）。插件工具是第三方代码，「确认模式 + 没人能确认」意味着
 * 放行等于把用户选的确认模式静默降级成完全访问 —— 对「会把数据发出去」的工具不能这么干。
 *
 * 另外：**内置工具不经这里**（它们自己管自己的闸门），MCP 工具也不带 `mutating`
 * （MCP server 自己的注解我们没法替它担保），所以两者行为与加这个能力之前一致。
 */
export function wrapToolsWithApproval(
  entries: readonly ResolvedTool[],
  deps: ToolApprovalDeps
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { name, tool, registration } of entries) {
    const execute = (tool as { execute?: unknown } | null)?.execute
    // 只读工具、以及不是工具对象的注册项：原样透传（保持引用不变，测试里的假工具就是这种）
    if (!registration.mutating || typeof execute !== 'function') {
      out[name] = tool
      continue
    }
    const run = execute as (input: unknown, options: unknown) => unknown
    out[name] = {
      ...(tool as object),
      execute: async (
        input: unknown,
        options: { toolCallId?: string } | undefined
      ): Promise<unknown> => {
        // 每次调用现取权限档：传了 getter 就以它为准（运行中切档立刻生效），否则退回静态快照
        const mode = deps.getPermissionMode?.() ?? deps.permissionMode ?? 'full'
        const denial = await guardToolCall(name, registration.source, input, options, deps, mode)
        if (denial) return denial
        return run(input, options)
      }
    }
  }
  return out
}

/** 返回 `null` = 放行；返回字符串 = 直接作为工具结果（回绝说明） */
async function guardToolCall(
  name: string,
  source: string,
  input: unknown,
  options: { toolCallId?: string } | undefined,
  deps: ToolApprovalDeps,
  mode: AiPermissionMode
): Promise<string | null> {
  if (mode === 'readonly') {
    return (
      `当前是只读模式：已拒绝调用「${name}」（插件 ${source} 声明它会改动外部状态）。` +
      '请把这一点告诉用户 —— 他可以在「设置 → 通用」里把权限切换成「确认模式」或「完全访问」，' +
      '不要反复尝试同类操作。'
    )
  }
  if (mode !== 'confirm') return null
  if (!deps.requestConfirm) {
    // 见 wrapToolsWithApproval 的说明：这里刻意失败关闭
    return (
      `「${name}」（插件 ${source}）需要用户确认，但当前环境没有可用的确认通道（无界面 / 未接入审批），` +
      '已取消这次调用。请告诉用户这次没有执行。'
    )
  }
  const approved = await deps.requestConfirm({
    toolCallId: options?.toolCallId ?? '',
    toolName: name,
    command: describeToolCall(name, source, input)
  })
  return approved
    ? null
    : `用户拒绝了这次调用：未执行「${name}」。请询问用户接下来希望怎么做，不要擅自重试同一步。`
}

/**
 * 给工具集套上钩子：`tool:call` 可改写入参、`tool:result` 可改写返回
 * （钩子名与范式见 `@fizz/plugin` 的 hooks.ts）。
 *
 * 只包「有 `execute` 的工具」——AI SDK 的工具约定；没有 `execute` 的对象
 * **原样返回**，保持引用不变（测试里的假工具就是这种）。
 *
 * 钩子里抛的错**不吞**：照常冒出去变成一次 tool-error（仓库「不许静默失败」的价值观）。
 */
export function wrapToolsWithHooks(
  tools: Record<string, unknown>,
  hooks: HooksService
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: unknown } | null)?.execute
    if (typeof execute !== 'function') {
      out[name] = tool
      continue
    }
    const run = execute as (input: unknown, ctx: unknown) => unknown
    out[name] = {
      ...(tool as object),
      execute: async (input: unknown, ctx: unknown): Promise<unknown> => {
        const realInput = hooks.waterfall(HOOKS.toolCall, [name, input], hookValue)
        const output = await run(realInput, ctx)
        return hooks.waterfall(HOOKS.toolResult, [name, output], hookValue)
      }
    }
  }
  return out
}