/**
 * 目录浏览器：**一块本体 + 两副外壳**。
 *
 * ## 两副外壳
 *
 * - `ServerDirPicker`：独立弹窗。表单里的「选择文件夹…」（Git 导入的父目录、笔记根、
 *   技能额外目录、远端工作区）用它 —— 那些地方自己已经是弹窗，再压进面板反而绕。
 * - 命令面板的**目录页**（`CommandPalette` 的 `dir` 页）：直接压在面板栈上，
 *   `Esc` / 左上返回退回上一级页面（如「新建工作区」），不必「关面板 → 重开 → 再点一次」。
 *
 * 两处共用 `DirectoryBrowser`：顶栏（返回 · 路径 · 新建文件夹 · 添加 ⌘⏎）、
 * 目录清单（第一行 `..` + 子目录）、键位语义全在这一份里，差别只有外壳、宽度与底栏提示。
 * 复制一份出来改，迟早出现「弹窗里 ⌘⏎ 能用、面板里不能」这类漂移。
 *
 * ## 键盘语义（两处一致）
 *
 * - `↑` `↓` 选行，`⏎`（或鼠标点击）**进入**它 —— 一路往深处走不用碰鼠标；
 * - 输入框里的路径**被改过**时，`⏎` 是「跳到这个路径」（`preventDefault` 挡住 cmdk
 *   根节点上那个「选中当前高亮项」）；
 * - `⌘/Ctrl + ⏎` 与右上角那颗按钮是**添加当前目录**（唯一把路径交回调用方的出口）。
 *   `⏎` 已经被「进入」占了，所以添加必须换一个键 —— 按钮上的键帽写的就是它；
 * - `Backspace` 上一级（清单第一行那颗 `..` 也是它）；`⌘/Ctrl + ↑` 同义，两个地方都能按。
 *   焦点在路径输入框里时 `Backspace` 是删字，不拦 —— 那里拦下来会把「改路径」变成「乱跳目录」；
 * - `Esc`：弹窗里是关闭、面板里是退回上一级页面 —— 这层归外壳管，本体不拦。
 *
 * 默认数据源是**跑 Agent 那台机器**的目录（浏览器碰不到文件系统，只能让 server 列目录
 * `GET /api/fs/dirs`、代劳建目录 `POST /api/fs/mkdir`；桌面端本机就是服务端，但走的仍是
 * 同一个接口 —— 一份实现三端通用），所以路径可直接编辑后回车跳转，也能进子目录 / 回上级 /
 * 跳到某个盘符根 / **在当前目录下新建文件夹**。
 *
 * 也接受一个 `source` 适配器（`DirPickerSource`）：远端工作区（SFTP）那种「目录在另一台
 * 机器上」的场景复用**同一块本体**，只换列目录 / 建目录的实现，不另写一套浏览器。
 *
 * ## 底栏右下角只有一枚（桌面端才有）
 *
 * `使用系统文件选择器`（`SystemDirPickerLink`）：换条路进 —— 系统框认得收藏夹与上次打开的
 * 位置，比一层层点进去快。原先并排的「在文件管理器中打开」已删：两枚都在做「去系统那边」，
 * 挤在同一行会把左边那排键位提示逼得折行。
 *
 * 远端工作区（`source` 是 SFTP）不画：那目录不在这台机器的文件系统里。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Check, Folder, FolderPlus, FolderSearch, Loader2 } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  CommandDialog,
  CommandFooter,
  CommandFooterHint,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@fizz/ui/command'
import { Input } from '@fizz/ui/input'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { formatShortcut } from '@fizz/agent-kit/shared/lib/shortcuts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
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

/**
 * 浏览本体：顶栏（上一级 · 路径 · 新建 · 添加）+ 目录清单。
 *
 * 只管「浏览 + 选定」，**不画外壳也不管开关**：弹窗传 `active={open}`，
 * 命令面板的目录页一直是打开的（页面本身挂载即生效）。
 */
export function DirectoryBrowser({
  app,
  source,
  active = true,
  initialPath,
  leading,
  listClassName,
  onPick
}: {
  /** 默认数据源用的 AgentApp；给了 `source` 时可以不传 */
  app?: AgentApp
  /** 自定义数据源（远端工作区用 SFTP）；不传则走 `app` 的服务端目录接口 */
  source?: DirPickerSource
  /** 是否处于「打开」状态：切到 true 才加载，切回 false 清现场 */
  active?: boolean
  /** 打开时从哪个目录开始；缺省交给数据源（服务端是本机用户主目录） */
  initialPath?: string
  /**
   * 顶栏最左侧的外壳动作（命令面板那枚「返回上一级页面」）。
   *
   * 不传 = 顶栏左边什么都不画（弹窗外壳就是这种：它没有「上一级页面」可回，
   * 上一级**目录**是清单第一行的 `..`）。
   */
  leading?: ReactNode
  /**
   * 清单的高度类，**会整个替换**默认那条 `h-[min(20rem,calc(85dvh_-_10rem))]`
   * （不是叠加，别两条高度一起生效）。
   *
   * - 不传：清单自己定高（面板页走这条，外壳高度是内容撑的）；
   * - 外壳自己定了高度时传 `flex-1 min-h-0`（弹窗走这条，清单吃满剩下的那块）。
   *
   * **别再传 `max-h`** —— 那是「高度跟内容走」，加载完一长条清单就会把外壳顶高、
   * 顶栏与底栏跟着跳。
   */
  listClassName?: string
  /** 用户确认了当前目录（绝对路径） */
  onPick: (path: string) => void
}) {
  const tr = useT()
  const isMobile = useIsMobile()
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

  /**
   * 打开时把焦点放到本体上，**不放在路径输入框里**。
   *
   * 底栏写着 `Backspace 上一级`（与参考 UI 一致）：焦点在输入框里的话它是删字，
   * 提示就成了假的。焦点在本体上时所有键都冒泡到 cmdk 根，↑↓ / ⏎ / Backspace / Esc
   * 全部按底栏说的来；想敲路径点一下顶栏那行即可（反正列表不参与过滤，打开就打字没意义）。
   *
   * 用 rAF 而不是直接 focus：Radix 打开时自己会聚焦一次，抢在它后面才留得住焦点。
   */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => rootRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [active])

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
    if (!active) return
    setData(null)
    setError(null)
    setCreating(false)
    setNewName('')
    void load(initialPathRef.current ?? '')
  }, [active, load])

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

  /** 添加当前目录（右上角按钮 / ⌘⏎）：唯一把路径交回调用方的出口 */
  const pickCurrent = (): void => {
    if (!data || loading) return
    onPick(data.path)
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // 路径被改过：⏎ 是「跳到这个路径」。必须挡住 cmdk 根节点上的 Enter，
    // 否则它会去点「当前高亮的那一行」，把用户跳转的意图吃掉。
    // 带 ⌘/Ctrl 的 ⏎ 不在此列 —— 那是「添加当前目录」，交给根节点的处理。
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && draft.trim() !== (data?.path ?? '')) {
      e.preventDefault()
      const next = draft.trim()
      if (next) void load(next)
      return
    }
    // 输入框里的 Backspace 是删字，所以「上一级」走 ⌘/Ctrl + ↑（鼠标走左边那颗箭头）
    if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && data?.parent) {
      e.preventDefault()
      void load(data.parent)
    }
  }

  /**
   * 本体的键盘处理：cmdk 自己的 `onKeyDown`（↑↓ / ⏎ 选行）在 `defaultPrevented`
   * 时会跳过，`⌘⏎` / `Backspace` 这种它不认识的组合正好在这里补齐。
   *
   * 挂在本体最外层（不是外壳的根节点）：两副外壳都靠事件冒泡吃到这里，
   * 弹窗和面板不用各写一遍。
   */
  const onCommandKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      pickCurrent()
      return
    }
    /*
      Backspace 回上一级（底栏写的就是这一条）。焦点在路径输入框里时**不拦** ——
      那里它是删字，拦下来会把「改路径」变成「乱跳目录」。
    */
    if (e.key === 'Backspace' && !(e.target instanceof HTMLInputElement) && data?.parent) {
      e.preventDefault()
      void load(data.parent)
    }
  }

  if (!sourceRef.current) return null

  const canMkdir = Boolean(sourceRef.current.mkdir)
  /**
   * 多盘符（Windows）时顶部那排「跳到哪个盘」是否出现。
   *
   * 它是**数据回来之后**才出现的：面板高度若跟着长，刚进目录页会先到一个高度、
   * 列完盘符再蹿到另一个高度（用户反馈的「中间有顿感」）。所以列表高度里预留它的位置
   * （见下面 `listClassName` 的兜底），并在那一排上强制**单行横向滚动**，高度是固定值。
   */
  const hasRootRow = (data?.roots?.length ?? 0) > 1
  /** 上一级目录；null = 已经在根（清单第一行那颗 `..` 靠它，没有就不画） */
  const parentDir = data?.parent ?? null

  /** 列表区的三种「没有目录项」状态：撑满剩余空间并居中（不写 h-full，列表是 flex 列） */
  const statusLine = (content: ReactNode, destructive = false): ReactNode => (
    <div
      className={cn(
        'm-auto max-w-[32rem] px-4 py-10 text-center text-xs',
        destructive ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {content}
    </div>
  )

  return (
    /* 本体只有「顶栏 + 清单」两块，纵向 flex：外壳决定高度，清单吃剩下那部分。
       `min-h-0` 一路传下去，否则固定高度的外壳里列表会撑破边界。
       `tabIndex={-1}` + 上面那个 focus effect：打开时焦点在这块上而不是路径输入框里。 */
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={onCommandKeyDown}
    >
      {/* 头一块：← 返回 · 路径 · 新建文件夹 · 选择。多盘符那一排也归这里，
          统一由外层那条 border-b 和列表分开 */}
      <div className="shrink-0 border-b border-border/60">
        <CommandInput
          leading={leading}
          // 目录浏览不放放大镜：图标位让给路径本身（`false` = 不画）
          icon={false}
          value={draft}
          onValueChange={setDraft}
          onKeyDown={onInputKeyDown}
          placeholder={tr('绝对路径，回车跳转')}
          /*
            路径是「我在哪」，不是要填的字段：跟着标题字号走、不加边框。
            `CommandInput` 本来就是无底色的一行，这里只把 `text-sm` 顶成 `text-base`。
          */
          className="text-base text-foreground"
          trailing={
            <>
              {canMkdir ? (
                <IconTip label={tr('在当前目录下新建文件夹')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={tr('新建文件夹')}
                    disabled={!data || loading || creating}
                    onClick={() => {
                      setCreating(true)
                      setNewName('')
                      setError(null)
                    }}
                  >
                    <FolderPlus className="size-4" />
                  </Button>
                </IconTip>
              ) : null}
              {/*
                确认按钮收成**纯图标**（与左边「新建文件夹」那颗同款 ghost 按钮）：
                这一行已经有一个路径输入和一颗图标钮，再来一块带文字 + 键帽的实心按钮，
                视觉重量比内容本身还重。动作与快捷键放进 tooltip（⌘/Ctrl + ⏎）。
              */}
              <IconTip
                label={
                  isMobile
                    ? tr('选择当前目录')
                    : tr('选择当前目录（{shortcut}）', {
                        shortcut: formatShortcut('CommandOrControl+Enter')
                      })
                }
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={tr('选择当前目录')}
                  disabled={!data || loading}
                  onClick={pickCurrent}
                >
                  <Check className="size-4" />
                </Button>
              </IconTip>
            </>
          }
        />
        {/* 多盘符（Windows）时给一排「跳到哪个盘」；单根（POSIX / SFTP）不必占地方。
            **单行横向滚动**（不换行）+ **固定 `h-7`**：这一行是数据回来之后才出现的，
            高度必须与下面列表预扣的值（`--spacing` × 7）分毫不差 —— 差几像素也会被高度过渡
            放大成「先到一个高度、再到另一个高度」的两段跳。所以不写 `py` / `pb` 让内容量高度。 */}
        {hasRootRow ? (
          <div className="no-scrollbar flex h-7 shrink-0 items-center gap-1 overflow-x-auto px-3">
            {data?.roots?.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => void load(root.path)}
                className={cn(
                  'shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors',
                  root.path === data?.path
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                {root.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <CommandList
        className={cn(
          'flex min-h-0 flex-col overflow-y-auto max-h-none',
          /*
            固定高度，不跟内容走。

            加载前这里只有一行「读取目录…」，加载完可能是几十行 —— 高度若跟着内容长，
            面板会在数据回来的那一帧整块往下跳（顶栏与底部键位提示一起移位）。
            钉死之后位置不变，多出来的行只在列表内部滚。
            `min()` 是给小屏和横屏留的：85dvh 减掉顶栏 / 底栏，再与 20rem 取小。
            20rem ≈ 8 行目录（行高 36px），正好一屏不用滚、多出来再滚。

            `listClassName` 给了就**整个换掉**这一条：弹窗外壳自己定了高度（`h-[32rem]`），
            清单只负责吃满剩下的那块（传 `flex-1`）。两者别叠 —— `h-*` 与 `flex-1` 会同时
            生效，最后靠 flex-basis 谁赢，读代码的人看不出来。

            ⚠️ 出现多盘符那一排时，列表高度要**扣掉那一排的高度**：那一排是数据回来之后才
            出现的，不扣的话整个面板会在「列完盘符」那一刻再长高一次（用户反馈的「先变到一个
            位置、再变到另一个位置，中间有顿感」）。扣的值与那一排**同源**（`--spacing` × 7，
            即 `h-7`）：主题密度会把间距基数改成 0.94~1.05 倍，写死 `1.75rem` 会差 1~2px，
            高度过渡又会把它放大成一次微跳。
          */
          listClassName ??
            (hasRootRow
              ? 'h-[calc(min(20rem,calc(85dvh_-_10rem))-calc(var(--spacing)*7))]'
              : 'h-[min(20rem,calc(85dvh_-_10rem))]'),
          /*
            目录行比 `CommandDialog` 默认的 `py-3` 紧一档（44 → 36px）。
            `!` 是必须的：`CommandDialog` 根上那条 `[&_[cmdk-item]]:py-3` 与本条
            specificity 相同，不加 important 谁赢取决于产物里两条规则的先后，不可控。
          */
          '[&_[cmdk-item]]:py-2!',
          loading && data ? 'opacity-60' : null
        )}
      >
        {/* 新建行贴顶：目录一多列表会滚，输入框不能跟着滚出去（autoFocus 也会把它带进视口） */}
        {creating ? (
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5 backdrop-blur-sm">
            <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
            <Input
              variant="muted"
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
              size="xs"
              disabled={!newName.trim() || creatingBusy}
              onClick={() => void createFolder()}
            >
              {tr('创建')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={creatingBusy}
              onClick={() => setCreating(false)}
            >
              {tr('取消')}
            </Button>
          </div>
        ) : null}

        {loading && !data ? (
          /*
            首屏加载：撑满整块清单区再居中（上下左右都居中）。
            用 `m-auto` 看着等价，但清单本身是滚动容器 —— 边距自动居中只在「恰好没溢出」
            时可靠，远端（SFTP）首包慢、加上顶部还有盘符 / 新建行时，状态行会贴在上沿。
            `flex-1` 让它吃满剩余高度，`grid place-items-center` 两个方向一起居中。
          */
          <div className="grid flex-1 place-items-center px-3 py-6 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" />
              {tr('读取目录…')}
            </span>
          </div>
        ) : null}
        {error ? statusLine(error, true) : null}
        {/* 有 `..` 行的时候不算「空」：目录真的空也能退出去，不必再多一句提示 */}
        {!loading && !error && data?.entries.length === 0 && !parentDir
          ? statusLine(tr('这个目录下没有子目录'))
          : null}

        {data && (parentDir || data.entries.length > 0) ? (
          <CommandGroup heading={tr('目录')}>
            {/* 第一行 `..`：上一级目录。原先它是顶栏一颗箭头，挪进清单是为了跟参考 UI 一致 —
                顶栏只留「返回上一级页面」（面板）/ 路径 / 新建 / 添加，方向键一路走到底 */}
            {parentDir ? (
              <CommandItem
                // `..` 不是真目录，value 别拿路径冒充（它只用于 cmdk 跟踪当前项）
                value=".."
                onSelect={() => void load(parentDir)}
              >
                <ArrowUp />
                <span className="min-w-0 flex-1 truncate">..</span>
              </CommandItem>
            ) : null}
            {data.entries.map((entry) => (
              <CommandItem
                key={entry.path}
                value={entry.path}
                // 选中即前往：⏎ / 点击都是「进这个子目录」（添加当前目录是上面那颗按钮）
                onSelect={() => void load(entry.path)}
              >
                <Folder />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </div>
  )
}

/**
 * 底栏右下角那枚动作：「使用系统文件选择器」——**纯图标 + tooltip**。
 *
 * 底栏只有一行高（与左边那排键位提示同高），带文字的按钮会把整条撑高、看着像
 * 第二块工具条；文案收进 tooltip 后与左边那排键位提示平级、不多占横向空间。
 * 两副外壳共用（弹窗底栏、命令面板目录页底栏）。**只在桌面端画** —— 调用方先判
 * `host.pickLocalDirectory` 在不在；面板列的是服务端目录、路径得靠敲，系统框能直接
 * 调出资源管理器 / 访达、还认得上次打开的位置。
 */
export function SystemDirPickerLink({
  onPick,
  className
}: {
  onPick: () => void
  className?: string
}) {
  const tr = useT()
  return (
    <IconTip label={tr('使用系统文件选择器')}>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn('shrink-0', className)}
        aria-label={tr('使用系统文件选择器')}
        onClick={onPick}
      >
        <FolderSearch className="size-3.5" />
      </Button>
    </IconTip>
  )
}

/** 独立弹窗的外壳：固定高度的面板 + 底栏键位提示。表单里的「选择文件夹…」用它。 */
export function ServerDirPicker({
  app,
  source,
  open,
  onOpenChange,
  onPick,
  onPickNative,
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
   * 桌面端多给一条「使用系统文件选择器」的出口（底栏右下角）。
   *
   * 面板里列的是**服务端**目录、路径靠输入框敲；系统框能直接调出资源管理器 / 访达，
   * 还认得「上次打开的位置」和收藏夹 —— 两者各有所长，谁也别替谁做决定。
   * 传了才画这一项（web / 远端工作区没有本机文件系统，传了就点不动）。
   *
   * 由调用方负责「先收起本面板、再弹系统框、拿到结果后自己 settle」。
   */
  onPickNative?: () => void
  /**
   * 副标题。默认文案是「登记为项目」—— 但这个组件早就被**别的用途**复用了
   * （笔记根、技能的额外目录、Git 导入的父目录、远端工作区），照默认写的那句话
   * 在那些地方是错的。复用方都该传一句说清「选中的目录会被拿去干什么」。
   *
   * 现在只给读屏用（命令面板式的外壳不画标题 / 副标题）：视觉上由右上角那颗「选择」
   * 和调用处的上下文表达同一件事。
   */
  description?: string
  /** 弹窗标题（同样只给读屏）；默认「选择目录」 */
  title?: string
  /** 打开时从哪个目录开始；缺省交给数据源（服务端是本机用户主目录） */
  initialPath?: string
}) {
  const tr = useT()
  const isMobile = useIsMobile()
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? tr('选择目录')}
      description={
        description ??
        tr('选中的目录会登记为项目。')
      }
      // 面板自己不画标题 / 关闭叉：跟命令面板同一副外壳，退出走 Esc / 点外面
      showCloseButton={false}
      commandProps={{ shouldFilter: false }}
      /*
        高度固定（用户要求）：不跟目录条数变。`h-[32rem]` + 纵向 flex，清单 `flex-1 min-h-0`
        吃掉「扣掉头尾之后剩下的那部分」—— 条数变了只影响列表内部滚动，面板高度不动。
        `max-h-[85dvh]` 兜底：视口比 32rem 还矮时（横屏手机 / 小窗口）按视口缩。
        注意基础类里的 `grid` 会被这里的 `flex` 顶掉（`cn` 是 tailwind-merge 系）。

        宽度与命令面板一致（480px）：它现在同时是面板里的一页，两边跳转时不该换宽度。
      */
      className="flex h-[32rem] max-h-[85dvh] flex-col sm:max-w-[480px]"
    >
      <DirectoryBrowser
        app={app}
        source={source}
        active={open}
        initialPath={initialPath}
        /*
          外壳高度是固定的（上面那条 `h-[32rem]`），清单该吃满扣掉头尾之后剩下的那块。
          不传就落到本体默认的固定高度（面板页要的那份），弹窗里会在底栏上方空出一条。
        */
        listClassName="flex-1 min-h-0"
        onPick={(path) => {
          onPick(path)
          onOpenChange(false)
        }}
      />
      {/*
        左右两块用 `justify-between` 分开，两块各自 `items-center` —— 左边换行成两行时，
        右边那枚出口仍在这一块的正中，不会跟着第一行往上贴。

        `flex-nowrap` 是顶掉 `CommandFooter` 基础里的 `flex-wrap`：换行要发生在**左边那组
        键位提示内部**（`span` 自己 `flex-wrap`），否则右边会整块掉到第二行、`justify-between`
        就白设了。左组加 `min-w-0` 才压得窄 —— flex 项默认 `min-width: auto`，内容宽就顶开。
      */}
      <CommandFooter className="flex-nowrap items-center justify-between gap-x-3">
        {!isMobile && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <CommandFooterHint keys={['↑', '↓']} label={tr('选择')} />
            <CommandFooterHint keys={['⏎']} label={tr('进入')} />
            <CommandFooterHint keys={['Backspace']} label={tr('上一级')} />
            <CommandFooterHint keys={['Esc']} label={tr('关闭')} />
          </span>
        )}
        {/* 远端工作区（`source` 是 SFTP）不给本机入口：那目录不在这台机器的文件系统里 */}
        {source || !onPickNative ? null : (
          <SystemDirPickerLink className="shrink-0" onPick={onPickNative} />
        )}
      </CommandFooter>
    </CommandDialog>
  )
}
