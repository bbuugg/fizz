/**
 * 「保存请求 / 保存连接」对话框 —— HTTP 与 WebSocket 两页**共用这一份**。
 *
 * ## 为什么保存要弹它
 *
 * 分组是「归到哪儿」的一次性决定，不是每时每刻都在改的东西。原先 HTTP 页把它摆在
 * 工具栏上（占宽度、换分组时名称输入框还会左右跳），WS 页干脆没法分组。现在两边
 * 都是：点保存 / Ctrl+S → 这个弹窗 → 选分组（顺手能新建）→ 落盘。
 *
 * ## 名称是可选的
 *
 * `showName` 打开时（WebSocket 用）弹窗里多一颗名称输入框，初值来自请求页工具栏 ——
 * 那边已经输过名字就直接回填，没输就当场补（WS 的连接名是必填的，见 `nameRequired`）。
 * HTTP 页不传 `showName`：那边名称就在工具栏上、且允许留空。
 *
 * ## 分组按 tree 状展示
 *
 * 用 `flattenGroupRows` 摊平成「缩进行」（`depth` 交给样式做缩进），而不是 Radix Select：
 * 分组本来就该看得出层级，且选项不多，摊开比「点开 → 找 → 再点」快。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import type { ApiGroup, ApiRequestEntry } from '@fizz/contracts/types'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { buildGroupTree, type GroupNode } from '@fizz/agent-kit/shared/lib/group-tree'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

type ApiGroupNode = GroupNode<ApiGroup, ApiRequestEntry>

/**
 * 分组树摊平成「缩进行」：`depth` 0 = 顶级，每深一级多缩进 14px。
 *
 * 存 `depth` 而不是拼全角缩进 —— 那是给 Radix Select 用的老办法（它不支持嵌套选项），
 * 渲染成列表后缩进交给样式，文案保持干净。
 */
interface GroupTreeRow {
  id: string
  name: string
  depth: number
}

export function flattenGroupRows(groups: ApiGroup[]): GroupTreeRow[] {
  const out: GroupTreeRow[] = []
  const walk = (nodes: ApiGroupNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ id: node.group.id, name: node.group.name, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(buildGroupTree(groups, []), 0)
  return out
}

/**
 * 一行分组（tree 状：`depth` 决定左缩进）。
 *
 * 缩进用**内联 `paddingLeft`**：depth 是数据，Tailwind 生成不出动态类。
 * 选中态是「淡主色底 + 行尾勾」，与命令面板 / 选择器面板同一套语言，别换成描边或加粗。
 */
function GroupPickRow({
  label,
  depth = 0,
  selected,
  onSelect
}: {
  label: string
  /** 0 = 顶级；每深一级多缩进 14px */
  depth?: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-hidden select-none',
        selected ? 'bg-primary-subtle text-foreground' : 'hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <Check className="size-3.5 shrink-0" /> : null}
    </button>
  )
}

export interface ApiSaveDialogProps {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** 打开时回填的名称（请求页工具栏里已经输入的那个） */
  defaultName?: string
  /** 打开时回填的分组（已保存的条目 = 它原来的分组） */
  defaultGroupId?: string
  /** 是否显示名称输入框（WebSocket 用；HTTP 的名称在工具栏上） */
  showName?: boolean
  /** 名称为空时禁用「保存」（WebSocket 的连接名必填） */
  nameRequired?: boolean
  namePlaceholder?: string
  /** 落盘中（禁用按钮） */
  saving?: boolean
  onConfirm: (input: { name: string; groupId: string | undefined }) => void
}

export function ApiSaveDialog({
  app,
  open,
  onOpenChange,
  title,
  description,
  defaultName = '',
  defaultGroupId,
  showName = false,
  nameRequired = false,
  namePlaceholder = '名称',
  saving = false,
  onConfirm
}: ApiSaveDialogProps) {
  const [name, setName] = useState(defaultName)
  const [groupId, setGroupId] = useState<string | undefined>(defaultGroupId)
  const [newGroupName, setNewGroupName] = useState('')
  const [creating, setCreating] = useState(false)

  /**
   * 只在**打开的那一刻**回填，之后用户在里面打字不会被父级重渲染打回
   * （依赖里放 `open` 的翻转，而不是每次 `defaultName` 变化）。
   */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setName(defaultName)
      setGroupId(defaultGroupId)
      setNewGroupName('')
    }
    wasOpen.current = open
  }, [open, defaultName, defaultGroupId])

  const groupRows = useMemo(() => flattenGroupRows(app.apiGroups), [app.apiGroups])

  /**
   * 新建分组：建完**自动选中**它 —— 用户的下一步一定是「保存到刚建的这个组里」。
   * `saveApiGroup` 只回 bool，建好的那条要从 store 里按名字找回来（列表刚被刷新过）。
   */
  const createGroup = async (): Promise<void> => {
    const next = newGroupName.trim()
    if (!next || creating) return
    setCreating(true)
    try {
      const ok = await app.saveApiGroup({ name: next })
      if (!ok) return
      const created = useAgentStore.getState().apiGroups.find((g) => g.name === next)
      if (created) setGroupId(created.id)
      setNewGroupName('')
    } finally {
      setCreating(false)
    }
  }

  const submit = (): void => {
    if (nameRequired && !name.trim()) return
    onConfirm({ name: name.trim(), groupId })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[400px]"
        // 弹窗是 portal 出去的，页根的 `onKeyDown` 收不到：Ctrl/Cmd+S 在这里再兜一次，
        // 免得「按了没反应」
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {showName ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">名称</div>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                onKeyDown={(e) => {
                  // 这里的 Enter 是「确认保存」，别让它继续冒泡到别处
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">分组</div>
            {/* 列表自己滚（`max-h-56`）：分组再多也不会把弹窗顶到屏幕外 */}
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border p-1">
              <GroupPickRow
                label="未分组"
                selected={groupId === undefined}
                onSelect={() => setGroupId(undefined)}
              />
              {groupRows.map((row) => (
                <GroupPickRow
                  key={row.id}
                  label={row.name}
                  depth={row.depth}
                  selected={groupId === row.id}
                  onSelect={() => setGroupId(row.id)}
                />
              ))}
              {groupRows.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">还没有分组，可以在下面新建。</p>
              ) : null}
            </div>
          </div>
          {/* 顺手新建：建完自动选中它，不用再回列表里找一遍 */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">新建分组</div>
            <div className="flex items-center gap-2">
              <Input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="新分组名称，如：用户中心"
                className="h-8 min-w-0 flex-1"
                onKeyDown={(e) => {
                  // 这里的 Enter 是「建这个组」，不是「保存」
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    void createGroup()
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!newGroupName.trim() || creating}
                onClick={() => void createGroup()}
              >
                新建
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {/* 没有名称输入框时（HTTP）把焦点落在「保存」上：Ctrl+S 打开弹窗后直接回车
              就落盘，分组默认是它原来那个 —— 改归属才需要动鼠标 */}
          <Button
            autoFocus={!showName}
            disabled={saving || (nameRequired && !name.trim())}
            onClick={submit}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
