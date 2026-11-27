/**
 * MCP 选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 分工与 `ModelPicker` 一致：
 * - 本文件：渲染 + 交互，`servers` / `value` / `onChange` 全从 props 进；
 * - `ChatPanel` 的 `McpSelect`（会话）：灌 `app.mcpServers`、接 `setMcpServerIds`
 *   （选完即时持久化到会话）；
 * - `TriggerEditDialog`（定时任务）：接表单自己的局部状态，随模板一起落库。
 *
 * 从原来那个 `pickers.tsx`（已拆散成四个单文件组件）里独立出来，是因为它与会话详情
 * 那颗模型 pill 是**同一种东西**（「这条会话装什么能力」），而工作区 / 浏览器各管不同的
 * 维度。拆开后两处仍然只有**一份实现** —— 别在别处再手写一颗扳手 pill。
 *
 * ## 语义：按会话挑，不是配置启停
 *
 * 选的是「这条会话 / 这次运行允许用哪几个 server」：设置 → MCP 里配好就存在，这里只是
 * 挑。默认一个不选（存量会话天然如此），选中的下一轮才接进工具集，未选的不起进程
 * （见 `app/api/chat/route.ts`）。选「全不选」等价于清空。
 *
 * 清单为空时**整颗不渲染**：没有可选的东西就别在工具条上占一个位置（配置入口在
 * 设置 → MCP，那是另一件事）。
 */
import type { McpServerConfig } from '@fizz/mcp/types'
import { mcpServerSummary } from '@fizz/mcp/types'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Wrench } from 'lucide-react'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

export interface McpPickerProps {
  /** 设置 → MCP 里配好的清单（空 = 整颗 pill 不渲染） */
  servers: McpServerConfig[]
  /** 已选中的 server id */
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

/**
 * MCP pill：多选下拉，触发器只放图标 + 数量角标。
 *
 * 只认**当前还存在**的 server：设置里删掉某个之后，本地那份清单要等下一次 WS 推送才清掉，
 * 在那之前直接按它算数量会显示「MCP · 2」却只剩一个可选 —— 看着像 bug。
 * 服务端 `setConversationTarget` 也会剔除已删除的 id，两边一致。
 */
export function McpPicker({ servers, value, onChange, disabled }: McpPickerProps) {
  // 订阅语言（aria-label / 分组标题都是渲染期求值的）
  useT()
  if (servers.length === 0) return null

  const selected = value.filter((id) => servers.some((server) => server.id === id))
  const count = selected.length

  const toggle = (id: string, on: boolean): void => {
    if (disabled) return
    onChange(on ? [...selected, id] : selected.filter((x) => x !== id))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 触发器只放图标：已选数量收成右上角小角标（0 个不显示），选了哪些进 tooltip */}
        <button
          type="button"
          disabled={disabled}
          aria-label={count > 0 ? t('选择 MCP（已选 {count} 个）', { count }) : t('选择 MCP')}
          className={cn(CHAT_ICON_PILL, 'relative')}
        >
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          {count > 0 && (
            <span
              className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[0.5625rem] leading-3.5 font-medium text-primary-foreground tabular-nums"
              aria-hidden
            >
              {count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      {/* 与模型 / 浏览器 / 权限几颗 pill 统一口径：向上弹 + 6px 间距 + 8px 碰撞留白。
          表单里也向上弹 —— 同一条规矩不该因为宿主不同就翻面（见 `composer.tsx`）。 */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="min-w-56"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
          {t('选择 MCP')}
        </DropdownMenuLabel>
        {servers.map((server) => (
          <DropdownMenuCheckboxItem
            key={server.id}
            checked={selected.includes(server.id)}
            disabled={disabled}
            // 受控：勾选状态由外部清单决定，回车 / 点左侧方块都走同一个 toggle。
            // `preventDefault` 是关键 —— 否则 Radix 选中后立刻关闭菜单，多选根本没法连点。
            onCheckedChange={(v) => toggle(server.id, v === true)}
            onSelect={(e) => e.preventDefault()}
            title={mcpServerSummary(server)}
          >
            <span className="truncate">{server.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
