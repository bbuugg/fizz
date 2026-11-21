"use client";

/**
 * 「新建 / 编辑脚本」对话框（`ScriptsPanel` 持有）。
 *
 * ## 为什么从「一个脚本一条编辑标签」改成对话框
 *
 * 编辑页（`ScriptsPage`，已删除）是**主区域一整页**：为改三行命令开一条标签，改完还要
 * 关掉；连着建几个脚本就在标签条上堆一排 `script:<id>`。脚本清单本身已经是主区域的
 * `scripts:list` 单例页，编辑再开一页等于「从清单点进另一页、再返回」，中间那层标签
 * 没有任何信息价值。
 *
 * 改成模态框之后：清单一直在背后，保存即刷新，连续建 / 改几个都不用离开这一页。
 * **代价是编辑态只有一份**：正文不再有「标签页自动保存」那条路，所以这里必须
 * **显式保存**，关窗时若有改动就问一句（`useConfirm`）—— 这是它取代自动保存的方式，
 * 别把自动保存再加回来（两份编辑态互相覆盖正是当初 `script:<id>` 一脚本一标签的理由）。
 *
 * ## 分组不在这里改
 *
 * 归属分组有两条现成的路（拖拽 / 右键「移出分组」/ 分组行的「+」新建到该组），这里
 * 再放一个下拉就得处理「清空归属」的语义（服务端 `saveScript` 是 `{...prev, ...input}`，
 * 传 `groupId: undefined` 等于把脚本从组里踢出去，不传才是「不动」）。少一个入口，
 * 少一类坑。新建时只把**进来的那个分组**透传下去（从组内「+」新建）。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
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
import MonacoEditor from '@fizz/agent-kit/features/files/MonacoEditor'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { ScriptEntry } from '@fizz/contracts/types'

export function ScriptEditDialog({
  app,
  open,
  script,
  defaultGroupId,
  onOpenChange,
  onSaved
}: {
  app: AgentApp
  open: boolean
  /** 要编辑的脚本；`null` / 不传 = 新建 */
  script?: ScriptEntry | null
  /** 新建时的归属分组（从分组行的「+」或右键进来时带上） */
  defaultGroupId?: string
  onOpenChange: (open: boolean) => void
  /** 落盘成功之后（关窗之前）调一次：调用方用它展开新建脚本所在的分组 */
  onSaved?: () => void
}) {
  const confirm = useConfirm()

  /**
   * 本次要编辑的脚本：**打开时**取 props，**关窗动画期间**沿用上一次的值。
   *
   * 直接读 `script` 不行：调用方在关窗时把 `script` 置空（`setEdit(null)`），而 Radix 的
   * 退出动画还要再挂 ~150ms —— 那段时间标题会从「编辑脚本」闪成「新建脚本」。
   */
  const lastScript = useRef<ScriptEntry | null>(script ?? null)
  if (open) lastScript.current = script ?? null
  const active = open ? (script ?? null) : lastScript.current
  const editing = Boolean(active)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  /**
   * 每次打开（或换了个脚本）从数据源灌一遍草稿。
   *
   * 依赖只认 `script?.id`、**不认对象身份**：脚本清单每次刷新（保存 / WS 推送）都会
   * 换一批新对象，按对象做依赖就会在打字过程中把草稿重置掉。
   */
  useEffect(() => {
    if (!open) return
    setName(script?.name ?? '')
    setDescription(script?.description ?? '')
    setContent(script?.content ?? '')
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, script?.id])

  /** 与打开时那份比：有没有动过（决定关窗要不要问一句） */
  const dirty =
    name !== (active?.name ?? '') ||
    description !== (active?.description ?? '') ||
    content !== (active?.content ?? '')

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const ok = await app.saveScript({
        ...(active ? { id: active.id } : {}),
        name: trimmed,
        // 传空串而不是 `undefined`：`undefined` 在 JSON 里会被整个丢掉，服务端于是
        // 保留旧值 —— 用户「把描述清空」就永远清不掉。
        description: description.trim(),
        content,
        // 编辑时不带 `groupId`（服务端 `{...prev, ...input}` 会继承旧归属）；
        // 新建时只在「从某个分组里进来」的情况下带上它。
        ...(!active && defaultGroupId ? { groupId: defaultGroupId } : {})
      })
      if (!ok) {
        toast.error('保存失败')
        return
      }
      toast.success(editing ? '已保存' : '已新建脚本')
      onSaved?.()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  /** 保存的**最新**一份引用：Ctrl/Cmd+S 的监听只挂一次，不能因为重渲染反复解绑 */
  const saveRef = useRef(save)
  saveRef.current = save

  /** Ctrl/Cmd+S 直接保存（沿用编辑页的老习惯，别让手熟的人以为卡住了） */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /** 有未保存的改动时，关窗先问一句（Esc / 点遮罩 / 取消都走这里） */
  const requestClose = async (): Promise<void> => {
    if (dirty && !saving) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        description: editing
          ? '这个脚本改了还没保存，关掉的话这些修改会丢掉。'
          : '这个新脚本还没保存，关掉的话刚写的内容会丢掉。',
        confirmLabel: '放弃修改',
        cancelLabel: '继续编辑',
        destructive: true
      })
      if (!ok) return
    }
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 只拦「关」：打开由调用方控制（`open` 是 props），这里没有开的分支
        if (!next) void requestClose()
      }}
    >
      {/* 高度封顶 + 内部滚动：`HostDialog` 同一套（编辑器给固定高度，头部 / 脚注不滚） */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 overflow-hidden sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑脚本' : '新建脚本'}</DialogTitle>
          <DialogDescription>
            脚本是一段可复用的命令，运行时挑任意一台主机，内容会逐行写进那条终端。
          </DialogDescription>
        </DialogHeader>

        {/* 中段自己滚：窗口矮的时候（手机上横屏尤其明显）至少能滚到编辑器底部，
            而不是被 `overflow-hidden` 把脚注一起裁掉。
            `data-dialog-scroll`：滚动条贴弹窗右沿，且没条时右侧也留满 16px（见 styles.css）。 */}
        <div data-dialog-scroll="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">名称</div>
            <Input
              variant="muted"
              autoFocus
              value={name}
              placeholder="脚本名称，如：重启服务"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">描述（可选）</div>
            <Input
              variant="muted"
              value={description}
              placeholder="一句话说明它做什么"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">命令</div>
            {/*
              固定高度而不是 `flex-1`：对话框本身是 `max-h` 封顶，编辑器用 `flex-1` 时
              高度会随内容 / 视口跳，Monaco 每次都要重新 layout。
              `showHeader={false}` 去掉语言 / 行号那排工具栏 —— 脚本恒为 shell，选语言没意义。
            */}
            <div className="h-[46vh] min-h-[180px] overflow-hidden rounded-md border">
              <MonacoEditor
                value={content}
                onChange={setContent}
                language="shell"
                showHeader={false}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => void requestClose()}>
            取消
          </Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
