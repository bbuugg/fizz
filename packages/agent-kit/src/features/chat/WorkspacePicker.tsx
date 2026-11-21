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
 *
 * ## 长相来自 `@fizz/ui/picker-panel`（不要在这里改行高 / 底色）
 *
 * 面板是「顶部固定搜索 → 中间滚动列表 → 底部固定动作」三段，搜索框带底色、行首一枚图标、
 * 底部一整组动作只切一条上边线。这些**全部在 `PickerPanel` 那套原语里定型**：以后凡是
 * 「点开能搜、能滚、底部带几条动作」的选择器都该用它，长相自然一致。本文件只负责：
 * 把 `app` 里的数据灌进去、按搜索词筛好、把动作项翻成 `PickerAction`。
 *
 * 「未指定工作区」与添加类动作**同属底部那一组**，中间不再切一刀：它也是一次「选择」
 * （选「不用现成目录」），和「加一个新目录」是同一层动作（2026-11 用户要求）。
 */
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { Popover, PopoverTrigger } from '@fizz/ui/popover'
import {
  PickerAction,
  PickerEmpty,
  PickerFooter,
  PickerItem,
  PickerList,
  PickerPanel,
  PickerSearch
} from '@fizz/ui/picker-panel'
import { ChevronDown, Folder, FolderMinus, FolderOpen, FolderPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { CHAT_PILL } from '@fizz/agent-kit/features/chat/composer'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { t } from '@fizz/i18n'

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
  /**
   * 底部固定的动作项（选择文件夹 / 从 Git 导入…），点中走 `onAction`、不改变 value。
   * `icon` 由调用方给（动作的语义只有调用方知道），不传就是纯文字行。
   */
  actions?: { value: string; label: string; icon?: ReactNode }[]
  onAction?: (value: string) => void
  /**
   * 底部那条「新建工作区」：点它就等于去命令面板的「新建工作区」页。
   *
   * 不传就不画（定时任务表单走的是 `actions` 那一套，不要这条）。原样透传回调，
   * 具体「怎么开面板」不归本组件管 —— 聊天里是 `requestCommandPalette('new-workspace')`。
   */
  onNewWorkspace?: () => void
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
  onNewWorkspace,
  remoteHostName,
  disabled
}: WorkspacePickerProps) {
  // 订阅语言（默认值里的 t() 只在本组件重渲染时才会重算）
  useT()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  /** 搜索词：只活在一次打开里（关面板就清空，下次打开是完整历史） */
  const [query, setQuery] = useState('')

  const current = value ? workspaces.find((workspace) => workspace.id === value) : undefined
  const label = current?.name ?? emptyLabel

  /** 名字 / 目录路径 / 远端主机名，任一处命中即保留（不区分大小写） */
  const keyword = query.trim().toLowerCase()
  const filtered = keyword
    ? workspaces.filter((workspace) =>
        [workspace.name, workspace.path, remoteHostName?.(workspace) ?? '']
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(keyword))
      )
    : workspaces

  const close = (): void => setOpen(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        {/* 手写 button（不是 Select 了）：样式仍走 CHAT_PILL —— 前置图标、箭头大小 / 颜色
            必须和权限 / 模型那两颗 pill 对齐。触发器自己不渲染默认箭头，这里自己画一枚小的。 */}
        <button
          type="button"
          className={cn(CHAT_PILL, 'disabled:cursor-not-allowed disabled:opacity-50')}
          disabled={disabled}
          aria-label={t('工作区')}
          title={title}
        >
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      {/*
        向上弹，与权限 / 模型 / MCP / 附件那几颗一致（`side="top"` + 6px，贴边时 Radix 自动翻转）。

        这颗 pill 在**输入框下方**，向下弹等于往窗口底沿外顶 —— 空会话时输入框本来就靠底，
        面板会被视口裁掉一截。`side="top"` 是「触发器贴着底部」时唯一稳的方向，与宿主无关：
        定时任务表单里那几颗也是向上弹（见 `McpPicker` 的注释），别因为宿主不同就翻面。
      */}
      <PickerPanel
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        footer={
          <PickerFooter>
            {/* 「不选」与下面几条添加动作**同属一组**，中间不切分隔线（见文件头注释） */}
            <PickerAction
              icon={<FolderMinus />}
              active={value === null}
              onClick={() => {
                close()
                // 判据是 `value === null`（真的没选），不是 `current` —— 后者在「选中的那个
                // 已不在清单里」时也是 undefined，那样点一下不会把那个死 id 清掉
                if (value !== null) onChange(null)
              }}
            >
              {emptyLabel}
            </PickerAction>
            {onNewWorkspace ? (
              <PickerAction
                icon={<FolderPlus />}
                // 先关面板：命令面板会盖在这块上面，留着只会两层面板叠着
                onClick={() => {
                  close()
                  onNewWorkspace()
                }}
              >
                {t('新建工作区')}
              </PickerAction>
            ) : null}
            {(actions ?? []).map((action) => (
              <PickerAction
                key={action.value}
                icon={action.icon}
                // 先关面板：这些动作会开自己的弹窗 / 系统目录框，面板留着只会压在上面
                onClick={() => {
                  close()
                  onAction?.(action.value)
                }}
              >
                {action.label}
              </PickerAction>
            ))}
          </PickerFooter>
        }
      >
        <PickerSearch
          // 打开面板即可打字（桌面上搜索框就是唯一的入口）。
          // 手机上**不**自动聚焦：软键盘会在面板定位之后才弹出，Radix 算出的可用高度
          // 里没有它 —— 面板会被顶到键盘底下。那边点一下输入框再搜。
          autoFocus={!isMobile}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索工作区')}
          aria-label={t('搜索工作区')}
        />
        <PickerList>
          {filtered.map((workspace) => {
            const selected = workspace.id === value
            // 远端主机 / 目录不可用两条提示合成一段，挤在名字右边（面板只有 18rem 宽）
            const hint = [
              workspace.remote ? `· ${remoteHostName?.(workspace) ?? t('主机已删除')}` : '',
              workspace.dirMissing
                ? workspace.remote
                  ? t('（远端目录不可用）')
                  : t('（目录不存在）')
                : ''
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <PickerItem
                key={workspace.id}
                value={workspace.id}
                icon={<Folder />}
                hint={hint || undefined}
                active={selected}
                // 选中即生效：先关面板再改归属（父级会顺手回空会话 / 建临时工作区）。
                // 点中的就是当前那个 → 只关面板：`selectWorkspace` 会再落一次盘，
                // 而这一行只在空会话出现，重复选同一个本来就没有意义。
                onSelect={() => {
                  close()
                  if (!selected) onChange(workspace.id)
                }}
              >
                {workspace.name}
              </PickerItem>
            )
          })}
          {filtered.length ? null : (
            <PickerEmpty>{keyword ? t('没有匹配的工作区') : t('还没有工作区')}</PickerEmpty>
          )}
        </PickerList>
      </PickerPanel>
    </Popover>
  )
}
