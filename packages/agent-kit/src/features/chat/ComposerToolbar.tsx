/**
 * 输入框卡片**上方**的工具条：一排「给这一轮对话装 / 卸能力」的开关。
 *
 * 这一排是「**给这一轮装能力**」的开关，与输入框卡片内 `leading` / `trailing` 那排
 * 「这一轮用什么」的紧凑 pill（工作区 / 权限 / 模型 / 上下文）分开：
 *
 * - **浏览器**：内置的 `browser_*` 工具集（连同系统提示词里那段浏览器说明）。它原本是
 *   设置页「通用 → 浏览器」里的一个开关，挪到这里是为了「想用浏览器时随手就能开」。
 *   现在**只有一颗开关**：单击开、再点关（来源统一走 Playwright 自带的 headless shell，
 *   见 `BrowserPicker`）。
 *   浏览器**没装**（headless shell 没下载）时这颗**不出现** —— 装了才有的能力，按钮先
 *   摆出来只会让人点了在下一轮拿到 `Executable doesn't exist`。装 / 卸在设置 → 浏览器。
 * - **MCP**：按会话挑要用哪几个 MCP server（原先挂在 `trailing` 里紧挨模型选择器，
 *   那是「用什么」的 pill，与浏览器分家；同属能力装配，挪到这里与浏览器并排）。
 *
 * **一颗都不剩时整条不渲染**：空容器仍占一行高度，输入框上方会多出一道空行；
 * 而且用户既然既没装浏览器、也没配 MCP，这条横条就没有任何信息量。
 *
 * 位置对齐由 `ChatComposer` 的 `above` 壳保证（与输入框、消息列同一宽度）。
 *
 * ⚠️ 开关是**按会话**的（存在会话自己身上，`AgentConversation.browserSettings`）：
 * 每个会话可以各不相同，新建会话以全局默认值为初值。改完**下一轮对话**生效。
 *
 * 与外部 `playwright-mcp` 的同名冲突**不用手动处理**：装配时若这个会话挂了带同名工具的
 * MCP，内置的 `browser_*` 会自动让位（见 `apps/server/src/server/chat-turn.ts`）。
 */
import { BrowserPicker } from '@fizz/agent-kit/features/chat/BrowserPicker'
import { composerToolbarState } from '@fizz/agent-kit/features/chat/session-backend'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { Globe, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 工具条容器：横排一排能力开关。
 *
 * 浏览器与 MCP 都是「给这一轮装能力」，语义同族，所以并排放在这里（MCP 原先挂在输入框
 * 右侧 `trailing` 那排 pill 里，紧挨模型选择器 —— 那是「这一轮用什么」的紧凑 pill，
 * 而「挑哪几个 MCP server」是**能力装配**，混进去既挤又与浏览器分家）。
 *
 * `children` 目前唯一来源是 `McpSelect`；**加新的同类开关时，`hidden` 的判据要跟着补**
 * （这里靠 `app.mcpServers.length` 判断 MCP 那颗会不会出现）。
 */
export function ComposerToolbar({ app, children }: { app: AgentApp; children?: ReactNode }) {
  const { browser, browserPlaceholder, mcp } = composerToolbarState(app)
  if (!browser && !browserPlaceholder && !mcp) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {browser && <BrowserToggle app={app} />}
      {/* 新对话切到 ACP 时仅为浏览器留位，MCP 仍是可操作的真实控件。 */}
      {browserPlaceholder && (
        <span aria-hidden className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground">
          <Globe className="size-3.5 shrink-0" />
        </span>
      )}
      {children}
    </div>
  )
}

/**
 * 定时任务表单选外部 Agent 时的同高占位（见 `TriggerEditDialog`）。
 * 会话输入框不使用整排占位：ACP 的 MCP 仍可选，浏览器占位由上面的工具条单独处理。
 *
 * 但那个页面**不能整行不渲染**：`above` 槽位里少了这一行，输入框卡片会往上跳 32px ——
 * 在那里当场把模型从内置切到外部 Agent 时整块输入区上下抖（用户反馈过）。所以画两颗
 * 灰掉、不可点的图标把高度占住，tooltip 说明为什么点不了。
 *
 * ⚠️ `browser` / `mcp` 必须与真的 `ComposerToolbar` 用**同一套判据**（浏览器没装 /
 * 没配 MCP 时真工具条少一颗或整条不渲染），否则切回内置 agent 时高度对不上，照样抖。
 * 两颗都为 false 时占位自己也返回 null。
 *
 * 尺寸必须与 `CHAT_ICON_PILL` 对齐（`size-8`），否则占位高度和真工具条差几像素；
 * 这里不复用 `CHAT_ICON_PILL` 是因为它带 hover 变色，灰占位被 hover 染色会像「能点」。
 */
export function ComposerToolbarPlaceholder({
  browser = true,
  mcp = true
}: {
  browser?: boolean
  mcp?: boolean
}) {
  if (!browser && !mcp) return null
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      title="外部 Agent 自带工具，浏览器 / MCP 开关对它不生效"
      aria-hidden
    >
      {browser && (
        <span className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40">
          <Globe className="size-3.5 shrink-0" />
        </span>
      )}
      {/* 与 `McpSelect` 同一条规矩：一个 server 都没配时那颗本来就不出现，占位也跟着不画，
          宽度才和切回内置 agent 时一致 */}
      {mcp && (
        <span className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40">
          <Wrench className="size-3.5 shrink-0" />
        </span>
      )}
    </div>
  )
}

/**
 * 浏览器开关（**按会话**，见文件头）。
 *
 * 长相与全部交互在 `BrowserPicker`（定时任务表单也用同一颗 —— 浏览器工具跑在服务端，
 * 无人值守的任务一样能用）。这里只负责把 `app` 里「这个会话的偏好」灌进去，
 * 并把改动落回会话。
 */
function BrowserToggle({ app }: { app: AgentApp }) {
  return (
    <BrowserPicker
      // 会话没设过时 `agentAppFrom` 已经兜成常量默认（关 + bundled），这里不会有 null
      value={app.browserSettings}
      // 乐观更新 + fire-and-forget 持久化到会话，与 MCP 的 `setMcpServerIds` 同一套
      onChange={app.saveBrowserSettings}
    />
  )
}
