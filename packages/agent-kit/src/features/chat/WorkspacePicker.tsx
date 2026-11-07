/**
 * 工作区选择器 —— **受控版**：只吃 props，完全不知道 `AgentApp` 的存在。
 *
 * 从 `ChatPanel` 里抽出来，是因为「定时任务」表单也要同一套控件（用户明确要求：把创建
 * 会话里的权限 / 模型 / 工作区 / MCP / 需求框复用到定时任务上）。那边没有 `AgentApp`，
 * 只能吃 `value` + `onChange`，所以这里**只做展示与交互**，数据从 props 进。
 *
 * `ChatPanel` 里的 `WorkspaceSelect` 现在是薄壳：把 `app` 里的数据灌进来，再加自己的
 * 副作用（切档回空会话、添加项目）。样式与结构只有这一份实现 —— 别再在别处手写一份
 * `CHAT_PILL`，两处一漂看着就是两个功能。
 *
 * 其余同样受控、同样一个文件一颗的几颗：
 * - `PermissionPill`：`composer.tsx`（没有下拉，就一颗按钮）；
 * - `ModelPicker`：`ModelPicker.tsx`（会话详情与定时任务共用一份）；
 * - `McpPicker`：`McpPicker.tsx`（同上）；
 * - `BrowserPicker`：`BrowserPicker.tsx`（同上）。
 */
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fizz/ui/select'
import { ChevronDown, FolderOpen } from 'lucide-react'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

/**
 * 「未指定工作区」在 Select 里的替身值 —— **只在渲染层存在**，不落库、不进请求。
 *
 * Radix Select 不接受空字符串值，而「没选工作区」在状态里就是 `null`；这一层把它映射成
 * 一个哨兵字符串，`onChange` 时再换回 `null`。别把它传出去。
 */
const NO_WORKSPACE_VALUE = '__no_workspace__'

export interface WorkspacePickerProps {
  /** 选中的工作区 id；`null` = 不用现成工作区（真正落地时自动建一个临时目录） */
  value: string | null
  /** 可选项：**由调用方筛好**（临时工作区不该出现在下拉里，见 ChatPanel） */
  workspaces: AgentWorkspace[]
  onChange: (id: string | null) => void
  /** 「不选」那一项的文案：聊天是「未指定工作区」，定时任务是「每次运行自动创建」 */
  emptyLabel?: string
  /** 触发器悬停说明（讲清「不选」到底会发生什么） */
  title?: string
  /** 列表尾部的动作项（选择文件夹 / 从 Git 导入），点中走 `onAction`、不改变 value */
  actions?: { value: string; label: string }[]
  onAction?: (value: string) => void
  /**
   * 远端工作区所在主机的展示名（从 SSH 主机清单里查）。返回空 = 主机已删除
   * （此时显示「主机已删除」，`dirMissing` 的文案也不一样）。
   */
  remoteHostName?: (workspace: AgentWorkspace) => string | null
  disabled?: boolean
}

/**
 * 工作区 pill：一个下拉选「这条消息 / 这次运行落在哪个工作区」。
 *
 * 聊天里它挂在输入卡片**下面**、只在空会话出现；定时任务表单里它是普通的一颗 pill。
 * 两者语义一致：**`null` 不是一种归属**，只是「还没选」—— 真正的落地动作（建临时
 * 工作区）在服务端，前端只负责把这个意图送出去。
 *
 * 不长成下拉的 `Select` 也一样叫 Picker：这里四个选择器按「选什么」命名，不按控件形态。
 */
export function WorkspacePicker({
  value,
  workspaces,
  onChange,
  // 默认值在调用时求值：`t()` 读当前语言，切成英文后父级重渲染就会跟着变
  emptyLabel = t('未指定工作区'),
  title = t('工作区：Agent 只能读写这个目录里的东西'),
  actions,
  onAction,
  remoteHostName,
  disabled
}: WorkspacePickerProps) {
  // 订阅语言（默认值里的 t() 只在本组件重渲染时才会重算）
  useT()
  const current = value ? workspaces.find((workspace) => workspace.id === value) : undefined
  // 选中的那个已经不在清单里（被删 / 临时工作区没传进来）→ 退回「不选」，别显示成一个 id
  const selectValue = current ? current.id : NO_WORKSPACE_VALUE
  const label = current?.name ?? emptyLabel

  return (
    <Select
      value={selectValue}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === selectValue) return
        if (actions?.some((action) => action.value === next)) {
          onAction?.(next)
          return
        }
        onChange(next === NO_WORKSPACE_VALUE ? null : next)
      }}
    >
      <SelectTrigger
        className={CHAT_PILL}
        // 贴输入卡片外面：与卡片内的权限 pill 同一层视觉，仍不露默认箭头（自己画一枚小的）
        icon={false}
        aria-label={t('工作区')}
        title={title}
      >
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
      </SelectTrigger>
      {/* 一般贴在输入框下方，所以向下弹（Radix 会在贴底时自动翻转） */}
      <SelectContent position="popper" side="bottom" align="start" sideOffset={6}>
        <SelectItem value={NO_WORKSPACE_VALUE}>{emptyLabel}</SelectItem>
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
            {workspace.remote ? (
              <span className="text-muted-foreground">
                {' '}
                · {remoteHostName?.(workspace) ?? t('主机已删除')}
              </span>
            ) : null}
            {/* 目录被删 / 被移走（服务端巡检标的 `dirMissing`）：照旧可选 —— 选它是合法的
                （比如目录马上就回来了），但要让人先看见，别等保存 / 发送时才被服务端打回 */}
            {workspace.dirMissing ? (
              <span className="text-muted-foreground">
                {workspace.remote ? t('（远端目录不可用）') : t('（目录不存在）')}
              </span>
            ) : null}
          </SelectItem>
        ))}
        {(actions ?? []).map((action) => (
          <SelectItem key={action.value} value={action.value} className="text-primary">
            {action.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}


