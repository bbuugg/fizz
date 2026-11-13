/**
 * 「选择目录」弹窗：通用的目录浏览器。
 *
 * 默认数据源是**服务端本机**目录（web 端碰不到服务端文件系统，只能让 server 列目录
 * `GET /api/fs/dirs`、代劳建目录 `POST /api/fs/mkdir`），所以路径可直接编辑后回车跳转，
 * 也能进子目录 / 回上级 / 跳到某个盘符根 / **在当前目录下新建文件夹**。
 *
 * 也接受一个 `source` 适配器（`DirPickerSource`）：远端工作区（SFTP）那种「目录在另一台
 * 机器上」的场景复用**同一个弹窗**，只换列目录 / 建目录的实现，不另写一套浏览器。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 目录项（只列目录；文件选了也不能当工作区根） */
export interface DirPickerEntry {
  name: string
  path: string
}

/** 一次列目录的结果 */
export interface DirPickerListing {
  /** 当前目录的绝对路径 */
  path: string
  /** 上级目录；null = 已经在根 */
  parent: string | null
  /** 可跳转的根（多盘符才显示那一排） */
  roots?: DirPickerEntry[]
  /** 当前目录下的子目录 */
  entries: DirPickerEntry[]
}

/**
 * 目录浏览的数据源。默认实现读服务端本机文件系统；远端工作区传 SFTP 版本。
 */
export interface DirPickerSource {
  /** 列目录；`path` 为空串时由数据源决定起始目录（服务端是本机用户主目录） */
  list: (path: string) => Promise<DirPickerListing>
  /** 在 `parent` 下新建单层目录，返回新目录路径；不提供则不显示「新建文件夹」 */
  mkdir?: (parent: string, name: string) => Promise<string>
}

export function ServerDirPicker({
  app,
  source,
  open,
  onOpenChange,
  onPick,
  title,
  description,
  initialPath
}: {
  /** 默认数据源用的 AgentApp；给了 `source` 时可以不传 */
  app?: AgentApp
  /** 自定义数据源（远端工作区用 SFTP）；不传则走 `app` 的服务端目录接口 */
  source?: DirPickerSource
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用户确认了当前目录（绝对路径） */
  onPick: (path: string) => void
  /**
   * 副标题。默认文案是「登记为项目」—— 但这个组件早就被**别的用途**复用了
   * （笔记根、技能的额外目录、Git 导入的父目录、远端工作区），照默认写的那句话
   * 在那些地方是错的。复用方都该传一句说清「选中的目录会被拿去干什么」。
   */
  description?: string
  /** 弹窗标题；默认「选择目录」 */
  title?: string
  /** 打开时从哪个目录开始；缺省交给数据源（服务端是本机用户主目录） */
  initialPath?: string
}) {
  const tr = useT()
  const [data, setData] = useState<DirPickerListing | null>(null)
  /** 输入框里的路径：回车才跳转，免得边打字边发请求 */
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 「新建文件夹」输入行是否展开（列表顶部那一行） */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  /** 正在提交新建（期间禁掉输入与按钮，别让用户连点建出好几个） */
  const [creatingBusy, setCreatingBusy] = useState(false)

  /**
   * 数据源放 ref：默认实现每次渲染都会重建（`app` 每次都是新对象），
   * 直接进 `load` 的依赖会把「打开 → 请求 → setState → 新 source → 再请求」拖成死循环。
   */
  const sourceRef = useRef<DirPickerSource | null>(null)
  sourceRef.current =
    source ??
    (app
      ? {
          list: (path) => app.listServerDirs(path),
          mkdir: (parent, name) => app.createServerDir(parent, name)
        }
      : null)
  /** 打开时下一次加载从哪开始（同样走 ref，effect 只在「打开」时跑一次） */
  const initialPathRef = useRef(initialPath)
  initialPathRef.current = initialPath

  const load = useCallback(async (path: string): Promise<void> => {
    const src = sourceRef.current
    if (!src) return
    setLoading(true)
    setError(null)
    try {
      const result = await src.list(path)
      setData(result)
      setDraft(result.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // 每次打开都从数据源给的起点重新起（别留着上次的深层路径），顺手收起新建行
  useEffect(() => {
    if (!open) return
    setData(null)
    setError(null)
    setCreating(false)
    setNewName('')
    void load(initialPathRef.current ?? '')
  }, [open, load])

  /**
   * 在当前目录下建文件夹，**建完直接进去**（省一次点击：刚建的空目录本来就是想去的地方）。
   * 失败时保留输入行，让用户改个名字重试 —— 错误信息显示在列表区，输入内容不丢。
   */
  const createFolder = async (): Promise<void> => {
    const src = sourceRef.current
    if (!src?.mkdir || !data) return
    const name = newName.trim()
    if (!name) return
    setCreatingBusy(true)
    setError(null)
    try {
      const created = await src.mkdir(data.path, name)
      setCreating(false)
      setNewName('')
      await load(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingBusy(false)
    }
  }

  // 既没有 app 也没有 source：没有可用的目录来源，不画空弹窗
  if (!sourceRef.current) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        **高度固定**（用户要求）：不跟目录条数变。
        做法 = 弹窗给死高度（`h-[32rem]`）+ 纵向 flex，列表 `flex-1 min-h-0` 吃掉「扣掉头尾之后
        剩下的那部分」—— 条数变了只影响列表内部滚动，弹窗和列表盒子的高度都不动。
        原来是 `min-h-40 max-h-[45dvh]`：空目录 160px、目录一多涨到 45dvh，在目录之间来回切时
        整个弹窗跟着一跳一跳。
        `max-h-[85dvh]` 留着兜底：视口比 32rem 还矮时（横屏手机 / 小窗口）按视口缩，
        此时列表跟着缩，但**仍然不随条数变**。
        注意基础类里的 `grid` 会被这里的 `flex` 直接顶掉（`cn` 是 tailwind-merge 系，同组同修饰符去重）。
      */}
      <DialogContent className="flex h-[32rem] max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? tr('选择目录')}</DialogTitle>
          <DialogDescription>
            {description ??
              tr('这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="size-8 shrink-0 p-0"
            aria-label={tr('上一级')}
            disabled={!data?.parent || loading}
            onClick={() => {
              if (data?.parent) void load(data.parent)
            }}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(draft.trim())
            }}
            placeholder={tr('绝对路径，回车跳转')}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          {/* 新建文件夹：在**当前目录**下建（列表顶部展开一行输入），不是建到某个子目录里 */}
          {sourceRef.current.mkdir ? (
            <Button
              size="sm"
              variant="outline"
              className="size-8 shrink-0 p-0"
              aria-label={tr('新建文件夹')}
              title={tr('在当前目录下新建文件夹')}
              disabled={!data || loading || creating}
              onClick={() => {
                setCreating(true)
                setNewName('')
                setError(null)
              }}
            >
              <FolderPlus className="size-4" />
            </Button>
          ) : null}
        </div>

        {/* 多盘符（Windows）时给一排「跳到哪个盘」；单根（POSIX / SFTP）不必占地方 */}
        {(data?.roots?.length ?? 0) > 1 && (
          <div className="flex flex-wrap gap-1">
            {data?.roots?.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => void load(root.path)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-xs transition-colors',
                  root.path === data?.path
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                {root.name}
              </button>
            ))}
          </div>
        )}

        <div
          className={cn(
            // 列表盒固定高度：`flex-1` 拿「弹窗扣掉头/尾」的剩余空间，内部滚动。
            // 别写回 `min-h-40 max-h-[45dvh]` —— 那样盒子高度会跟着目录条数变（见上面 DialogContent 的注释）
            'min-h-0 flex-1 overflow-auto rounded-md border border-border/60',
            loading && data && 'opacity-60'
          )}
        >
          {/* 新建行贴顶：目录一多列表会滚，输入框不能跟着滚出去（autoFocus 也会把它带进视口） */}
          {creating && (
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5 backdrop-blur-sm">
              <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder()
                  // Esc 只收起这一行：stopPropagation 是拦 Radix 的 Dialog
                  // （它自己在 document 上听 Escape 关弹窗），拦不住也只是退回原行为
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreating(false)
                  }
                }}
                disabled={creatingBusy}
                placeholder={tr('新文件夹名字，回车创建')}
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!newName.trim() || creatingBusy}
                onClick={() => void createFolder()}
              >
                {tr('创建')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={creatingBusy}
                onClick={() => setCreating(false)}
              >
                {tr('取消')}
              </Button>
            </div>
          )}
          {/* 三种「没有列表项」的状态都撑满这个固定高度的盒子并垂直居中：
              盒子高度是定死的，再用 py-* 顶出来的话字全挤在上边缘 */}
          {loading && !data && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {tr('读取目录…')}
            </div>
          )}
          {error && (
            <p className="flex h-full items-center justify-center px-3 text-center text-xs text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && data?.entries.length === 0 && (
            <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              {tr('这个目录下没有子目录')}
            </p>
          )}
          {data?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void load(entry.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-secondary/60"
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        <DialogFooter className="items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={data?.path}
          >
            {data?.path}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            disabled={!data || loading}
            onClick={() => {
              if (!data) return
              onPick(data.path)
              onOpenChange(false)
            }}
          >
            {tr('选择此目录')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
