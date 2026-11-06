/**
 * 工作区文件面板（web 版）：左侧文件树（懒加载）+ 右侧预览 / 编辑区。
 *
 * 桌面端 Agent 的 AgentFilesPanel 在 web 上的对等能力。聊到一半想直接看 / 改工作区
 * 里的某个文件时，点顶栏的文件图标打开它。媒体（图 / 视频 / 音频）就地预览，
 * markdown / html 也有预览态（沙箱 iframe / Streamdown），纯文本 / 代码可在右侧编辑后保存
 * （Ctrl+S 或保存按钮）。
 *
 * **下载 / 定位按平台分岔**（同一个槽位二选一）：web = 下载到浏览器下载目录；
 * desktop = 在系统文件管理器里选中这个文件（后端就跑在这台机器上，够得着）。
 * 容器工作台（流程节点）两种都没有「本机路径」可依，只有下载。
 *
 * 文件树支持右键菜单（桌面）/ 长按菜单（手机）：复制 / 粘贴 / 删除 / 下载 / 定位 /
 * 复制路径 / 复制绝对路径 / 新建文件 / 新建文件夹。
 * 树内还支持键盘：Delete 删除、Ctrl(Cmd)+C 复制、Ctrl(Cmd)+X 剪切、Ctrl(Cmd)+V 粘贴、
 * Ctrl(Cmd)+A 全选；删除与粘贴都会先弹确认。
 *
 * 多选：Ctrl(Cmd)+点击加减单项、Shift+点击按可见顺序选一段（资源管理器那一套）。
 * 选中的条目是**批量操作的作用对象** —— 右键菜单、快捷键、头部按钮全都认它；
 * 顶部那颗「粘贴到根目录」按钮解决的是「根目录本身没有条目可右键」的死角。
 *
 * 右侧打开的文件标签也支持右键菜单（浏览器标签那一套）：关闭 / 关闭其他 / 关闭右侧 /
 * 关闭左侧 / 关闭全部。其中只要有关不掉的脏标签，就整批走「先确认再关」。
 *
 * ## 窄容器 = 一次一屏（上下钻）
 *
 * 容器宽度窄于 `FILES_SINGLE_PANE_BELOW_WIDTH`（见 `lib/files-pane-width`）时不再并排两栏，
 * 而是「文件树整屏 ↔ 内容整屏」二选一：点文件翻到内容页，内容页左上角的「←」退回树。
 * 判据是**面板自己的宽度**（`useContainerWidth` 实测），因此手机与「宽屏上被拖窄的侧栏 /
 * 流程节点面板」走同一条路 —— 挤不挤取决于这块地方有多宽，与屏幕多大无关。
 *
 * ⚠️ 输入方式（右键菜单 / 长按 / 行尾「更多操作」）**另按 `isMobile` 判**：窄容器桌面端
 * 不该因为「窄」而丢掉右键。布局看宽度、交互看输入方式，两者别混成一个开关。
 */
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
  type TouchEvent as ReactTouchEvent
} from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus2,
  FileSymlink,
  FileText,
  FileVideo,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Hash,
  ListX,
  Loader2,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  WrapText,
  Eye,
  EyeOff,
  SquareX,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { ImageViewer } from '@fizz/ui/image-viewer'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef
} from '@fizz/ui/resizable'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import {
  MobileEntryMoreButton,
  MobileFilesHeaderActions,
} from '@fizz/agent-kit/features/files/MobileFilesControls'
import { PanelTab } from '@fizz/agent-kit/shared/components/PanelTab'
import { RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { askTabCloseGuards, registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { useContainerWidth } from '@fizz/agent-kit/features/chat/SidePanel'
import { treeIndent } from '@fizz/agent-kit/shared/lib/tree-indent'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  FILES_PANE_MIN_WIDTH,
  FILES_SINGLE_PANE_BELOW_WIDTH,
  defaultFilesPaneWidth,
  maxFilesPaneWidth,
  setFilesPaneWidth,
  useFilesPaneWidth
} from '@fizz/agent-kit/shared/lib/files-pane-width'
import { setLineNumbers, setWordWrap, useLineNumbers, useWordWrap } from '@fizz/agent-kit/shared/lib/editor-view-prefs'
import { previewKindOf, isPreviewable, isEditable, isMediaKind, hasDualView, type PreviewKind } from '@fizz/agent-kit/shared/lib/preview'
import { notifyWorkspaceFsChanged } from '@fizz/agent-kit/shared/lib/fs-changed'
import MonacoEditor, { monacoLanguageOf } from '@fizz/agent-kit/features/files/MonacoEditor'
import { FileMarkdownPreview } from '@fizz/agent-kit/features/files/FileMarkdownPreview'
import { FileHtmlPreview } from '@fizz/agent-kit/features/files/FileHtmlPreview'
import { consumeOpenFileRequest, useOpenFileRequest } from '@fizz/agent-kit/features/files/open-file'
import { useShowIgnored, setShowIgnored } from '@fizz/agent-kit/shared/lib/fs-tree-prefs'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentFsEntry, FsListResult } from '@fizz/contracts/agent-api'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '@fizz/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { useIsMobile } from '@fizz/agent-kit/shared/hooks/useIsMobile'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
// 只有要区分「409 = 同名冲突」这一种错误，才需要摸到 api 层的错误类型
import { ApiError } from '@fizz/agent-client/api'

function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (ext === 'json' || ext === 'jsonc') return <FileJson className="size-4 shrink-0 text-amber-500" />
  const kind = previewKindOf(name)
  if (kind === 'image' || kind === 'svg') return <FileImage className="size-4 shrink-0 text-emerald-500" />
  if (kind === 'video') return <FileVideo className="size-4 shrink-0 text-violet-500" />
  if (kind === 'audio') return <FileAudio className="size-4 shrink-0 text-pink-500" />
  // md 与 html 都是「可预览也能改」的文本，用同一支文档图标（与纯文本区分在预览态，不在树里）
  if (kind === 'markdown' || kind === 'html') return <FileCode2 className="size-4 shrink-0 text-sky-500" />
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return <FileCode className="size-4 shrink-0 text-sky-500" />
  }
  return <FileText className="size-4 shrink-0 text-muted-foreground" />
}

/**
 * 文件树的一行。桌面右键菜单与手机长按菜单都只是它的**外壳**，
 * 行本体两条路共用一份（图标 / 缩进 / 高亮 / 尾部插槽）。
 *
 * 整体是 div 而不是 button：尾部要放「更多操作」按钮（手机上），
 * button 套 button 是非法 HTML，浏览器会把内层悄悄提出去。
 *
 * ⚠️ 桌面端这一行是 `<ContextMenuTrigger asChild>` 的子元素：Radix 的 Slot 会把
 * `onContextMenu` / `ref` / `data-state` 等 props **合并到本组件上**，本组件必须把它们
 * 透传到真实 DOM 节点，右键菜单才会弹出来 —— 只声明自己的 props 而不 `...rest` 透传，
 * Radix 合并进来的触发器 props 会被全部丢掉（表现为右键无反应）。
 */
function TreeRow({
  depth,
  name,
  isDir,
  open,
  active,
  selected,
  ignored,
  onActivate,
  trailing,
  touch,
  cut,
  ...rest
}: {
  depth: number
  name: string
  isDir: boolean
  open: boolean
  active: boolean
  /** 键盘 / 多选的落点：与「已打开」(active) 是两回事，可同时出现在两行上 */
  selected?: boolean
  /**
   * 命中忽略规则的条目（只在「显示被忽略」开着时才会出现在树里）。
   * 整行压暗 + 悬停标题里点明 —— 用户得知道「这东西平时是被藏起来的」，
   * 否则会以为它本来就该在这儿、下次开关关掉又找不到。
   */
  ignored?: boolean
  /** 传原始鼠标事件：调用方要靠 ctrl / shift 修饰键决定单选 / 多选 / 范围选 */
  onActivate: (e: ReactMouseEvent<HTMLButtonElement>) => void
  /** 行尾插槽（手机端的「更多操作」按钮） */
  trailing?: ReactNode
  /** 手机长按手势；不传说明走桌面渲染，不挂任何触摸回调 */
  touch?: TouchHandlers
  /** 已被剪切、正等着粘贴的条目：整行压暗 */
  cut?: boolean
} & Omit<ComponentProps<'div'>, 'children'>) {
  const t = useT()
  return (
    <div
      {...touch}
      {...rest}
      style={{ paddingLeft: treeIndent(depth, 14, 8), ...rest.style }}
      className={cn(
        'flex items-center gap-1.5 py-1 pr-2 text-sm',
        active ? 'bg-primary/15 text-foreground' : 'text-foreground',
        selected && 'bg-primary/20 text-foreground ring-1 ring-primary/40 ring-inset',
        'hover:bg-foreground/10',
        cut && 'opacity-50',
        ignored && 'opacity-45 hover:opacity-80',
        rest.className
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        title={ignored ? t("{name}（命中忽略规则，默认不显示）", { name }) : name}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {isDir ? (
          <>
            {open ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            {open ? (
              <FolderOpen className="size-4 shrink-0 text-primary/80" />
            ) : (
              <Folder className="size-4 shrink-0 text-primary/80" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <FileTypeIcon name={name} />
          </>
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {trailing}
    </div>
  )
}

interface DirState {
  open: boolean
  loading: boolean
  entries: AgentFsEntry[] | null
  /** 服务端因条目过多没列全（树里在末尾给一行提示，别让用户以为目录就这么点东西） */
  truncated?: boolean
}

/**
 * 右侧打开的一个文件标签页。每个标签**各自持有一份**内容、脏基线（`savedContent`）
 * 与视图状态，所以「改一半切去看别的文件，回来改动还在」是天然成立的。
 *
 * 用文件路径当 id：同一路径只会有一个标签，再次点开是切过去而不是重读 —— 重读会把
 * 未保存的改动冲掉。媒体标签只存可播放 URL，不存正文。
 */
interface OpenTab {
  /** 文件路径，兼作标签 id */
  path: string
  kind: PreviewKind | null
  viewMode: 'preview' | 'edit'
  content: string
  /** 上次读入 / 保存的内容基线，与 `content` 不等即为「脏」 */
  savedContent: string
  /** 文本正文读取中（编辑器先显示空，避免闪现上一个文件的内容） */
  loading: boolean
  /** 保存请求进行中 */
  saving: boolean
  mediaUrl: string | null
  mediaLoading: boolean
  /** 这个标签自己的读取 / 保存错误 */
  error: string | null
}

/**
 * 文件标签在**关闭守卫注册表**里的 key（`file:<path>`）。
 *
 * `FilesPanel` 自己那一排文件标签不是主区域的 `panel-store` 标签（它整套多标签是组件内部
 * state），所以不复用主区域的标签 key。但关闭守卫与命令式确认弹窗是**通用机制**，这里用
 * 一个 `file:` 前缀把文件标签登记进去，`requestCloseTabs` 自己驱动 `askTabCloseGuards`
 * —— 于是「脏文件关标签先确认」与别的标签用的是同一套（`useConfirm`），不必再维护一份
 * 手写 Dialog。
 */
const fileTabKey = (path: string): string => `file:${path}`
const pathOfFileTabKey = (key: string): string => key.slice('file:'.length)

/**
 * 复制一段文本进系统剪贴板，并把结果告诉用户（右键菜单的「复制路径 / 复制绝对路径」用）。
 *
 * 走 promise 而不是 `void` 一把梭：clipboard 在非安全上下文 / 文档失去焦点时会**拒**，
 * 静默失败会让用户以为已经复制好了。
 */
function copyText(text: string, label: string): void {
  if (!text) {
    toast.error(t('没有可复制的内容'))
    return
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success(label),
    (err: unknown) => toast.error(t('复制失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
  )
}

/**
 * 树里「空白区域」的判定：滚动容器本身，以及列表末尾那块留白（标了 `data-fs-blank`）。
 *
 * 行首的缩进区**不算**空白 —— 它是行元素自己的一部分，右键那里弹的是那一行的菜单。
 */
function isBlankAreaTarget(target: EventTarget | null, container: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.dataset === 'undefined') return false
  return el === container || el.dataset.fsBlank !== undefined
}

/** 剪贴板里的一个条目：路径 + 类型（文件/目录）+ 名字（粘贴时拼新路径用） */
interface ClipboardEntry {
  path: string
  type: 'file' | 'dir'
  name: string
}

/** 剪贴板内容：一批条目 + 模式（粘贴时据此决定复制还是移动） */
interface Clipboard {
  entries: ClipboardEntry[]
  /** `copy` = 复制（可反复粘贴）；`cut` = 剪切（粘贴一次即移动，随后清空剪贴板） */
  mode: 'copy' | 'cut'
}

/**
 * 菜单里的一个动作。桌面右键菜单（`ContextMenuItem`）与手机底部菜单（`Sheet`）
 * 渲染的是**同一份**动作清单 —— 一端加能力另一端自动跟上，不会悄悄跑偏。
 */
interface MenuAction {
  label: string
  icon: ReactNode
  danger?: boolean
  /** 当前用不上（如已是最后一个标签时的「关闭右侧」）：置灰且点不动 */
  disabled?: boolean
  run: () => void
}

/** 手机长按的手势回调（挂在行容器上：手指按下 / 移动 / 抬起） */
interface TouchHandlers {
  onTouchStart: (e: ReactTouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: ReactTouchEvent) => void
}

/**
 * 文件面板的**数据来源**抽象。
 *
 * 两处用同一种「文件树 + 预览 / 编辑」交互，但数据在完全不同的地方：
 * - **工作区**（Agent 会话）：服务端 `/api/workspaces/:id/files`，真源是跑 Agent 那台机器；
 * - **流程节点容器**：服务端反向代理到容器 bridge，真源是容器里的 `/workspace`。
 *
 * 与其复制一份面板，不如把「取目录 / 读文件 / 写文件 / 取媒体 URL」这四件事抽成接口 ——
 * 面板本身（树、懒加载、Monaco、预览、Ctrl+S）两种场景一字不改地复用。
 * 后加的「下载 / 在文件管理器中定位」同样走这个接口，且**各自按能力显隐**：容器
 * 工作台只实现 `download`（文件在镜像里，本机定位不到），桌面端的工作区两个都有，
 * web 宿主只有 `download`。
 */
export interface FilesSource {
  /** 根目录显示名（工作区名 / 容器工作区） */
  rootLabel: string
  /**
   * 列一个目录。
   *
   * `includeIgnored`：**只有工作区来源认它** —— 打开后连命中忽略规则的条目一起返回
   * （条目带 `ignored: true`，见「显示被忽略」开关）。容器 / 外部来源列的就是原样，
   * 多出来的这个参数对它们是空操作。
   *
   * 返回值是 `{ entries, truncated }` 而不是裸数组：`truncated` 表示「服务端因条目过多
   * 没列全」，界面得把它说出来（否则用户只会以为文件不见了）。
   */
  list(dir: string, includeIgnored?: boolean): Promise<FsListResult>
  /** 媒体文件的**可播放 URL**（图片 / 视频 / 音频预览用） */
  mediaUrl(path: string): Promise<string>
  read(path: string): Promise<{ content?: string; binary?: boolean; size?: number } | null>
  /** 写文件；返回错误文本，null = 成功 */
  write(path: string, content: string): Promise<string | null>
  /** 删除文件或目录（递归）；返回错误文本，null = 成功。不支持时返回 '不支持' */
  delete?(path: string): Promise<string | null>
  /** 复制文件或目录到指定父目录；返回错误文本，null = 成功。不支持时返回 '不支持' */
  copy?(path: string, dest: string): Promise<string | null>
  /** 移动 / 重命名文件或目录到指定父目录；返回错误文本，null = 成功。不支持时返回 '不支持'。
   * 传 `name` = 重命名（只换最后一段，父目录仍是 `dest`） */
  move?(path: string, dest: string, name?: string): Promise<string | null>
  /** 在某个目录下新建文件夹；返回错误文本，null = 成功。不支持时返回 '不支持' */
  mkdir?(dir: string, name: string): Promise<string | null>
  /** 在某个目录下新建（空）文件；返回错误文本，null = 成功。不支持时返回 '不支持' */
  createFile?(dir: string, name: string): Promise<string | null>
  /**
   * 把**本机选中的文件**上传到某个目录。
   *
   * 返回形状与其它方法不同（要能区分「同名冲突」与真失败）：冲突时调用方弹确认框，
   * 用户点头再带 `overwrite` 重传一次 —— 绝不静默盖掉同名文件。
   *
   * 只有 **web 宿主的工作区来源**实现它：desktop 的文件本机就够得着（要搬直接拖资源
   * 管理器），容器来源的文件在容器里、走的是另一套桥。没实现 = 面板不渲染上传入口。
   */
  upload?(
    dir: string,
    file: File,
    overwrite?: boolean
  ): Promise<{ ok: true } | { ok: false; conflict?: boolean; error: string }>
  /**
   * 把文件**下载到本机**（浏览器另存为）。返回错误文本，null = 已触发下载。
   *
   * 工作区来源走带鉴权的 `/media`；容器来源是同源 raw 直链。
   * 桌面宿主能定位时面板只用定位、不显示下载（同一槽位二选一），那时本方法不会被调用。
   */
  download?(path: string, fileName: string): Promise<string | null>
  /**
   * 把**文件夹**打包下载到本机（服务端打 zip）。返回错误文本，null = 已触发下载。
   *
   * 只有工作区来源提供（服务端能把这台机器上的目录打成 zip）；容器来源的文件在镜像里，
   * 其 raw 直链只认单个文件，所以不提供 —— 没提供 = 面板不给文件夹渲染「下载」入口。
   * 与单文件「下载」同一条显隐判据（`canDownload`）：desktop 宿主下文件本机就够得着，
   * 不需要下载按钮，这里也不会露出来。
   */
  downloadDir?(path: string, fileName: string): Promise<string | null>
  /**
   * 在**本机**文件管理器里显示（选中）这个文件。只有「本机就够得着这些文件」的来源提供 ——
   * 桌面端的工作区（后端跑在这台机器上）。容器来源刻意不提供：文件在镜像里，本机定位不到；
   * web 宿主也没有这个方法。没提供 = 面板不渲染这个入口（不要给一个必然失败的按钮）。
   *
   * ⚠️ **声明了 ≠ 这个宿主能干这事**：`workspaceSource` 无条件赋值本方法（它要负责
   * 「相对路径 → 宿主机绝对路径」的拼接，只有工作区来源知道 `ws.path`），面板另有一道
   * `!!getAgentHostOrNull()?.revealInFileManager` 的判据 —— 少了它 web 下也会露出定位按钮，
   * 而下载按钮被"同一槽位二选一"顶掉，正好反了。
   */
  revealInFileManager?(path: string): Promise<string | null>
  /**
   * 在**本机**文件管理器里**打开这个目录**（进入它，而不是在父目录里选中它）。
   *
   * 与 `revealInFileManager` 平行的第二条出口：那个负责「文件」，这个负责「目录」——
   * 文件夹右键、文件树空白处（= 根目录）都用它。同样只有「本机就够得着这些文件」的来源
   * 提供，面板另有一道 `!!getAgentHostOrNull()?.openFileManagerAt` 的判据（见 `canOpenInFileManager`）。
   */
  openInFileManager?(path: string): Promise<string | null>
  /**
   * 把树里的**相对路径**换成这个来源所在机器上的**绝对路径**（右键菜单「复制绝对路径」用）。
   *
   * ⚠️ 与 `revealInFileManager` 是两码事：定位要求「本机就够得着这些文件」，复制绝对路径
   * 只要求「知道根目录」，所以 web 工作区来源也有 —— 那条路径在**跑 server 的那台机器**上
   * 是真实存在的（容器来源则是容器里的 `/workspace/...`），用户常拿它去终端 / 别的工具里用。
   *
   * 返回 `null` = 根目录此刻未知（工作区还没加载完 / 已被删）—— 面板会在点击时给出提示，
   * 而不是往剪贴板里塞一条拼错的路径。
   */
  absolutePath?(path: string): string | null
}

/**
 * 把工作区数据（`AgentApp`）适配成 `FilesSource`。
 *
 * `app.writeWorkspaceFile` 的返回形状与其它三个不同（错误在返回值里而不是抛异常），
 * 这里把它拉平到统一约定。
 *
 * ⚠️ **所有会改文件的出口都从这里过一遍**（保存 / 复制 / 剪切移动 / 删除 / 新建文件 /
 * 新建文件夹），成功后统一 `notifyWorkspaceFsChanged`。git 面板的改动列表靠它刷新
 * （见 `lib/fs-changed.ts`）—— 少挂一个，那个操作造成的 git 改动就得以「手动点刷新」
 * 才看得见。加新���写操作时**先在这里包一层**，别直接调 `app.*`。
 */
function workspaceSource(getApp: () => AgentApp | undefined, workspaceId: string): FilesSource {
  /** 包一层「成功后喊一声文件变了」；返回形状不变（错误文本 / null = 成功） */
  const notifying = (kind: string, run: () => Promise<string | null>): Promise<string | null> =>
    run().then((err) => {
      if (err === null) notifyWorkspaceFsChanged(workspaceId, kind)
      return err
    })

  /**
   * 相对路径 → 宿主机绝对路径（定位 / 打开目录 / 复制绝对路径共用）。
   *
   * 分隔符**跟着根走**：根是 `C:\a\b` 就用 `\`，是 `/home/x` 就用 `/`。
   * 以前一律用 `/` 拼，Windows 下会拼出 `C:\Users\x\.fizz-server\conversations\<id>/conf`
   * 这种**混合形态** —— 复制到终端里难看，喂给资源管理器更糟（它认不出来时不报错，
   * 直接开「文档」，见 `apps/desktop/src/main/opener.ts` 的 `toNativePath`）。
   *
   * 每次调用现查工作区（而不是闭包捕获）：来源对象在挂载时建好，那会儿工作区可能还没加载完。
   */
  const absolutePathOf = (path: string): string | null => {
    const root = getApp()?.workspaces.find((w) => w.id === workspaceId)?.path
    if (!root) return null
    const base = root.replace(/[\\/]+$/, '')
    const tail = path.replace(/^[\\/]+/, '')
    if (!tail) return base
    const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/'
    const head = sep === '\\' ? base.replace(/\//g, '\\') : base
    return `${head}${sep}${tail.replace(/[\\/]/g, sep)}`
  }

  return {
    rootLabel: getApp()?.workspaces.find((w) => w.id === workspaceId)?.name ?? '',
    // 只有这个来源支持「连被忽略的一起列」—— 忽略规则是工作区列表接口自己施加的
    list: (dir, includeIgnored) =>
      getApp()?.listWorkspaceFiles(workspaceId, dir, includeIgnored) ??
      Promise.resolve<FsListResult>({ entries: [] }),
    mediaUrl: async (path) => (await getApp()?.fetchWorkspaceMedia(workspaceId, path)) ?? '',
    read: (path) => getApp()?.readWorkspaceFile(workspaceId, path) ?? Promise.resolve(null),
    write: (path, content) =>
      notifying('write', () =>
        getApp()?.writeWorkspaceFile(workspaceId, path, content) ?? Promise.resolve(t('未连接'))
      ),
    // 约定：null = 成功，字符串 = 错误文本。`notifying` 原样返回内层结果，成功的 null
    // 不能再被 `?? '未连接'` 兜成假错误 —— 否则删成功了也要报「未连接」。
    delete: (path) =>
      notifying('delete', async () => {
        const r = await getApp()?.deleteWorkspaceFile(workspaceId, path)
        if (!r) return t('未连接')
        return r.ok ? null : r.error
      }),
    copy: (path, dest) =>
      notifying('copy', async () => {
        const r = await getApp()?.copyWorkspaceFile(workspaceId, path, dest)
        if (!r) return t('未连接')
        return r.ok ? null : r.error
      }),
    move: (path, dest, name) =>
      notifying('move', async () => {
        const r = await getApp()?.moveWorkspaceFile(workspaceId, path, dest, name)
        if (!r) return t('未连接')
        return r.ok ? null : r.error
      }),
    mkdir: async (dir, name) =>
      notifying('mkdir', async () => {
        const app = getApp()
        if (!app || !app.api) return t('未连接')
        const ws = app.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return t('工作区不存在')
        // 把相对路径拼成服务端绝对路径（简单拼接，与服务端 resolveInside 一致）
        const parent = dir ? `${ws.path}/${dir}` : ws.path
        try {
          await app.api.createServerDir({ parent, name })
          return null
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }),
    // 新建文件 = 写一个空内容的文件（写接口本身就是 create-or-overwrite）
    createFile: (dir, name) =>
      notifying('create', () =>
        getApp()?.writeWorkspaceFile(workspaceId, dir ? `${dir}/${name}` : name, '') ??
        Promise.resolve(t('未连接'))
      ),
    /**
     * 上传本机文件到工作区目录（web 文件面板的上传入口）。
     *
     * 走 `app.api.uploadWorkspaceFile`（JSON + base64 → 服务端按**字节**落盘）：**不能**
     * 塞进上面的 `write` —— 那条路是 UTF-8 文本，图片 / 压缩包会被写坏。
     *
     * 这里不用 `notifying`：它只认「错误文本 | null」，而 409 是「同名文件已存在」这种
     * **问过用户就能继续**的结果，不是一句错误文案。成功时手动喊一声 `notifyWorkspaceFsChanged`。
     */
    upload: async (dir, file, overwrite) => {
      const app = getApp()
      if (!app?.api) return { ok: false, error: t('未连接') }
      const path = dir ? `${dir}/${file.name}` : file.name
      try {
        await app.api.uploadWorkspaceFile(workspaceId, path, file, overwrite ?? false)
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          return { ok: false, conflict: true, error: err.message }
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      notifyWorkspaceFsChanged(workspaceId, 'upload')
      return { ok: true }
    },
    // 只读动作：不写文件，不必 notifyWorkspaceFsChanged
    download: (path, fileName) =>
      getApp()?.downloadWorkspaceFile(workspaceId, path, fileName) ?? Promise.resolve(t('未连接')),
    // 文件夹下载：同一套出口，多带一个 isDir，服务端会把它打成 zip 再吐出来
    downloadDir: (path, fileName) =>
      getApp()?.downloadWorkspaceFile(workspaceId, path, fileName, true) ??
      Promise.resolve(t('未连接')),
    /**
     * 在系统文件管理器里定位。本来源永远赋值它：这里要负责「相对路径 → 宿主机绝对路径」
     * 的拼接，而只有工作区来源知道 `ws.path`。
     *
     * **能不能调由面板另外判**（`!!getAgentHostOrNull()?.revealInFileManager`）—— web 宿主
     * 没实现这个方法，按钮压根不会露出来，走到这里说明宿主支持、只是路径没解析对。
     */
    revealInFileManager: async (path) => {
      const reveal = getAgentHostOrNull()?.revealInFileManager
      if (!reveal) return t('当前环境不支持在文件管理器中定位')
      const abs = absolutePathOf(path)
      if (abs === null) return t('工作区目录未知')
      const r = await reveal(abs)
      return r.ok ? null : (r.error ?? t('打开文件管理器失败'))
    },
    /**
     * 在文件管理器里**打开目录**（文件夹右键 / 文件树空白处 = 根目录）。与上面共用同一份
     * 「相对路径 → 绝对路径」拼接；Windows 的 explorer 认带尾斜杠的目录路径，还是顺手去掉。
     */
    openInFileManager: async (path) => {
      const open = getAgentHostOrNull()?.openFileManagerAt
      if (!open) return t('当前环境不支持在文件管理器中打开')
      const abs = absolutePathOf(path)
      if (abs === null) return t('工作区目录未知')
      const r = await open(abs.replace(/[\\/]+$/, ''))
      return r.ok ? null : (r.error ?? t('打开文件管理器失败'))
    },
    // 「复制绝对路径」：与定位共用同一份拼接（见上），只是不要求宿主机够得着
    absolutePath: absolutePathOf
  }
}

/**
 * 文件面板的外框（整个面板的根 div，`useContainerWidth` 量宽的就是它）。
 *
 * - **两栏形态**：根 div 里再套 `ResizablePanelGroup`（`@fizz/ui/resizable`，底层
 *   react-resizable-panels），拖拽 / 键盘微调 / min-max 夹取 / 容器变化时的重排都交给组件。
 * - **单栏形态**与「容器宽度还没量到的首帧」：只剩根 div，两个 `PaneShell` 直接并进 flex，
 *   与改造前逐像素一致。
 *
 * `containerRef` 挂在根 div 上：两种形态是同一个 DOM 节点（React 按位置 + 类型复用），
 * 切换时不会重新挂载、也不会重新量一次宽度。
 */
function SplitFrame({
  split,
  containerRef,
  onKeyDownCapture,
  onLayoutChanged,
  children
}: {
  split: boolean
  containerRef: RefCallback<HTMLDivElement>
  onKeyDownCapture?: ComponentProps<'div'>['onKeyDownCapture']
  onLayoutChanged: NonNullable<ComponentProps<typeof ResizablePanelGroup>['onLayoutChanged']>
  children: ReactNode
}) {
  return (
    <div
      ref={containerRef}
      onKeyDownCapture={onKeyDownCapture}
      className="flex h-full min-h-0 w-full bg-background"
    >
      {split ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0" onLayoutChanged={onLayoutChanged}>
          {children}
        </ResizablePanelGroup>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * 文件树 / 编辑区的外壳。
 *
 * - 两栏形态：`ResizablePanel`，宽度交给 Group 的布局。`className` / `style` 落在它的
 *   **内层** div 上 —— 库默认写的是 `overflow: auto`，要盖住只能走 `style`（内联值优先）。
 * - 单栏 / 容器还没量到宽度：普通 `div`，宽度自己给（与改造前逐像素一致）。
 *
 * ⚠️ 跨 `FILES_SINGLE_PANE_BELOW_WIDTH` 时会换掉父元素类型，子树**重挂**（Monaco 重建：
 * 内容从 `activeTab.content` 恢复，撤销栈与滚动位置不保留）。这是「两栏交给 Group」的代价；
 * 另一条路是让 Group 在单栏下把一侧压到 0 宽，那样每次翻页都要命令式改尺寸，还会闪一帧。
 */
function PaneShell({
  split,
  panel,
  className,
  style,
  children
}: {
  split: boolean
  /**
   * 两栏形态下交给 `ResizablePanel` 的尺寸约束。
   *
   * ⚠️ 不传 ≠ 退回普通 div —— 两栏形态下**必须**是 `ResizablePanel`：Group 只认自己注册的
   * 面板，漏一个就只剩「一个面板 + 一个野 div」，那个面板占满 100%、编辑区被挤成 0 宽、
   * 分隔条也不生成，看起来就是「只有一栏、还拖不动」。
   */
  panel?: Omit<ComponentProps<typeof ResizablePanel>, 'className' | 'style' | 'children'>
  className: string
  style?: CSSProperties
  children: ReactNode
}) {
  if (!split) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    )
  }
  return (
    <ResizablePanel {...panel} className={className} style={style}>
      {children}
    </ResizablePanel>
  )
}

export function FilesPanel({
  app,
  workspaceId,
  source,
  visible = true
}: {
  app?: AgentApp
  /** 这个面板固定服务的工作区（按会话各挂一套：面板常驻，工作区不会中途变化） */
  workspaceId?: string
  /**
   * 自定义数据来源；不传则用 `app` + `workspaceId`（工作区场景）。
   * 流程节点容器改传自己的 `FilesSource`，面板其余部分完全共用。
   */
  source?: FilesSource
  /**
   * 这个面板当下是否**真露在外面**（面板收起 / 切到别的标签时为 `false`）。
   *
   * 标签内容一律**常挂载**（收起只是把宽度裁到 0 / `hidden`，见 `SidePanel` 文件头），
   * 所以「又露出来」是唯一的「用户重新打开了一次」信号 —— 不复位就永远看不到挂出之后
   * 别人写进来的文件（树停在挂出那一刻的快照上，得手动点刷新）。与 `GitPanel` 的
   * 同名 prop 一个语义。默认 `true`：不声明可见性的调用方（流程节点容器）保持原行为。
   */
  visible?: boolean
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})

  /**
   * 「折叠所有目录」按钮的状态：`null` = 现在没被按钮折叠过（按钮显示「折叠所有」）；
   * 非 `null` = 上次折叠**前**正展开着的那些目录路径，按钮改成「展开」，点一下原样还原。
   *
   * 记快照而不是「展开全部」：用户往往只展开自己关心的几条分支，折叠一下再点回来，
   * 期望的是回到他摆的那个样子，而不是整棵树全炸开（那样反而更难找回刚才的位置）。
   *
   * 还原是**纯视图操作**（不重拉）：折叠本身也没清条目，展开回来内容是折叠前那份；
   * 要拿磁盘上的最新内容点「刷新」（与行首箭头展开会重拉不同，这里刻意选了「零闪烁」）。
   */
  const [collapsedFrom, setCollapsedFrom] = useState<string[] | null>(null)

  /**
   * 左侧文件列表面板的宽度（可拖）。
   *
   * `storedPaneWidth` 为 `null` = 用户没拖过 → 按**容器**宽度现场算（原来写死的
   * `md:w-60` 断的是视口宽度，侧栏被拖窄时会把编辑区挤没，见 `lib/files-pane-width`）。
   * 渲染时再夹一次上限：面板后来被拖窄了，存下的宽度可能已经超出可用范围。
   */
  const storedPaneWidth = useFilesPaneWidth()
  const [containerRef, containerWidth] = useContainerWidth()
  /** 文件树那一栏的命令式句柄：拖完读回像素宽落盘、双击复位直接改尺寸都靠它 */
  const treePanelRef = usePanelRef()
  const paneMaxWidth = maxFilesPaneWidth(containerWidth)
  const treePaneWidth = Math.min(storedPaneWidth ?? defaultFilesPaneWidth(containerWidth), paneMaxWidth)

  /** 编辑器视图偏好（自动换行 / 行号）：开关在本面板标签条右侧，偏好落盘 */
  const wordWrap = useWordWrap()
  const lineNumbers = useLineNumbers()

  /** 右侧打开的标签页（数组顺序 = 显示顺序）；`activeId` 是当前标签的 path */
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  /** 目录（树）加载失败的错误 —— 与某个文件标签自己的读写错误是两码事 */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 待确认刷新的脏标签：刷新要用磁盘上的最新内容覆盖本地未保存的改动，先问一句 */
  const [pendingReload, setPendingReload] = useState<string | null>(null)
  /** 图片放大预览的源（null = 关着）；点预览区里的图片时设成它的 URL */
  const [imageZoomSrc, setImageZoomSrc] = useState<string | null>(null)

  /** 当前激活的标签（没打开任何文件时为 null） */
  const activeTab = tabs.find((t) => t.path === activeId) ?? null

  /**
   * 外部「打开这个文件」的请求（消息下方的文档入口发来的，见 `features/files/open-file.ts`）。
   * 只认**自己这个工作区**的那一条 —— 各会话各挂一套面板，同时活着的可能不止一套。
   */
  const openRequest = useOpenFileRequest()

  /** 标签条（横向滚动容器）与每个 tab 元素的 ref：用来把激活的 tab 滚进视口 */
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabElRefs = useRef(new Map<string, HTMLDivElement>())

  /**
   * 激活的 tab 若被横向滚出视口（最典型：文件树里点一个已打开、但 tab 没露出来的文件），
   * 把它滚回可见。只动标签条自己的 `scrollLeft`，不碰任何祖先的滚动位置。
   */
  useEffect(() => {
    if (!activeId) return
    const strip = tabStripRef.current
    const el = tabElRefs.current.get(activeId)
    if (!strip || !el) return
    const stripRect = strip.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (elRect.left < stripRect.left) {
      strip.scrollTo({ left: strip.scrollLeft + (elRect.left - stripRect.left), behavior: 'smooth' })
    } else if (elRect.right > stripRect.right) {
      strip.scrollTo({ left: strip.scrollLeft + (elRect.right - stripRect.right), behavior: 'smooth' })
    }
  }, [activeId])

  /** 就地改一个标签（找不到就忽略）；读文件 / 保存 / 切视图的异步收尾都走它 */
  const patchTab = (path: string, patch: Partial<OpenTab>): void =>
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, ...patch } : t)))

  /**
   * 关掉一批标签。当前标签若在其中，激活被关位置右侧的第一个（没有则取最后一个）；
   * 全关完了就回到「未打开文件」空态。
   */
  const closeTabs = (paths: string[]): void => {
    if (paths.length === 0) return
    const kill = new Set(paths)
    const next = tabs.filter((t) => !kill.has(t.path))
    setTabs(next)
    if (activeId && kill.has(activeId)) {
      const firstIdx = tabs.findIndex((t) => kill.has(t.path))
      const fallback = next[Math.min(firstIdx, next.length - 1)]
      setActiveId(fallback ? fallback.path : null)
    }
  }

  /**
   * 请求关闭一批标签（关闭按钮 / 标签右键菜单 / 中键共用）：先**逐个**问这批文件标签的
   * 关闭守卫（脏标签会弹「丢弃并关闭」确认），再关掉放行的那些。取消的那个留着，继续问下一个。
   *
   * 传入的路径里不存在的直接忽略。守卫与命令式确认都是通用机制（见 `tab-close.ts` /
   * `ConfirmProvider`），本文件只负责驱动。
   */
  const requestCloseTabs = async (paths: string[]): Promise<void> => {
    const targets = paths.filter((p) => tabs.some((t) => t.path === p))
    if (targets.length === 0) return
    const approved = await askTabCloseGuards(targets.map(fileTabKey))
    if (approved.length === 0) return
    closeTabs(approved.map(pathOfFileTabKey))
  }

  /** 关闭单个标签 */
  const requestCloseTab = (path: string): void => {
    void requestCloseTabs([path])
  }

  /**
   * 为每个打开的文件标签登记关闭守卫：脏（`content !== savedContent`）时关标签先确认
   * 「丢弃未保存的改动」。守卫读的是最新脏状态（走 ref），所以只随「打开了哪些路径」变化
   * 重登记，编辑内容本身不触发重登记。
   */
  const t = useT()
  const confirm = useConfirm()
  const dirtyMapRef = useRef<Map<string, boolean>>(new Map())
  const nextDirty = new Map<string, boolean>()
  for (const t of tabs) nextDirty.set(t.path, t.content !== t.savedContent)
  dirtyMapRef.current = nextDirty
  const tabPathsKey = tabs.map((t) => t.path).join('\n')
  useEffect(() => {
    const paths = tabPathsKey ? tabPathsKey.split('\n') : []
    const disposers = paths.map((path) =>
      registerTabCloseGuard(fileTabKey(path), {
        beforeClose: async () => {
          if (!dirtyMapRef.current.get(path)) return 'close'
          const ok = await confirm({
            title: t('关闭未保存的文件？'),
            description: t('「{name}」有未保存的改动，关闭标签会丢弃它们。', { name: path.split('/').pop() ?? path }),
            confirmLabel: t('丢弃并关闭'),
            destructive: true
          })
          return ok ? 'close' : 'cancel'
        }
      })
    )
    return () => disposers.forEach((d) => d())
  }, [tabPathsKey, confirm])

  /**
   * 重新从磁盘拉取一个已打开标签的内容（标签条上的刷新按钮）：文件与磁盘不一致时用它拉最新的
   * （Agent 改过文件之后最常见）。拉回来的内容同时写进 `savedContent`，标签回到「干净」。
   */
  const reloadTab = async (path: string): Promise<void> => {
    if (!fsSource) return
    const tab = tabs.find((t) => t.path === path)
    if (!tab) return
    if (isMediaKind(tab.kind)) {
      // 媒体标签没有正文，只有可播放 URL；重新取一次即可（二进制箱里也可能被改动）
      patchTab(path, { mediaLoading: true })
      const url = await fsSource.mediaUrl(path)
      patchTab(path, { mediaUrl: url, mediaLoading: false })
      return
    }
    patchTab(path, { loading: true, error: null })
    try {
      const file = await fsSource.read(path)
      const content = file?.content ?? ''
      patchTab(path, { content, savedContent: content, loading: false })
      toast.success(t('已刷新 {name}', { name: path.split('/').pop() ?? path }))
    } catch (err) {
      patchTab(path, { loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 点刷新按钮：脏标签先弹确认（刷新会丢掉未保存的改动），干净的直接拉 */
  const requestReload = (path: string): void => {
    const tab = tabs.find((t) => t.path === path)
    if (!tab) return
    if (tab.content !== tab.savedContent) setPendingReload(path)
    else void reloadTab(path)
  }

  /**
   * 按「路径映射」就地改写**所有已打开标签**与激活项（移动 / 重命名完成后调用）。
   * 只改路径：内容与脏基线不动 —— 搬家 / 改名不改变内容，未保存的改动照旧留着；
   * 命中的路径若开在「被移动 / 被改名的目录」里（前缀匹配），一并跟到新位置。
   */
  const remapPaths = (remap: (p: string) => string): void => {
    setTabs((prev) => prev.map((t) => (t.path === remap(t.path) ? t : { ...t, path: remap(t.path) })))
    setActiveId((cur) => (cur ? remap(cur) : cur))
  }

  // ---- 剪贴板（复制 / 粘贴）----
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)

  /**
   * 选中的条目（单选 / Ctrl 点选 / Shift 范围选）—— 所有批量的键鼠操作都作用于它：
   * Delete 删除、Ctrl+C/X 复制剪切、Ctrl+V 以它为落点、右键菜单也认它。
   *
   * 与 `activeId`（右侧正打开的标签）是两回事：点目录只选中 / 展开，不会打开它。
   * 顺序与加入顺序一致，`shift` 范围选的锚点单独记在 `anchorPathRef` 里。
   */
  const [selection, setSelection] = useState<AgentFsEntry[]>([])
  /** Shift 范围选的锚点（上一次非 shift 点击的条目路径） */
  const anchorPathRef = useRef<string | null>(null)

  // ---- 手机菜单（Sheet）----
  const [mobileMenuEntry, setMobileMenuEntry] = useState<AgentFsEntry | null>(null)

  // ---- 删除确认弹窗（支持多选，空数组 = 关着）----
  const [deletingEntries, setDeletingEntries] = useState<AgentFsEntry[]>([])

  // ---- 粘贴确认弹窗----
  const [pastingDir, setPastingDir] = useState<string | null>(null)

  // ---- 命名弹窗：新建（文件 / 文件夹）与重命名共用一套 UI，靠 mode 区分 ----
  const [nameDialog, setNameDialog] = useState<
    | { mode: 'create'; kind: 'file' | 'folder'; dir: string }
    | { mode: 'rename'; path: string }
    | null
  >(null)
  const [nameInput, setNameInput] = useState('')
  const [nameBusy, setNameBusy] = useState(false)

  // ---- 上传文件（仅 web 工作区来源，见 canUpload）----
  /** 隐藏的「选文件」input：`openUploadPicker` 先记目标目录，再由它的 onChange 收文件 */
  const uploadInputRef = useRef<HTMLInputElement>(null)
  /** 本次选文件要落到哪个目录（'' = 根目录）；`null` = 没有在等选择 */
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  /** 还没上传的文件（正在传 / 等待重试）；空数组 = 空转 */
  const [uploading, setUploading] = useState<File[]>([])
  /** 同名冲突待确认：目标目录 + 与磁盘上同名的那些文件（用户点「覆盖」才真传） */
  const [uploadConflict, setUploadConflict] = useState<{ dir: string; files: File[] } | null>(null)

  /**
   * `isMobile`（视口 <768px）**只表示「手指 + 没有右键」**：行尾那颗「更多操作」按钮、
   * 长按菜单、行上的触摸手势，以及不给条目裹右键菜单 —— 那些是**输入方式**的判据。
   *
   * ⚠️ 别拿它当布局判据（曾经如此，见 `singlePane`）：窄屏上并排两栏确实挤，但「挤」的
   * 成因是**面板自己的宽度**，不是屏幕宽度 —— 宽屏上把面板 / 侧栏拖窄到 400px，一样挤。
   */
  const isMobile = useIsMobile()

  /**
   * 是否用「一次一屏」的单栏形态（上下钻）。
   *
   * 判据是**容器宽度**（`containerWidth`，面板自身实测），阈值 `FILES_SINGLE_PANE_BELOW_WIDTH`：
   * 窄到这个程度时并排两栏两边都在省略号里挣扎，不如让文件树 / 内容各占一整屏、点开文件翻页。
   *
   * 覆盖两种窄法，正是上一版只认视口漏掉的那种：
   * - **手机**：面板整屏也就 ~390px（视口窄 → 容器必然更窄）；
   * - **宽屏上的窄容器**：流程节点工作台 380px 的节点面板、被拖窄的侧栏 —— 屏幕宽不宽与
   *   这块地方放不放得下两栏毫无关系（旧注释以「手边有鼠标键盘」为由刻意放过它们，
   *   但鼠标键盘并不能把 380px 变宽）。
   *
   * ⚠️ `containerWidth > 0`：宽度没量到之前（首帧）不能判成单栏。`useContainerWidth` 在 ref
   * 挂载时就同步量一次（提交阶段，早于绘制），所以不会有「先并排闪一下再收起」。
   */
  const singlePane = containerWidth > 0 && containerWidth < FILES_SINGLE_PANE_BELOW_WIDTH

  /**
   * 两栏形态用 `@fizz/ui/resizable` 的 `ResizablePanelGroup` 分栏（拖拽、键盘微调、min/max
   * 夹取、容器变化时的重排都由组件负责）；单栏形态仍走原来的普通 flex。
   *
   * ⚠️ `containerWidth > 0` 不能省：Group 的 `defaultSize` **只在挂载那一次读**，首帧容器
   * 宽度还是 0，那时算出来的是兜底 240（`defaultFilesPaneWidth(0)`），面板会永远停在 240
   * 而不是「容器四成」。`useContainerWidth` 在 ref 挂载时同步量一次（提交阶段，早于绘制），
   * 所以这一帧不会被人看见。
   */
  const split = containerWidth > 0 && !singlePane

  /**
   * 只记**用户拖出来的**宽度：挂载、容器变化、`defaultSize` 变更也会触发这个回调
   * （`meta.isUserInteraction` 为 false），把那些值写回去会冲掉用户调好的宽度 ——
   * 容器变窄时还会被夹到下限以下，`setFilesPaneWidth` 会把这种值当「重置」存成 null。
   */
  const handlePaneLayoutChanged: NonNullable<
    ComponentProps<typeof ResizablePanelGroup>['onLayoutChanged']
  > = (_layout, meta) => {
    if (!meta.isUserInteraction) return
    const px = treePanelRef.current?.getSize().inPixels
    if (px && px > 0) setFilesPaneWidth(px)
  }

  /** 双击拖拽条：清掉记忆值，并把面板拨回「按容器算的默认宽」（不是库默认的回到记忆宽） */
  const resetTreePaneWidth = (): void => {
    setFilesPaneWidth(0)
    treePanelRef.current?.resize(defaultFilesPaneWidth(containerWidth))
  }

  /**
   * 单栏形态下停在哪一页：`'tree'` 文件树整屏（默认，也是「返回」回到的那页）、
   * `'file'` 文件内容整屏。
   *
   * 与 `MobileSettingsPanel` 的 `menuOpen` 同一套做法：**选中项不跟着重置** —— 从文件退回来再点
   * 进去，还停在原来那个文件上，不会一路退回根目录（`tabs` / `activeId` 本来就留着）。
   *
   * 名字里不带 `mobile`：形态判据是容器宽度（见 `singlePane`），窄容器桌面端同样走这条路。
   */
  const [pane, setPane] = useState<'tree' | 'file'>('tree')

  /**
   * 数据来源：显式传的 `source` 优先，否则用 `app` + `workspaceId` 造一个。
   *
   * ⚠️ `app`（`useAgentApp`）每次渲染都返回新对象引用，所以**绝不能把它放进 memo 依赖**：
   * 否则每帧都造出新 source，下面「切来源重置整棵树」的 effect 跟着每帧重跑，AI 流式输出时
   * 文件树会一直闪烁（折叠 → 重拉根目录）。用 `appRef` 持有最新 `app`，只在真正切换
   * 「工作区 / 外部 source」时才重算，流式刷新因此不再触发重置。
   */
  const appRef = useRef(app)
  appRef.current = app
  const fsSource = useMemo(
    () => source ?? (workspaceId ? workspaceSource(() => appRef.current, workspaceId) : null),
    [source, workspaceId]
  )
  /** 连接就绪后需要重拉一次（断开重连同理）；它用布尔原语，流式期间稳定不变，不会触发闪烁 */
  const connected = app?.connected ?? false
  const rootLabel = fsSource?.rootLabel || t('工作区')

  /**
   * 单栏形态下「内容那一屏」该不该露头（两栏形态恒为 true，两栏同时在场）。
   *
   * 由 `pane` **加上**「有没有打开文件」共同决定，而不是只认 `pane`：标签全被
   * 关掉之后还停在内容页，用户看到的是一块「未打开文件」的空白 + 一颗返回键 —— 白白挡着树。
   * 让它自动退回文件树，下面两个 `hidden` 都读这一个值，不会各判各的。
   */
  const filePaneShown = !singlePane || (pane === 'file' && tabs.length > 0)

  /**
   * 「显示被忽略的文件」开关（全局偏好，见 `lib/fs-tree-prefs`）。
   *
   * 默认**不给**这个开关的来源：忽略规则是**工作区列表接口**施加的（`DEFAULT_IGNORE_DIRS`
   * + 工作区 `.gitignore`），容器工作台 / 外部来源列的就是原样 —— 给它们放一个点了没用的
   * 按钮比没有更糟，所以只在「自己造工作区来源」时露出来。
   */
  const canShowIgnored = !source && !!workspaceId
  const showIgnored = useShowIgnored()

  /**
   * 拉取一个目录的文件列表。
   *
   * `preserveOpen`：保留目录原有的 `open` 状态（刷新用）；
   * 不传或 `false` = 加载后设为展开（首次展开 / 重新展开用）。
   *
   * 是否列被忽略的条目跟着 `showIgnored` 走（见下面的开关），一次拉取两种口径二选一。
   */
  const fetchDir = async (dir: string, preserveOpen: boolean): Promise<void> => {
    if (!fsSource) return
    setDirs((d) => {
      const open = preserveOpen ? (d[dir]?.open ?? false) : true
      return { ...d, [dir]: { open, loading: true, entries: d[dir]?.entries ?? null } }
    })
    try {
      const res = await fsSource.list(dir, canShowIgnored && showIgnored)
      setDirs((d) => {
        const open = preserveOpen ? (d[dir]?.open ?? false) : true
        return { ...d, [dir]: { open, loading: false, entries: res.entries, truncated: res.truncated } }
      })
    } catch (err) {
      setDirs((d) => {
        const open = preserveOpen ? (d[dir]?.open ?? false) : true
        return { ...d, [dir]: { open, loading: false, entries: [] } }
      })
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 展开 / 重新展开一个目录（加载后 open=true） */
  const loadDir = (dir: string): void => { void fetchDir(dir, false) }

  const refresh = (): void => {
    // 原地刷新已加载的目录：保留展开态与现有条目（只挂 loading 转圈），整棵树不再闪烁。
    // 没有任何目录加载过时退回「拉根目录」这一条老行为。
    const loadedDirs = Object.keys(dirs).filter((dir) => dirs[dir]?.entries)
    if (loadedDirs.length === 0) void loadDir('')
    else loadedDirs.forEach((dir) => void fetchDir(dir, true))
  }

  /**
   * 打开一个文件。已经开过的直接切过去 —— **不重读**，否则标签里未保存的改动会被冲掉。
   * 新标签先挂上去、立刻激活，再异步填内容 / 媒体 URL，读的期间不挡住其他标签。
   */
  const doOpen = async (entry: AgentFsEntry): Promise<void> => {
    if (!fsSource) return
    const kind = previewKindOf(entry.name)
    // 树加载失败留下的提示，开文件时清掉（两码事）
    setLoadError(null)

    if (tabs.some((t) => t.path === entry.path)) {
      setActiveId(entry.path)
      return
    }

    const base: OpenTab = {
      path: entry.path,
      kind,
      // 有预览形态的文本类（svg / markdown / html）默认进预览 —— 点开是「看」的第一步；
      // 纯源码与二进制默认也是各自的唯一形态
      viewMode: hasDualView(kind) ? 'preview' : 'edit',
      content: '',
      savedContent: '',
      loading: false,
      saving: false,
      mediaUrl: null,
      mediaLoading: false,
      error: null
    }

    // 用函数式更新 + 去重：`tabs` 是本次渲染的快照，连点两下会看到同一份旧值，
    // 不去重就会插进两个同 path 的标签（key 撞车）
    const addTab = (tab: OpenTab): void =>
      setTabs((prev) => (prev.some((t) => t.path === tab.path) ? prev : [...prev, tab]))

    if (isMediaKind(kind)) {
      // 二进制 / 媒体：只取可播放 URL，正文不读（binary 最终落到「不支持预览」）
      addTab({ ...base, viewMode: 'preview', mediaLoading: true })
      setActiveId(entry.path)
      const url = await fsSource.mediaUrl(entry.path)
      patchTab(entry.path, { mediaUrl: url, mediaLoading: false })
      return
    }

    // 文本（纯源码 + svg / markdown / html 的源码形态）：先挂空标签进加载态，读回来再填
    addTab({ ...base, loading: true })
    setActiveId(entry.path)
    try {
      const file = await fsSource.read(entry.path)
      patchTab(entry.path, {
        content: file?.content ?? '',
        savedContent: file?.content ?? '',
        loading: false
      })
    } catch (err) {
      patchTab(entry.path, { loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 切来源 / 切工作区：整棵树与打开的文件重来。
   *
   * 依赖里放 `fsSource` 而不是 `workspaceId` —— 容器场景没有 workspaceId，
   * 换节点时 `fsSource` 会是一个新对象，靠它就够触发重置。
   */
  useEffect(() => {
    if (!fsSource) return
    setDirs({})
    // 折叠快照跟着整棵树一起作废：它记的是上一个工作区的展开态
    setCollapsedFrom(null)
    // 换工作区 / 来源：所有标签一起作废（它们指向的是上一个工作区的文件）
    setTabs([])
    setActiveId(null)
    setLoadError(null)
    setClipboard(null)
    setSelection([])
    anchorPathRef.current = null
    setMobileMenuEntry(null)
    setDeletingEntries([])
    setPastingDir(null)
    setNameDialog(null)
    setNameInput('')
    // 换来源 / 换工作区：树是新的，单栏形态得先回到树那一页（正停在内容页的话会是死路 ——
    // 标签已经清空，`filePaneShown` 也会把它顶回树，这里显式复位，语义更清楚）
    setPane('tree')
    void loadDir('')
    // 仅在「来源 / 连接」真正变化时重置；app 引用每帧都变，已不在依赖里，流式不闪烁
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsSource, connected])

  /**
   * 面板**重新露出来**时刷一遍树（收起再展开 / 从 git、终端那些标签切回来）。
   *
   * 为什么必须有这一条：标签内容常挂载（见 `visible` 的注释），收起再展开不重挂组件，
   * 树就一直停在挂出那一刻 —— agent 之后写的文件看不见，用户以为是「不会自动刷新」。
   *
   * `refreshRef` 与 `GitPanel` 同一手法：`refresh` 每次渲染都是新函数且闭包里读着 `dirs`，
   * 直接进依赖会「刷新 → setState → 重渲染 → 又刷新」死循环；`visible` 是稳定原语，
   * 只在**翻面**那一次触发，拿到的就是当次渲染的最新实现。
   *
   * `wasVisible` 只为跳过首帧：挂出这个标签的第一帧 `visible` 就已经是 true，那次加载
   * 由上面那条重置 effect 负责，这里再刷等于把根目录白拉两遍。
   */
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const wasVisibleRef = useRef(visible)
  useEffect(() => {
    const was = wasVisibleRef.current
    wasVisibleRef.current = visible
    if (!visible || was) return
    refreshRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  /**
   * 「显示被忽略」开关翻面后重拉**已加载过的目录**（只重拉它们，别把整棵树推倒）。
   *
   * 为什么不直接在开关的 onClick 里 `refresh()`：`fetchDir` 读的是本次渲染闭包里的
   * `showIgnored`，而 setState 是异步的 —— 点了以后立刻重拉，用的还是旧值，界面纹丝不动
   * （要再点一次才对）。放到 effect 里就跟在「新值已经生效」的那一次渲染后面，不会错拍。
   *
   * `ref` 只为「首帧别白拉一次」：初始值相同就跳过后面的重拉（根目录由上面那条
   * 重置 effect 负责）。开关变化不牵动 `fsSource`，两条 effect 不会互相干扰。
   */
  const showIgnoredRef = useRef(showIgnored)
  useEffect(() => {
    if (showIgnoredRef.current === showIgnored) return
    showIgnoredRef.current = showIgnored
    const loaded = Object.keys(dirs).filter((dir) => dirs[dir]?.entries)
    if (loaded.length === 0) void loadDir('')
    else loaded.forEach((dir) => void fetchDir(dir, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIgnored])

  /**
   * 执行外部的「打开这个文件」请求（消息下方的文档入口，见 `features/files/open-file.ts`）。
   *
   * 复用 `doOpen` —— 于是「已经打开过就切过去、不重读」这些既有取舍自动成立
   * （重读会把标签里未保存的改动冲掉）。
   *
   * ⚠️ 两个「不消费」的分支，都是为了**别把请求白白吃掉**（吃掉了用户点一下毫无反应，
   * 且没有第二次机会）：
   * - `!fsSource`：来源还没就绪，请求留着，等它就绪后的那次渲染再开；
   * - `workspaceId` 对不上：这条是别的会话发的，留给它自己那套面板（这里不吃也不清）。
   *
   * ⚠️ **必须放在上面那个「切来源重来」的 effect 之后**：换工作区那一帧两者会同时触发，
   * 顺序反了的话先开的标签会立刻被重置清空 —— 用户点了文档却什么都没打开。
   */
  useEffect(() => {
    if (!openRequest || !fsSource) return
    if (!workspaceId || openRequest.workspaceId !== workspaceId) return
    consumeOpenFileRequest(openRequest.nonce)
    // 单栏形态：文档入口点进来，就该直接落在文件那一屏（返回键即回树）
    if (singlePane) setPane('file')
    const segments = openRequest.path.split(/[\\/]/)
    void doOpen({
      name: segments[segments.length - 1] || openRequest.path,
      path: openRequest.path,
      type: 'file'
    })
    // `doOpen` 每次渲染都是新函数，进依赖等于每帧重跑一遍；「有没有变化」由请求的 nonce 表达
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, fsSource, workspaceId])

  const toggleDir = (dir: string): void => {
    const state = dirs[dir]
    // 折叠：纯本地翻转即可
    if (state?.open) {
      setDirs((d) => ({ ...d, [dir]: { ...state, open: false } }))
      return
    }
    // 展开（无论是否曾加载过）：都重新拉取，保证内容实时
    void loadDir(dir)
  }

  /** 当前有没有展开着的子目录（根目录本身不算：它一直开着，折叠它等于把树清空） */
  const hasOpenDirs = Object.keys(dirs).some((p) => p !== '' && dirs[p]?.open)

  /**
   * 折叠所有子目录，同时把「折叠前哪些是展开的」记进 `collapsedFrom`（供按钮还原）。
   *
   * 选中集不动：折叠只是把行藏起来，Ctrl+V / 删除该作用到哪一项不受影响
   * （手动折叠一个目录时也是这个行为）。
   */
  const collapseAllDirs = (): void => {
    const openDirs = Object.keys(dirs).filter((p) => p !== '' && dirs[p]?.open)
    if (openDirs.length === 0) return
    setCollapsedFrom(openDirs)
    setDirs((d) => {
      const next: Record<string, DirState> = {}
      for (const [path, state] of Object.entries(d)) {
        next[path] = state.open ? { ...state, open: false } : state
      }
      return next
    })
  }

  /**
   * 还原上一次「折叠所有」之前的展开态。
   *
   * 只开快照里记着、且**现在还在** `dirs` 里的目录：折叠期间可能刷新过、目录被删掉了，
   * 无脑写 `open: true` 会留下一条永远画不出东西的脏状态。
   */
  const restoreCollapsedDirs = (): void => {
    const paths = collapsedFrom ?? []
    setCollapsedFrom(null)
    if (paths.length === 0) return
    setDirs((d) => {
      const next = { ...d }
      for (const path of paths) {
        const state = next[path]
        if (state) next[path] = { ...state, open: true }
      }
      return next
    })
  }

  /** 保存当前标签（Ctrl+S / 保存按钮）。只动这一个标签，其余标签的脏内容原样留着。 */
  const save = async (): Promise<void> => {
    const tab = activeTab
    if (!fsSource || !tab || tab.content === tab.savedContent || tab.saving) return
    const { path, content } = tab
    patchTab(path, { saving: true, error: null })
    const err = await fsSource.write(path, content)
    // 写盘期间用户可能又改了：只把基线推到这次写出去的内容，别把新改动一起标成「已保存」
    if (err === null) patchTab(path, { saving: false, savedContent: content })
    else patchTab(path, { saving: false, error: err })
  }

  const handleKeyDown = (e: ReactKeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    }
  }

  // ---- 复制 / 粘贴 / 删除 / 新建 ----

  /**
   * 把条目写入剪贴板。多选时一次带上全部，粘贴时逐个落到目标目录。
   *
   * 收 `entries` 数组而不是读 `selection`：右键菜单点的那一行可能是多选里的一员，
   * 也可能是被单独右键的一行 —— 由调用方先把「这次操作的是哪几项」算好再传进来。
   */
  const handleCopy = (entries: AgentFsEntry[]): void => {
    if (entries.length === 0) return
    setClipboard({
      entries: entries.map((e) => ({ path: e.path, type: e.type, name: e.name })),
      mode: 'copy'
    })
    toast.success(entries.length > 1 ? t('已复制 {count} 项', { count: entries.length }) : t('已复制：{name}', { name: entries[0].name }))
    setMobileMenuEntry(null)
  }

  const handleCut = (entries: AgentFsEntry[]): void => {
    if (entries.length === 0) return
    setClipboard({
      entries: entries.map((e) => ({ path: e.path, type: e.type, name: e.name })),
      mode: 'cut'
    })
    toast.success(
      entries.length > 1
        ? t('已剪切 {count} 项（Ctrl+V 或右键目标文件夹选「粘贴到此处」）', { count: entries.length })
        : t('已剪切：{name}（Ctrl+V 或右键目标文件夹选「粘贴到此处」）', { name: entries[0].name })
    )
    setMobileMenuEntry(null)
  }

  /**
   * 粘贴到某个父目录。剪贴板是「剪切」时执行**移动**（成功后清空剪贴板），
   * 否则执行复制（可反复粘贴）。多选时逐个来 —— 服务端一次只吃一个条目。
   *
   * 移动不改文件名，所以新路径能直接推出来 —— 用它把右侧正打开的文件就地改到新位置，
   * 而不是像删除那样把预览区清掉。
   */
  const handlePaste = async (targetDir: string): Promise<void> => {
    const clip = clipboard
    if (!clip || !fsSource) return
    const isCut = clip.mode === 'cut'
    const run = isCut ? fsSource.move : fsSource.copy
    if (!run) {
      toast.error(isCut ? t('当前数据源不支持移动') : t('当前数据源不支持复制'))
      return
    }
    setMobileMenuEntry(null)

    // 剪切到它自己所在目录 = 空操作：跳过。全都属于这种情况时只提示一下，**不清空剪贴板**
    const items = clip.entries.filter((it) => !(isCut && targetDir === parentDirOf(it.path)))
    if (items.length === 0) {
      toast.error(clip.entries.length > 1 ? t('它们已经在这个目录里了') : t('它已经在这个目录里了'))
      return
    }

    /** 成功的条目：from = 旧路径，to = 新路径（移动时要拿它改右侧打开的文件 / 清旧缓存） */
    const done: Array<{ from: string; to: string; name: string }> = []
    const failures: string[] = []
    for (const it of items) {
      const err = await run(it.path, targetDir)
      if (err !== null) failures.push(`${it.name}：${err}`)
      else done.push({ from: it.path, to: targetDir ? `${targetDir}/${it.name}` : it.name, name: it.name })
    }

    if (failures.length > 0) {
      toast.error(
        t('{verb}失败（{failed}/{total}）：{errors}', { verb: isCut ? t('移动') : t('复制'), failed: failures.length, total: items.length, errors: failures.join(t('；')) })
      )
    }
    if (done.length === 0) return

    const verb = isCut ? t('移动') : t('复制')
    toast.success(
      done.length > 1
        ? t('已{verb} {count} 项到 {dir}', { verb, count: done.length, dir: targetDir || '/' })
        : t('已{verb}「{name}」到 {dir}', { verb, name: done[0].name, dir: targetDir || '/' })
    )

    if (!isCut) {
      refresh()
      return
    }

    // ---- 剪切：移动完成后的收尾 ----
    /** 把一条路径按「移动映射」换算到新位置（不在被移动子树里则原样返回） */
    const remap = (path: string): string => {
      for (const { from, to } of done) {
        if (path === from) return to
        if (path.startsWith(`${from}/`)) return to + path.slice(from.length)
      }
      return path
    }
    // 右侧已打开的标签跟着到新位置（含「它就开在被移动的目录里」的情况）
    remapPaths(remap)
    // 选中的路径全变了，整体清掉（键盘下一轮操作从头开始）
    setSelection([])
    anchorPathRef.current = null
    // 被移走条目（及其子孙）在缓存里的旧路径作废，免得重拉时去拉已不存在的目录
    const oldPaths = done.map((m) => m.from)
    setDirs((d) => {
      const next: Record<string, DirState> = {}
      for (const [key, value] of Object.entries(d)) {
        if (oldPaths.some((p) => key === p || key.startsWith(`${p}/`))) continue
        next[key] = value
      }
      return next
    })
    setClipboard(null)
    // 源父目录（条目已移走）与目标目录（多了条目）各重拉一次；只拉已加载过的
    const reload = new Set(done.map((m) => parentDirOf(m.from)))
    reload.add(targetDir)
    for (const dir of reload) if (dirs[dir]?.entries) void loadDir(dir)
  }

  const handleDelete = (entries: AgentFsEntry[]): void => {
    if (entries.length === 0) return
    setDeletingEntries(entries)
    setMobileMenuEntry(null)
  }

  /** 下载单个文件（树右键 / 手机菜单 / 标签条按钮都走这里）。入参不收条目对象：标签条那边只有 `OpenTab`（没有 name） */
  const handleDownload = async (path: string, name: string): Promise<void> => {
    if (!fsSource?.download) return
    const err = await fsSource.download(path, name)
    if (err) toast.error(t('下载失败：{error}', { error: err }))
    else toast.success(t('已开始下载 {name}', { name }))
  }

  /** 下载一个文件夹（树右键 / 手机菜单）：服务端打包成 zip 再落盘，所以文件名补 `.zip` */
  const handleDownloadDir = async (path: string, name: string): Promise<void> => {
    if (!fsSource?.downloadDir) return
    const fileName = `${name}.zip`
    const err = await fsSource.downloadDir(path, fileName)
    if (err) toast.error(t('下载失败：{error}', { error: err }))
    else toast.success(t('已开始下载 {name}', { name: fileName }))
  }

  /**
   * 在系统文件管理器里定位单个文件（desktop）。
   *
   * 传**相对路径**而不是文件名：工作区来源要拿它去拼宿主机绝对路径，只给文件名的话
   * （重名 / 深层目录）会定位到别的东西上去。
   */
  const handleReveal = async (path: string): Promise<void> => {
    if (!fsSource?.revealInFileManager) return
    const err = await fsSource.revealInFileManager(path)
    if (err) toast.error(err)
  }

  /**
   * 在系统文件管理器里**打开目录**（desktop）——文件夹右键、文件树空白处（= 根目录）。
   * 空路径就是根目录，交给来源去拼绝对路径（面板不知道 `ws.path`）。
   */
  const handleOpenInFileManager = async (path: string): Promise<void> => {
    if (!fsSource?.openInFileManager) return
    const err = await fsSource.openInFileManager(path)
    if (err) toast.error(err)
  }

  const confirmDelete = async (): Promise<void> => {
    const targets = deletingEntries
    if (targets.length === 0 || !fsSource) return
    if (!fsSource.delete) {
      toast.error(t('当前数据源不支持删除'))
      setDeletingEntries([])
      return
    }
    const deleted: AgentFsEntry[] = []
    const failures: string[] = []
    for (const entry of targets) {
      const err = await fsSource.delete(entry.path)
      if (err === null) deleted.push(entry)
      else failures.push(`${entry.name}：${err}`)
    }
    if (failures.length > 0) {
      toast.error(t('删除失败（{failed}/{total}）：{errors}', { failed: failures.length, total: targets.length, errors: failures.join(t('；')) }))
    }
    if (deleted.length > 0) {
      toast.success(deleted.length > 1 ? t('已删除 {count} 项', { count: deleted.length }) : t('已删除：{name}', { name: deleted[0].name }))
      /** 这个路径在不在被删条目（含其子孙）里 */
      const wasDeleted = (path: string): boolean =>
        deleted.some((d) => path === d.path || path.startsWith(`${d.path}/`))
      // 指向被删路径（含其子孙）的标签全部关掉（不只是当前标签）
      const doomed = tabs.filter((t) => wasDeleted(t.path)).map((t) => t.path)
      if (doomed.length > 0) closeTabs(doomed)
      // 选中项里被删掉的剔除（保留其余），否则 Delete / Ctrl+C 会打向已不存在的路径
      setSelection((prev) => prev.filter((e) => !wasDeleted(e.path)))
      if (anchorPathRef.current && wasDeleted(anchorPathRef.current)) anchorPathRef.current = null
      // 被删目录的子孙缓存一并丢掉：否则同名文件夹重建后再展开，看到的还是上一份内容
      setDirs((d) => {
        const next: Record<string, DirState> = {}
        for (const [key, value] of Object.entries(d)) {
          if (deleted.some((r) => key === r.path || key.startsWith(`${r.path}/`))) continue
          next[key] = value
        }
        return next
      })
      refresh()
    }
    setDeletingEntries([])
  }

  const handleNewEntry = (kind: 'file' | 'folder', dir: string): void => {
    setNameDialog({ mode: 'create', kind, dir })
    setNameInput('')
    setMobileMenuEntry(null)
  }

  /**
   * 打开系统的「选文件」对话框，把选中的文件上传到 `dir`。
   *
   * 每次都先清空 `input.value`：同一批文件连选两次也要能触发 change —— 浏览器对
   * 「值没变」的 file input 不派发 change（第二次点上传会毫无反应）。
   */
  const openUploadPicker = (dir: string): void => {
    setMobileMenuEntry(null)
    setUploadTarget(dir)
    const input = uploadInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  /**
   * 上传一批文件到某个目录。
   *
   * 冲突分两步：先按 `overwrite: false` 传，服务端对「已存在同名文件」回 **409**；把冲突
   * 的那些攒下来交给确认弹窗，用户点头才带 `overwrite: true` 重传 —— 绝不静默覆盖。
   * （面板的树是懒加载的，右键的那个目录很可能还没展开、面板并不知道里面有什么，
   * 所以「同名」只能由服务端判。）
   */
  const runUpload = async (dir: string, files: File[], overwrite = false): Promise<void> => {
    const upload = fsSource?.upload
    if (!upload || files.length === 0) return
    setUploading(files)
    const conflicts: File[] = []
    const failed: string[] = []
    let uploaded = 0
    try {
      for (const file of files) {
        const r = await upload(dir, file, overwrite)
        if (r.ok) uploaded += 1
        else if (r.conflict && !overwrite) conflicts.push(file)
        else failed.push(`${file.name}：${r.error}`)
      }
    } finally {
      setUploading([])
    }
    if (uploaded > 0) {
      toast.success(files.length === 1 ? t('已上传 {name}', { name: files[0].name }) : t('已上传 {count} 个文件', { count: uploaded }))
      refresh()
      // 只开第一个：多选时把右侧塞满标签反而更烦
      if (files.length === 1) {
        const name = files[0].name
        void doOpen({ name, path: dir ? `${dir}/${name}` : name, type: 'file' })
      }
    }
    if (failed.length > 0) toast.error(t('上传失败：{errors}', { errors: failed.join(t('；')) }))
    if (conflicts.length > 0) setUploadConflict({ dir, files: conflicts })
  }

  /** 打开重命名弹窗（文件树右键 / 手机长按菜单）。名字预填当前名，用户直接改 */
  const handleRename = (entry: AgentFsEntry): void => {
    if (!fsSource?.move) {
      toast.error(t('当前数据源不支持重命名'))
      return
    }
    setNameDialog({ mode: 'rename', path: entry.path })
    setNameInput(entry.name)
    setMobileMenuEntry(null)
  }

  /** 命名弹窗的「确定」：按 mode 分派到重命名 / 新建。失败保留弹窗与输入，让用户改完重试 */
  const confirmName = async (): Promise<void> => {
    // ⚠️ 用 `=== null` 判断「弹窗没开」：新建到根目录时 `dir` 是空串，`!dir` 会误判
    if (nameDialog === null || !fsSource) return
    const name = nameInput.trim()
    if (!name) {
      toast.error(t('名字不能为空'))
      return
    }
    if (/[/\\]/.test(name)) {
      toast.error(t('名字里不能有 / 或 \\'))
      return
    }

    // ---- 重命名 ----
    if (nameDialog.mode === 'rename') {
      const { path } = nameDialog
      const move = fsSource.move
      if (!move) {
        toast.error(t('当前数据源不支持重命名'))
        return
      }
      const oldName = path.split('/').pop() ?? path
      if (name === oldName) {
        // 名字没变：直接关掉，不白跑一趟服务端
        setNameDialog(null)
        setNameInput('')
        return
      }
      const parent = parentDirOf(path)
      setNameBusy(true)
      try {
        const err = await move(path, parent, name)
        if (err !== null) {
          toast.error(t('重命名失败：{error}', { error: err }))
          return
        }
        toast.success(t('已重命名为「{name}」', { name }))
        // 已打开的标签跟着到新路径（含「它就开在被重命名目录里」的情况）
        const newPath = parent ? `${parent}/${name}` : name
        remapPaths((p) =>
          p === path ? newPath : p.startsWith(`${path}/`) ? newPath + p.slice(path.length) : p
        )
        // 旧路径（含子孙）的目录缓存作废，免得再展开时看到上一份内容
        setDirs((d) => {
          const next: Record<string, DirState> = {}
          for (const [key, value] of Object.entries(d)) {
            if (key === path || key.startsWith(`${path}/`)) continue
            next[key] = value
          }
          return next
        })
        // 旧路径的选中项一并清掉，否则键盘下一轮会把动作打向已不存在的路径
        setSelection([])
        anchorPathRef.current = null
        // 父目录（文件名变了）重拉一次；只拉已加载过的
        if (dirs[parent]?.entries) void loadDir(parent)
      } finally {
        setNameBusy(false)
      }
      setNameDialog(null)
      setNameInput('')
      return
    }

    // ---- 新建 ----
    const { kind, dir } = nameDialog
    const label = kind === 'file' ? t('文件') : t('文件夹')
    // 该目录已加载时先查重：写接口是 create-or-overwrite，不拦的话会悄悄覆盖同名文件
    if (dirs[dir]?.entries?.some((e) => e.name === name)) {
      toast.error(t('已存在同名{label}：{name}', { label, name }))
      return
    }
    const create = kind === 'file' ? fsSource.createFile : fsSource.mkdir
    if (!create) {
      toast.error(t('当前数据源不支持新建{label}', { label }))
      return
    }
    setNameBusy(true)
    try {
      const err = await create(dir, name)
      if (err !== null) {
        toast.error(t('新建失败：{error}', { error: err }))
        return
      }
      toast.success(t('已新建{label}', { label }))
      refresh()
      // 新建文件：顺手把它在右侧打开，用户可以直接开始写
      if (kind === 'file') void doOpen({ name, path: dir ? `${dir}/${name}` : name, type: 'file' })
    } finally {
      setNameBusy(false)
    }
    setNameDialog(null)
    setNameInput('')
  }

  /** 获取某个条目的父目录路径（用于粘贴到同级） */
  const parentDirOf = (path: string): string => {
    const idx = path.lastIndexOf('/')
    return idx <= 0 ? '' : path.slice(0, idx)
  }

  /**
   * 「粘贴到此处」的目标目录：
   * - 条目是**文件夹** → 粘进这个文件夹里（资源管理器里选中文件夹粘贴就是这个语义，
   *   也是「剪切后移进某个文件夹」能成立的前提）；
   * - 条目是**文件** → 粘到它所在目录（即「和它并排」）。
   */
  const pasteTargetOf = (entry: AgentFsEntry): string =>
    entry.type === 'dir' ? entry.path : parentDirOf(entry.path)

  /**
   * 把当前展开的树按**显示顺序**拍平成一条数组（渲染仍走 `renderEntry` 的递归）。
   * Shift 范围选要知道「从头到尾都有谁」，而 `dirs` 是按目录散着存的，没法直接用。
   */
  const visibleEntries = (): AgentFsEntry[] => {
    const out: AgentFsEntry[] = []
    const walk = (dir: string): void => {
      const state = dirs[dir]
      if (!state?.entries) return
      for (const e of state.entries) {
        out.push(e)
        if (e.type === 'dir' && dirs[e.path]?.open) walk(e.path)
      }
    }
    walk('')
    return out
  }

  /**
   * 点行的选中逻辑（资源管理器那一套）：
   * - 普通点击 → 只选它并记下锚点；目录照样展开、文件照样打开；
   * - Ctrl/Cmd+点击 → 在选中集里加上 / 去掉这一项；
   * - Shift+点击 → 从锚点到它、按可见顺序整段选中（只选，不展开也不打开）。
   */
  const handleRowClick = (entry: AgentFsEntry, e: ReactMouseEvent<HTMLButtonElement>): void => {
    // 长按刚弹出菜单时抬手的那一下 click：拦掉，别再打开文件 / 展开目录
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (e.shiftKey) {
      const list = visibleEntries()
      const anchor = anchorPathRef.current
      const from = anchor ? list.findIndex((x) => x.path === anchor) : -1
      const to = list.findIndex((x) => x.path === entry.path)
      if (from >= 0 && to >= 0) {
        setSelection(from <= to ? list.slice(from, to + 1) : list.slice(to, from + 1))
        return
      }
      // 锚点已不在可见区（目录被折叠 / 条目被删）：退化成下面的单选
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((prev) =>
        prev.some((x) => x.path === entry.path)
          ? prev.filter((x) => x.path !== entry.path)
          : [...prev, entry]
      )
      anchorPathRef.current = entry.path
      return
    }
    setSelection([entry])
    anchorPathRef.current = entry.path
    // 只有普通点击才展开目录 / 打开文件；Ctrl、Shift 是在挑东西，不该顺带把目录展开
    if (entry.type === 'dir') {
      toggleDir(entry.path)
      return
    }
    void doOpen(entry)
    // 单栏形态：点文件就翻到内容那一屏。**目录不翻** —— 否则点开一个目录就被踢出树，
    // 想连着看两层目录得反复点返回；`Ctrl/Shift` 那两条分支在上面已经 return，也不翻
    if (singlePane) setPane('file')
  }

  /** 一次操作要作用的条目：右键那一行在多选里 → 整批；否则只有它自己 */
  const targetsOf = (entry: AgentFsEntry): AgentFsEntry[] =>
    selection.some((s) => s.path === entry.path) ? selection : [entry]

  /**
   * 进粘贴确认弹窗前先记下目标目录。右键菜单、头部按钮、Ctrl+V 都走这里 —— 粘贴会往工作区
   * 写东西（复制）或搬走东西（剪切），和删除一样属于「动手前先问一句」那一类。
   */
  const requestPaste = (targetDir: string): void => {
    setMobileMenuEntry(null)
    if (!clipboard) {
      toast.error(t('剪贴板是空的：先复制或剪切条目'))
      return
    }
    setPastingDir(targetDir)
  }

  const confirmPaste = async (): Promise<void> => {
    const dir = pastingDir
    setPastingDir(null)
    if (dir === null) return
    await handlePaste(dir)
  }

  /**
   * 粘贴的落点（「选中的目录 / 当前目录」）：
   * - 选中一个目录 → 粘进去；选中一个文件 → 粘到它的同级；
   * - 选中多个 → 粘到第一个的所在目录（多选时没有唯一的「里面的那个目录」）；
   * - 一个都没选 → 退到右侧当前标签所在目录，再退回根目录。
   */
  const currentPasteTarget = (): string => {
    if (selection.length === 1) return pasteTargetOf(selection[0])
    if (selection.length > 1) return parentDirOf(selection[0].path)
    if (activeId) return parentDirOf(activeId)
    return ''
  }

  /**
   * 文件树里的快捷键（挂在树的滚动容器上，靠行内按钮的冒泡接）：
   * Delete 删除、Ctrl/Cmd+C 复制、Ctrl/Cmd+X 剪切、Ctrl/Cmd+V 粘贴、Ctrl/Cmd+A 全选。
   *
   * ⚠️ 刻意**不**挂到整个面板上：右侧 Monaco 自己也用这套快捷键做文本编辑，
   * 挂到外层会连编辑器里的复制粘贴一起吞掉。弹窗输入框在 portal 里，天然不受影响。
   */
  const handleTreeKeyDown = (e: ReactKeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    // Backspace 一并认：macOS 键盘上那颗写着 delete 的键发出来的就是 Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.length === 0) return
      e.preventDefault()
      handleDelete(selection)
      return
    }
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 'c' || key === 'x') {
      if (selection.length === 0) return
      e.preventDefault()
      if (key === 'c') handleCopy(selection)
      else handleCut(selection)
      return
    }
    if (key === 'v') {
      e.preventDefault()
      requestPaste(currentPasteTarget())
      return
    }
    if (key === 'a') {
      e.preventDefault()
      setSelection(visibleEntries())
    }
  }

  // ---------- 手机长按 ----------
  //
  // 500ms 不长按完再动手指就取消；一旦长按成功，**抬手时那个 click 必须吞掉** ——
  // 否则底部菜单弹出来的同时文件也被打开了（实测目录还会被展开），体感像误触。
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)

  const onTouchStart = (e: ReactTouchEvent, entry: AgentFsEntry): void => {
    const touch = e.touches[0]
    if (!touch) return
    suppressClickRef.current = false
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      suppressClickRef.current = true
      navigator.vibrate?.(50)
      // 手机没有多选（没有 Ctrl / Shift），长按就当作选中它自己
      setSelection([entry])
      anchorPathRef.current = entry.path
      setMobileMenuEntry(entry)
    }, 500)
  }

  const onTouchEnd = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    touchStartRef.current = null
  }

  const onTouchMove = (e: ReactTouchEvent): void => {
    if (!longPressTimerRef.current || !touchStartRef.current) return
    const touch = e.touches[0]
    if (!touch) return
    const dx = Math.abs(touch.clientX - touchStartRef.current.x)
    const dy = Math.abs(touch.clientY - touchStartRef.current.y)
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  // 面板卸载时把还在等长按的定时器收掉（切工作区 / 关面板时它还在跑）
  useEffect(
    () => () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    },
    []
  )

  // ---------- 菜单 ----------

  /**
   * 桌面右键 / 手机长按共用的动作清单（两端各自渲染，内容永远一致）。
   *
   * 右键的那一行若在多选里，复制 / 剪切 / 删除作用于**整批**（`targetsOf`），
   * 标签上带「N 项」让用户看清这一下会动多少东西；「新建」只在单独选中一个目录时给，
   * 多选时不知道该往哪个目录里建。下载 / 定位同理只给**单个文件**：目录打包成 zip 没做。
   */
  const menuActionsOf = (entry: AgentFsEntry): MenuAction[] => {
    const targets = targetsOf(entry)
    const n = targets.length
    const bulk = n > 1
    /** 「复制绝对路径」的拼接方（来源没提供 = 这个入口不渲染，见 `FilesSource.absolutePath`） */
    const absolutePathOf = fsSource?.absolutePath
    return [
      { label: bulk ? t('复制 {count} 项', { count: n }) : t('复制'), icon: <Copy className="size-4" />, run: () => handleCopy(targets) },
      { label: bulk ? t('剪切 {count} 项', { count: n }) : t('剪切'), icon: <Scissors className="size-4" />, run: () => handleCut(targets) },
      // 重命名只作用于单条；不支持 `move` 的来源（容器工作台）不渲染这个入口
      ...(!bulk && fsSource?.move
        ? [{ label: t('重命名'), icon: <Pencil className="size-4" />, run: () => handleRename(entry) }]
        : []),
      ...(clipboard
        ? [
            {
              label: t('粘贴到此处'),
              icon: <ClipboardPaste className="size-4" />,
              run: () => requestPaste(pasteTargetOf(entry))
            }
          ]
        : []),
      // 复制路径 / 复制绝对路径：只读动作，且**只给单条** —— 多选时「复制的是哪一条路径」
      // 没有共识（资源管理器里它也只作用于右键的那一行），批量复制一串路径留给键盘用户自己做。
      // 复制路径 = 树里显示的**相对路径**（agent 的工具参数、git 命令都用它）；
      // 复制绝对路径 = 拼接根目录后的宿主机 / 容器路径（拿去终端、外部工具里用）。
      ...(!bulk
        ? [
            {
              label: t('复制路径'),
              icon: <ClipboardCopy className="size-4" />,
              run: () => {
                setMobileMenuEntry(null)
                copyText(entry.path, t('已复制路径：{path}', { path: entry.path }))
              }
            },
            ...(absolutePathOf
              ? [
                  {
                    label: t('复制绝对路径'),
                    icon: <FileSymlink className="size-4" />,
                    run: () => {
                      setMobileMenuEntry(null)
                      const abs = absolutePathOf(entry.path)
                      if (abs === null) {
                        toast.error(t('根目录未知，暂时拼不出绝对路径'))
                        return
                      }
                      copyText(abs, t('已复制绝对路径：{path}', { path: abs }))
                    }
                  }
                ]
              : [])
          ]
        : []),
      // 下载 / 定位是只读动作，也要伸手够得着：web 下到浏览器下载目录，desktop 在资源管理器里选中
      ...(!bulk && entry.type === 'file' && canReveal
        ? [
            {
              label: t('在文件管理器中显示'),
              icon: <FolderSearch className="size-4" />,
              run: () => {
                // 手机端：菜单要收下去（桌面右键菜单点了自己会关）
                setMobileMenuEntry(null)
                void handleReveal(entry.path)
              }
            }
          ]
        : []),
      // 文件夹：没有「选中它」的等价语义 —— 用户要的是进去看，所以走 openFileManagerAt（打开目录）
      ...(!bulk && entry.type === 'dir' && canOpenInFileManager
        ? [
            {
              label: t('在文件管理器中打开'),
              icon: <FolderOpen className="size-4" />,
              run: () => {
                setMobileMenuEntry(null)
                void handleOpenInFileManager(entry.path)
              }
            }
          ]
        : []),
      ...(!bulk && entry.type === 'file' && canDownload
        ? [
            {
              label: t('下载'),
              icon: <Download className="size-4" />,
              run: () => {
                setMobileMenuEntry(null)
                void handleDownload(entry.path, entry.name)
              }
            }
          ]
        : []),
      // 文件夹下载（服务端打 zip）。与单文件「下载」同一条判据：desktop 宿主下文件本机就够得着，
      // 不需要下载按钮，所以这里也跟 canDownload 走（canDownload 已含「非 desktop」与来源支持下载）。
      ...(!bulk && entry.type === 'dir' && canDownload && fsSource?.downloadDir
        ? [
            {
              label: t('下载（zip）'),
              icon: <Download className="size-4" />,
              run: () => {
                setMobileMenuEntry(null)
                void handleDownloadDir(entry.path, entry.name)
              }
            }
          ]
        : []),
      ...(!bulk && entry.type === 'dir'
        ? [
            {
              label: t('新建文件'),
              icon: <FilePlus2 className="size-4" />,
              run: () => handleNewEntry('file', entry.path)
            },
            {
              label: t('新建文件夹'),
              icon: <FolderPlus className="size-4" />,
              run: () => handleNewEntry('folder', entry.path)
            },
            // 上传到**这个目录**：仅 web 工作区来源（见 canUpload）
            ...(canUpload
              ? [
                  {
                    label: t('上传文件'),
                    icon: <Upload className="size-4" />,
                    run: () => openUploadPicker(entry.path)
                  }
                ]
              : [])
          ]
        : []),
      {
        label: bulk ? t('删除 {count} 项', { count: n }) : t('删除'),
        icon: <Trash2 className="size-4" />,
        danger: true,
        run: () => handleDelete(targets)
      }
    ]
  }

  /** 桌面右键菜单项（手机端用 Sheet 渲染同一份 `menuActionsOf`，见文件末尾） */
  const contextMenuItems = (entry: AgentFsEntry): ReactNode => (
    <>
      {menuActionsOf(entry).map((a) => (
        <ContextMenuItem
          key={a.label}
          variant={a.danger ? 'destructive' : undefined}
          onClick={a.run}
        >
          {a.icon}
          <span>{a.label}</span>
        </ContextMenuItem>
      ))}
    </>
  )

  /**
   * 标签条上右键某个标签时的动作清单（浏览器标签那一套）。作用范围按**标签条的显示顺序**
   * 算：「右侧 / 左侧」指这个标签右边 / 左边的那一批，「关闭其他」则是除它以外的全部。
   * 没有可关的项时对应项置灰（如右键的就是最后一个标签，「关闭右侧」无从关起）。
   */
  const tabMenuActionsOf = (path: string): MenuAction[] => {
    const idx = tabs.findIndex((t) => t.path === path)
    if (idx < 0) return []
    const all = tabs.map((t) => t.path)
    const right = all.slice(idx + 1)
    const left = all.slice(0, idx)
    const others = all.filter((p) => p !== path)
    return [
      { label: t('关闭'), icon: <X className="size-4" />, run: () => requestCloseTabs([path]) },
      {
        label: t('关闭其他'),
        icon: <ListX className="size-4" />,
        disabled: others.length === 0,
        run: () => requestCloseTabs(others)
      },
      {
        label: t('关闭右侧'),
        icon: <PanelRightClose className="size-4" />,
        disabled: right.length === 0,
        run: () => requestCloseTabs(right)
      },
      {
        label: t('关闭左侧'),
        icon: <PanelLeftClose className="size-4" />,
        disabled: left.length === 0,
        run: () => requestCloseTabs(left)
      },
      {
        label: t('关闭全部'),
        icon: <SquareX className="size-4" />,
        disabled: all.length === 0,
        run: () => requestCloseTabs(all)
      }
    ]
  }

  /** 标签的桌面右键菜单项（关闭相关的 5 项，「关闭全部」前加一条分隔线） */
  const tabMenuItems = (path: string): ReactNode => (
    <>
      {tabMenuActionsOf(path).map((a, i) => (
        <Fragment key={a.label}>
          {i === 4 && <ContextMenuSeparator />}
          <ContextMenuItem
            disabled={a.disabled}
            variant={a.danger ? 'destructive' : undefined}
            onClick={a.run}
          >
            {a.icon}
            <span>{a.label}</span>
          </ContextMenuItem>
        </Fragment>
      ))}
    </>
  )

  // ---------- 渲染一个条目 ----------

  function renderEntry(entry: AgentFsEntry, depth: number): ReactNode {
    const isDir = entry.type === 'dir'
    const child = isDir ? dirs[entry.path] : undefined
    const open = !!child?.open
    // 正被剪切、等着粘贴的条目：整行压暗
    const cut = clipboard?.mode === 'cut' && clipboard.entries.some((e) => e.path === entry.path)

    const body = (
      <TreeRow
        depth={depth}
        name={entry.name}
        isDir={isDir}
        open={open}
        active={entry.path === activeId}
        selected={selection.some((s) => s.path === entry.path)}
        ignored={entry.ignored}
        cut={cut}
        onActivate={(e) => handleRowClick(entry, e)}
        trailing={
          isMobile ? (
            <MobileEntryMoreButton
              onOpen={() => {
                setSelection([entry])
                anchorPathRef.current = entry.path
                setMobileMenuEntry(entry)
              }}
            />
          ) : undefined
        }
        touch={
          isMobile
            ? {
                onTouchStart: (e) => onTouchStart(e, entry),
                onTouchEnd,
                onTouchMove
              }
            : undefined
        }
      />
    )

    return (
      <div key={entry.path}>
        {/*
          桌面：右键菜单只裹住**这一行**。子条目渲染在菜单元素**外面** ——
          否则层层嵌套的 contextmenu 事件会一路冒泡上去，点孙子的菜单能把
          爷爷目录的菜单同时打开（Radix 不判断 defaultPrevented）。
        */}
        {isMobile ? (
          body
        ) : (
          // 右键：不在选中集里就把选中集换成这一行（资源管理器如此）；已在选中集里则保持整批不动，
          // 菜单里那些「删除 N 项」正是靠这个才能作用到多选上
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) return
              if (!selection.some((s) => s.path === entry.path)) {
                setSelection([entry])
                anchorPathRef.current = entry.path
              }
            }}
          >
            <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">{contextMenuItems(entry)}</ContextMenuContent>
          </ContextMenu>
        )}
        {/* 展开态由行首箭头表示，不再渲染「读取中 / 空文件夹」占位行：
            孩子目录未加载完 / 为空时直接什么都不画 */}
        {open && child?.entries?.map((e) => renderEntry(e, depth + 1))}
        {/* 目录太大、服务端只回了一批：必须说一声。悄悄少列一半，用户只会得出
            「我的文件不见了」—— 那是最难自证、也最难被想到去查的一类问题 */}
        {open && child?.truncated && (
          <div
            style={{ paddingLeft: treeIndent(depth + 1, 14, 8) }}
            className="py-1 pr-2 text-xs text-amber-600/90 dark:text-amber-400/90"
          >
            {t("目录条目过多，未全部列出")}
          </div>
        )}
      </div>
    )
  }

  const fileName = activeTab ? activeTab.path.split('/').pop() ?? activeTab.path : null
  const dirty = activeTab !== null && activeTab.content !== activeTab.savedContent
  const showPreview =
    activeTab !== null &&
    isPreviewable(activeTab.kind) &&
    // 有文本形态的（svg / md / html）靠 viewMode 切；纯媒体恒为预览态
    (!hasDualView(activeTab.kind) || activeTab.viewMode === 'preview')
  const editable = isEditable(activeTab?.kind)
  /**
   * 「下载 / 在文件管理器中显示」两个入口的可用性，**同一槽位二选一**：
   *
   * 判据是**宿主要不要得着这台机器**，不是"来源上声没声明方法"（踩过：`workspaceSource`
   * 无条件赋值 `revealInFileManager`，只看声明的话 web 下也恒为 true，于是浏览器里冒出个
   * 必然失败的定位按钮、下载反倒被藏掉 —— 正好反了）：
   *
   * - **desktop 宿主**：后端就跑在这台机器上，工作区路径真实存在于本机磁盘 → **只能定位**
   *   （在资源管理器里选中它，比下到浏览器下载目录顺手，下载反而多余）；
   * - **web 宿主 / 容器工作台**：要么压根没有本机概念，要么文件在镜像里 → 只有**下载**。
   */
  const canReveal = !!fsSource?.revealInFileManager && !!getAgentHostOrNull()?.revealInFileManager
  const canDownload = !!fsSource?.download && !canReveal
  /**
   * 「在文件管理器中打开**目录**」的可用性（文件夹右键 / 文件树空白处 = 根目录）。
   *
   * 与 `canReveal` 同一道判据（宿主真能碰本机才算），只是走另一条宿主出口
   * `openFileManagerAt`：「定位文件」与「打开目录」在系统层面就是两个动作
   * （Windows 是 explorer 的两种参数，macOS 是 `open` 与 `open -R`）。
   * 这条入口只在 desktop 露头：web / 手机宿主没实现 `openFileManagerAt`，恒为 false。
   */
  const canOpenInFileManager =
    !!fsSource?.openInFileManager && !!getAgentHostOrNull()?.openFileManagerAt
  /**
   * 「重新从磁盘读当前文件」的按钮 —— 挂在**标签自己身上**，关闭 × 的左侧
   * （`PanelTab` 的 `actions` 槽位）。
   *
   * 之前它在 Monaco 工具栏右侧（`actions`）：
   * - 预览态下 Monaco 整块不挂 → 按钮跟着消失，而「Agent 刚改完盘上的文件，我想把新内容
   *   拉回来」恰恰在预览 markdown 时最需要；
   * - 它是**文件**层面的动作，不是「编辑器这个控件」的动作，挂在编辑器工具栏里本来就别扭。
   *
   * **不能直接删**：Agent 改过磁盘上的文件之后，这是唯一能把新内容拉回来、并且把标签重新
   * 标回「干净」的入口（`reloadTab` 会同时写 `savedContent`）。
   *
   * 做成**按路径生成**而不是给激活标签做一颗常量：每颗标签都有它（理由见 `PanelTab`
   * 文件头「宽度稳定」），点哪颗刷新哪颗。
   */
  const reloadAction = (path: string): ReactNode => (
    // 用 `RowActionButton` + 原生 `title`（不用 `IconTip`）：它和 × 同处一个 hover 浮层，
    // 两颗按钮的提示形态得一致 —— 一颗是 Radix 气泡、一颗是原生 title，同一个位置弹出
    // 两种东西很怪；`PanelTab` 里的 × 用的正是原生 title
    <RowActionButton
      title={t("从磁盘重新读取")}
      aria-label={t("从磁盘重新读取")}
      onClick={() => requestReload(path)}
    >
      <RefreshCw className="size-3.5" />
    </RowActionButton>
  )
  /**
   * 「预览 / 编辑源码」切换钮：挂在**标签条右侧动作区的最右端**（`保存` 之后）。
   *
   * 位置是刻意的。这一排里「行号 / 换行 / 保存」只在**编辑态**出现，动作区又是右对齐的
   * —— 所以整排里唯一「切换模式时不会动」的位置就是最右端。切换钮正是那颗「点它就换模式」
   * 的按钮，它自己绝不能跳；把它放中间的话，切一次预览/编辑，它就被旁边一进一出的三颗
   * 按钮推着横移几十像素，鼠标底下那颗换了人。
   *
   * （历史上它一度被塞进 Monaco 自己的工具栏，理由是「跟行号/换行同生共死」；代价是
   * **预览态下 Monaco 整块不挂、切换钮跟着消失** —— 切到预览就再也切不回来。标签条这条
   * 横条两种模式下都在，才是它该待的地方。）
   *
   * 尺寸按**这一排**的规格来（邻居是 `size-6` 的空态按钮 + `size-3.5` 图标）：外框
   * `p-0.5` + 边框，两颗 `size-6`，图标 `size-3.5`，于是图标与左右邻居同号、中心同高。
   */
  const viewModeToggle =
    activeTab && hasDualView(activeTab.kind) ? (
      <div className="flex shrink-0 items-center gap-0.5 rounded border border-border/70 p-0.5">
        <button
          type="button"
          title={t("预览")}
          aria-label={t("预览")}
          aria-pressed={activeTab.viewMode === 'preview'}
          onClick={() => patchTab(activeTab.path, { viewMode: 'preview' })}
          className={cn(
            'inline-flex size-6 items-center justify-center rounded transition-colors',
            activeTab.viewMode === 'preview'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'
          )}
        >
          <Eye className="size-3.5" />
        </button>
        <button
          type="button"
          title={t("编辑源码")}
          aria-label={t("编辑源码")}
          aria-pressed={activeTab.viewMode === 'edit'}
          onClick={() => patchTab(activeTab.path, { viewMode: 'edit' })}
          className={cn(
            'inline-flex size-6 items-center justify-center rounded transition-colors',
            activeTab.viewMode === 'edit'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'
          )}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    ) : null
  /**
   * 上传入口：**仅 web 宿主 + 工作区来源**。
   *
   * - desktop 不用它：工作区就在本机磁盘上，要搬文件直接拖资源管理器，绕一圈服务器反而多余；
   * - 容器工作台也不用：那边的文件在容器里，本地选的文件得先过容器桥（另一套通道，暂时没有）。
   *
   * 两道判据都要（与 `canReveal` 同一教训）：`upload` 只有工作区来源实现了，但平台这层
   * 得单独判 —— 否则 desktop 上也会冒出这个按钮。
   */
  const canUpload = !!fsSource?.upload && getAgentHostOrNull()?.platform === 'web'
  /** 右侧内容区要显示的报错：树加载失败优先，其次是当前标签自己的读写错误 */
  const panelError = loadError ?? activeTab?.error ?? null

  /** 命名弹窗的文案：新建（文件 / 文件夹）与重命名共用同一套 UI，这里按 mode 定标题 / 说明 / 占位 / 按钮 */
  const nameDialogText = ((): {
    title: string
    description: string
    placeholder: string
    confirm: string
    busy: string
  } | null => {
    if (nameDialog === null) return null
    if (nameDialog.mode === 'rename') {
      const base = nameDialog.path.split('/').pop() ?? nameDialog.path
      return {
        title: t('重命名'),
        description: t('把「{name}」改成新名字。', { name: base }),
        placeholder: t('输入新名字'),
        confirm: t('重命名'),
        busy: t('重命名中…')
      }
    }
    const kindLabel = nameDialog.kind === 'file' ? t('文件') : t('文件夹')
    return {
      title: t('新建{kind}', { kind: kindLabel }),
      description: t('在「{dir}」下新建一个{kind}。', { dir: nameDialog.dir || '/', kind: kindLabel }),
      placeholder: nameDialog.kind === 'file' ? t('输入文件名（如 index.ts）') : t('输入文件夹名'),
      confirm: t('创建'),
      busy: t('创建中…')
    }
  })()

  /**
   * 文件树**空白处**的右键菜单（桌面端）：根目录本身没有条目可右键，新建 / 上传 / 粘贴到根目录
   * 这些「不针对某一行」的动作就落在这里。作用范围恒为**根目录**（列表下方的留白不属于任何目录）。
   *
   * 定义位置必须在 `canUpload` 之后：它在这里是**当场求值**的（不是延迟调用的函数），
   * 放到上面会踩 `const` 的 TDZ —— 报「Cannot access 'canUpload' before initialization」。
   */
  const blankMenuActions = (): MenuAction[] => {
    const rootAbs = fsSource?.absolutePath?.('')?.replace(/[\\/]+$/, '') ?? ''
    return [
      ...(clipboard
        ? [
            {
              label: t('粘贴'),
              icon: <ClipboardPaste className="size-4" />,
              run: () => requestPaste('')
            }
          ]
        : []),
      {
        label: t('复制当前路径'),
        icon: <ClipboardCopy className="size-4" />,
        run: () =>
          rootAbs
            ? copyText(rootAbs, t('已复制路径：{path}', { path: rootAbs }))
            : copyText(rootLabel, t('已复制：{name}', { name: rootLabel }))
      },
      // 空白处 = 根目录：在系统文件管理器里打开这个工作区目录（仅 desktop，见 canOpenInFileManager）
      ...(canOpenInFileManager
        ? [
            {
              label: t('在文件管理器中打开'),
              icon: <FolderOpen className="size-4" />,
              run: () => void handleOpenInFileManager('')
            }
          ]
        : []),
      ...(fsSource?.createFile
        ? [
            {
              label: t('新建文件'),
              icon: <FilePlus2 className="size-4" />,
              run: () => handleNewEntry('file', '')
            }
          ]
        : []),
      ...(fsSource?.mkdir
        ? [
            {
              label: t('新建文件夹'),
              icon: <FolderPlus className="size-4" />,
              run: () => handleNewEntry('folder', '')
            }
          ]
        : []),
      ...(canUpload
        ? [
            {
              label: t('上传文件'),
              icon: <Upload className="size-4" />,
              run: () => openUploadPicker('')
            }
          ]
        : []),
      { label: t('刷新'), icon: <RefreshCw className="size-4" />, run: refresh }
    ]
  }

  /** 空白处右键菜单项（与条目菜单同一套 `ContextMenuItem` 渲染） */
  const blankMenuItems: ReactNode = (
    <>
      {blankMenuActions().map((a) => (
        <ContextMenuItem key={a.label} variant={a.danger ? 'destructive' : undefined} onClick={a.run}>
          {a.icon}
          <span>{a.label}</span>
        </ContextMenuItem>
      ))}
    </>
  )

  /**
   * 文件树列表本体。桌面端外面还套一层「空白处右键菜单」（见 `blankMenuItems`），手机端裸着
   * —— 手机上长按行已经有 Sheet，再给空白处挂一层 ContextMenu 会和它抢长按手势。
   */
  const treeList = (
    <div
      className="min-h-0 flex-1 overflow-auto"
      onKeyDown={handleTreeKeyDown}
      // 点树的空白处 = 取消选择：这样 Ctrl+V 会退回「当前目录 / 根目录」，而不是打向某一行
      onClick={(e) => {
        if (!isBlankAreaTarget(e.target, e.currentTarget)) return
        setSelection([])
        anchorPathRef.current = null
      }}
      // 右键：行上的菜单由行自己的 ContextMenu 负责（那里已经 preventDefault），这里只接空白处。
      // 命中行时同样 preventDefault —— Radix 的 Trigger 用 composeEventHandlers 合成，
      // 见到 defaultPrevented 就不开，于是不会一右击弹出两份菜单。
      onContextMenu={(e) => {
        if (!isBlankAreaTarget(e.target, e.currentTarget)) e.preventDefault()
      }}
    >
      {/* `min-h-full` + 末尾 `flex-1` 的留白：列表短时把剩余高度铺满，长时也至少留一截空白 ——
          那块空白正是右键「粘贴 / 复制当前路径 / 新建 / 上传 / 刷新」的落点 */}
      <div className="flex min-h-full flex-col">
        <div className="pb-2">
          {dirs['']?.entries ? (
            <>
              {dirs['']!.entries!.map((e) => renderEntry(e, 0))}
              {/* 根目录太大没列全：与子目录同一句提示（根目录没有「上一行」可挂） */}
              {dirs['']!.truncated && (
                <div className="py-1 pr-2 pl-2 text-xs text-amber-600/90 dark:text-amber-400/90">
                  {t("目录条目过多，未全部列出")}
                </div>
              )}
            </>
          ) : dirs['']?.loading ? (
            // 根目录首次加载保留「读取中…」提示（首次打开面板时树是空的，没有箭头可看）；
            // 子目录展开态由行首箭头表示，不做占位
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("读取中…")}
            </div>
          ) : null}
        </div>
        <div data-fs-blank="" aria-hidden className="min-h-16 flex-1" />
      </div>
    </div>
  )

  return (
    <SplitFrame
      split={split}
      containerRef={containerRef}
      onKeyDownCapture={handleKeyDown}
      onLayoutChanged={handlePaneLayoutChanged}
    >
      {/* 左：文件树。宽度可拖（存 localStorage，双击分隔线恢复默认）；没拖过时按容器宽度给。
          单栏形态（`singlePane`：容器窄于 `FILES_SINGLE_PANE_BELOW_WIDTH`）不给宽度：
          它自己整屏，点开文件后整块让给内容区。
          藏用的是 `hidden`（display:none）而不是卸载 —— 目录展开态、选中集、剪贴板都留在内存里，
          从文件退回来还是原来那棵树（`cn` 走 tailwind-merge，`hidden` 会顶掉 `flex`）。
          两栏形态下这些都不需要：宽度交给 Group 的布局，分隔线交给 `ResizableHandle`。 */}
      <PaneShell
        split={split}
        panel={{
          defaultSize: treePaneWidth,
          minSize: FILES_PANE_MIN_WIDTH,
          maxSize: paneMaxWidth,
          panelRef: treePanelRef,
          /* 窗口 / 侧栏变宽时文件树保持像素宽、编辑区吃剩下的（IDE 那一套） */
          groupResizeBehavior: 'preserve-pixel-size'
        }}
        className={
          split
            ? 'flex min-h-0 min-w-0 flex-col'
            : cn(
                'flex min-h-0 min-w-0 flex-col',
                singlePane ? 'flex-1' : 'shrink-0 border-r border-border/70',
                singlePane && filePaneShown && 'hidden'
              )
        }
        style={split ? { overflow: 'hidden' } : singlePane ? undefined : { width: treePaneWidth }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
          <Files className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={rootLabel}>
            {rootLabel}
          </span>
          {/* 桌面端头部只留两颗常驻开关：新建 / 上传 / 粘贴到根目录都收进了**文件树空白处的
              右键菜单**（见 `blankMenuActions`）—— 根目录没有条目可右键这件事，改由「列表下方
              那块留白」承担，头部不必再挤一排按钮。
              手机端没有右键，这几个入口仍留在头部。 */}
          {isMobile && (
            <MobileFilesHeaderActions
              canUpload={canUpload}
              uploading={uploading.length > 0}
              uploadTarget={currentPasteTarget()}
              clipboardLabel={
                clipboard
                  ? clipboard.entries.length > 1
                    ? t('{count} 项', { count: clipboard.entries.length })
                    : clipboard.entries[0].name
                  : null
              }
              onNewFile={() => handleNewEntry('file', '')}
              onNewFolder={() => handleNewEntry('folder', '')}
              onUpload={() => openUploadPicker(currentPasteTarget())}
              onPasteRoot={() => requestPaste('')}
            />
          )}
          {/* 「显示被忽略的文件」：工作区来源独有（见 canShowIgnored）。
              默认藏起来的是内置黑名单（node_modules / .git / dist / vendor / .env…）
              与工作区 .gitignore 命中的条目 —— Agent 的工具该看不见它们，但人要看得见 */}
          {canShowIgnored && (
            <IconTip
              label={
                showIgnored
                  ? t('隐藏被忽略的文件（.gitignore / 默认规则）')
                  : t('显示被忽略的文件（.gitignore / 默认规则）')
              }
            >
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  'size-6 shrink-0 p-0',
                  showIgnored ? 'text-primary' : 'text-muted-foreground'
                )}
                aria-label={t("显示被忽略的文件")}
                aria-pressed={showIgnored}
                onClick={() => setShowIgnored(!showIgnored)}
              >
                {showIgnored ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </Button>
            </IconTip>
          )}
          {/* 折叠所有 / 展开折叠前的树：一次收起全部分支，再点一次回到折叠前那个展开态。
              没展开任何子目录时置灰（点了也没反应）；折叠后高亮，形态一眼可辨 */}
          <IconTip label={collapsedFrom ? t('展开折叠前的目录') : t('折叠所有目录')}>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                'size-6 shrink-0 p-0',
                collapsedFrom ? 'text-primary' : 'text-muted-foreground'
              )}
              aria-label={collapsedFrom ? t('展开折叠前的目录') : t('折叠所有目录')}
              aria-pressed={collapsedFrom !== null}
              disabled={!collapsedFrom && !hasOpenDirs}
              onClick={collapsedFrom ? restoreCollapsedDirs : collapseAllDirs}
            >
              {collapsedFrom ? (
                <ChevronsUpDown className="size-3.5" />
              ) : (
                <ChevronsDownUp className="size-3.5" />
              )}
            </Button>
          </IconTip>
          <IconTip label={t("刷新文件树")}>
            <Button size="sm" variant="ghost" className="size-6 shrink-0 p-0 text-muted-foreground" aria-label={t("刷新文件树")} onClick={refresh}>
              <RefreshCw className="size-3.5" />
            </Button>
          </IconTip>
        </div>
        {/* 树的快捷键挂在列表这一层（不是整个面板）：右 Monaco 的文本编辑快捷键不能被吞掉。
            桌面端整块再套一层 ContextMenu：右击空白处弹「粘贴 / 复制当前路径 / 新建 / 上传 / 刷新」 */}
        {isMobile ? (
          treeList
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>{treeList}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">{blankMenuItems}</ContextMenuContent>
          </ContextMenu>
        )}
      </PaneShell>

      {/* 文件树 / 编辑区之间的拖拽条。双击 = 恢复按容器算的默认宽度。
          单栏形态没有「两栏之间」可言，整块不给：那时两个区域先后整屏，
          留一条拖不动的抓手只会让人以为能把树拉窄一点（`maxFilesPaneWidth` 在窄容器下
          可拖范围本来就被夹到很小，手感和没反应差不多）。
          `bg-border/70`：库默认是一条常驻实线，原来那条只在悬停 / 拖拽时加深，保持原样；
          `after:w-2` 把抓取热区从 4px 放到 8px（与改造前的 `ResizeHandle` 一致）。 */}
      {split && (
        <ResizableHandle
          /* 库自带的双击复位会回到 `defaultSize`（= 记忆的宽度），这里要的是「回到按容器算的默认宽」 */
          disableDoubleClick
          onDoubleClick={resetTreePaneWidth}
          className="bg-border/70 after:w-2 hover:bg-border data-[separator=active]:bg-border"
        />
      )}

      {/* 右：预览 / 编辑区（`min-w-0` + `flex-1`：桌面端挨着树；单栏形态下自己整屏） */}
      <PaneShell
        split={split}
        className={
          split
            ? 'flex min-h-0 min-w-0 flex-col'
            : cn('flex min-h-0 min-w-0 flex-1 flex-col', singlePane && !filePaneShown && 'hidden')
        }
        style={split ? { overflow: 'hidden' } : undefined}
      >
        {/* 标签条：每个打开的文件一颗标签，用的是**共享的 `PanelTab`**（与主区域 ViewPanel
            同一套：同一个高度 / 圆角 / hover 浮现的关闭 ×）。未保存的文件在图标角上叠一个黄点。
            tab 多了横向滚动，不换行、不挤压右侧（右侧是当前文件的刷新 / 定位 / 下载 / 视图切换 / 保存） */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 px-1">
          {/*
            单栏形态的「返回文件列表」：内容这一屏唯一的出口，别混在标签条右侧那堆
            跟当前文件有关的动作里 —— 它管的是「回到上一层」，放在最左边（读起来就是「← 文件」）。
            两栏形态两栏同时在，返回无处可去，不给。
          */}
          {singlePane && (
            <button
              type="button"
              aria-label={t("返回文件列表")}
              title={t("返回文件列表")}
              onClick={() => setPane('tree')}
              className="-ml-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <div
            ref={tabStripRef}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar"
          >
            {tabs.length === 0 ? (
              <span className="flex items-center px-2.5 text-sm text-muted-foreground">{t("未打开文件")}</span>
            ) : (
              tabs.map((t) => {
                const isActive = t.path === activeId
                const tabDirty = t.content !== t.savedContent
                const name = t.path.split('/').pop() ?? t.path
                return (
                  // 右键菜单裹住**这一个**标签：关闭 / 关闭其他 / 关闭左右两侧 / 关闭全部
                  // （手机端 Radix 的长按也能触出来，无需另做一套）
                  <ContextMenu key={t.path}>
                    <ContextMenuTrigger asChild>
                      {/*
                        标签本体是**共享的** `shared/components/PanelTab`（主区域 ViewPanel /
                        对话右侧 SidePanel 同一颗）：底色 / 圆角 / hover 浮现的关闭 × 全部收在那里，
                        文件标签才和别处肉眼上是同一套控件。

                        「从磁盘重新读取」挂在 × 的**左侧**（`actions` 槽位，与 × 同一层浮层、
                        同一套 hover 显隐）。每颗标签都有它、点哪颗刷新哪颗 —— 不是「只有激活
                        标签才给」：那样标签宽度会随「谁被激活」变，和 PanelTab 文件头里
                        「宽度稳定」那条是同一个道理。
                      */}
                      <PanelTab
                        ref={(el: HTMLDivElement | null) => {
                          if (el) tabElRefs.current.set(t.path, el)
                          else tabElRefs.current.delete(t.path)
                        }}
                        active={isActive}
                        label={name}
                        title={t.path}
                        actions={reloadAction(t.path)}
                        // 未保存时在文件图标右上角叠一个小黄点。图标包一层 span 是为了放点，
                        // 顺带在本地把 svg 压到 size-3.5（与 ViewPanel 图标同尺寸）
                        icon={
                          <span className="relative inline-flex [&>svg]:size-3.5">
                            <FileTypeIcon name={name} />
                            {tabDirty && (
                              <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-amber-500 ring-1 ring-background" />
                            )}
                          </span>
                        }
                        onActivate={() => setActiveId(t.path)}
                        onClose={() => requestCloseTab(t.path)}
                        // 鼠标中键关闭：和浏览器标签一致（挂在根节点上，PanelTab 把 rest 透到根 div）
                        onAuxClick={(e) => {
                          if (e.button === 1) requestCloseTab(t.path)
                        }}
                        // 高度（h-7）与图标尺寸已由 PanelTab 统一，这里只给主区域同款宽度上限
                        className="max-w-52 min-w-24 shrink-0"
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-44">{tabMenuItems(t.path)}</ContextMenuContent>
                  </ContextMenu>
                )
              })
            )}
          </div>
          {activeTab && (
            <div className="flex shrink-0 items-center gap-1.5 px-2">
              {/* 定位 / 下载：见上面 canReveal / canDownload 的取值说明。放在最左 ——
                   它俩是「把这个文件交给外面」（资源管理器 / 下载目录），与右边那组
                   「怎么显示这个文件」不是一类 */}
              {canReveal && (
                <IconTip label={t("在文件管理器中显示")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-6 shrink-0 p-0 text-muted-foreground"
                    aria-label={t("在文件管理器中显示")}
                    onClick={() => void handleReveal(activeTab.path)}
                  >
                    <FolderSearch className="size-3.5" />
                  </Button>
                </IconTip>
              )}
              {canDownload && (
                <IconTip label={t("下载")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-6 shrink-0 p-0 text-muted-foreground"
                    aria-label={t("下载")}
                    onClick={() => void handleDownload(activeTab.path, fileName ?? '')}
                  >
                    <Download className="size-3.5" />
                  </Button>
                </IconTip>
              )}
              {/* 行号 / 自动换行 / 保存：只在**源码态**出现（md / html / svg 预览态下 Monaco 根本没挂，
                   留着三个用不了的按钮只会让人以为功能坏了）。偏好落盘，切会话 / 换工作区都保留
                   （见 lib/editor-view-prefs） */}
              {editable && activeTab.viewMode === 'edit' && (
                <>
                  <IconTip label={lineNumbers ? t('隐藏行号') : t('显示行号')}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn('size-6 shrink-0 p-0', lineNumbers ? 'text-primary' : 'text-muted-foreground')}
                      aria-label={t("切换行号")}
                      aria-pressed={lineNumbers}
                      onClick={() => setLineNumbers(!lineNumbers)}
                    >
                      <Hash className="size-3.5" />
                    </Button>
                  </IconTip>
                  <IconTip label={wordWrap === 'on' ? t('关闭自动换行') : t('开启自动换行')}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn('size-6 shrink-0 p-0', wordWrap === 'on' ? 'text-primary' : 'text-muted-foreground')}
                      aria-label={t("切换自动换行")}
                      aria-pressed={wordWrap === 'on'}
                      onClick={() => setWordWrap(wordWrap === 'on' ? 'off' : 'on')}
                    >
                      <WrapText className="size-3.5" />
                    </Button>
                  </IconTip>
                </>
              )}
              {editable && activeTab.viewMode === 'edit' && (
                <IconTip label={t("保存（Ctrl+S）")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn('size-6 shrink-0 p-0', dirty ? 'text-primary' : 'text-muted-foreground')}
                    aria-label={t("保存")}
                    disabled={!dirty || activeTab.saving}
                    onClick={() => void save()}
                  >
                    {activeTab.saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  </Button>
                </IconTip>
              )}
              {/*
                预览 / 编辑源码切换：**这一排的最右端**（见上面 `viewModeToggle` 的说明）。
                它是这一排里唯一「两种模式下都在」的按钮 —— 于是切换时变的只是左边那三颗
                （行号 / 换行 / 保存）的显隐，它自己纹丝不动，鼠标脚下那颗不会换人。
              */}
              {viewModeToggle}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {panelError ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-md text-center text-sm text-foreground">
                <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
                {panelError}
              </div>
            </div>
          ) : activeTab && activeTab.kind === 'binary' ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="text-center text-sm text-foreground">
                <FileIcon className="mx-auto mb-2 size-8 opacity-30" />
                {t("该文件类型不支持预览")}
              </div>
            </div>
          ) : activeTab && activeTab.kind === 'markdown' && activeTab.viewMode === 'preview' ? (
            // md 预览：正文已在 read 阶段拿到（与源码同一份内容，无二次请求）
            activeTab.loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="h-full overflow-auto">
                <FileMarkdownPreview markdown={activeTab.content} />
              </div>
            )
          ) : activeTab && activeTab.kind === 'html' && activeTab.viewMode === 'preview' ? (
            // html 预览：沙箱 iframe + srcdoc。相对资源由预览组件自己取字节内联成
            // data: URL（srcdoc 的 base URL 是宿主的，见 FileHtmlPreview 文件头）
            activeTab.loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <FileHtmlPreview
                html={activeTab.content}
                source={fsSource ?? undefined}
                path={activeTab.path}
              />
            )
          ) : activeTab && showPreview ? (
            <div className="flex h-full items-center justify-center overflow-auto p-4">
              {activeTab.mediaLoading ? (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              ) : activeTab.kind === 'image' || activeTab.kind === 'svg' ? (
                activeTab.mediaUrl ? (
                  // 点击开全屏查看器（缩放 / 旋转 / 平移，工具条在底部；见 ImageViewer）
                  <img
                    src={activeTab.mediaUrl}
                    alt={fileName ?? 'preview'}
                    onClick={() => setImageZoomSrc(activeTab.mediaUrl ?? null)}
                    className="max-h-full max-w-full cursor-zoom-in object-contain"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t("预览加载失败")}</p>
                )
              ) : activeTab.kind === 'video' ? (
                activeTab.mediaUrl ? (
                  <video src={activeTab.mediaUrl} controls className="max-h-full max-w-full" style={{ maxWidth: '100%' }} />
                ) : (
                  <p className="text-sm text-muted-foreground">{t("预览加载失败")}</p>
                )
              ) : activeTab.mediaUrl ? (
                <audio src={activeTab.mediaUrl} controls className="w-96" />
              ) : (
                <p className="text-sm text-muted-foreground">{t("预览加载失败")}</p>
              )}
            </div>
          ) : activeTab ? (
            /*
              这个分支现在只负责「右侧这一块显示什么」：Markdown / HTML / SVG 走文件自带的
              预览组件，其余走 Monaco 编辑区。

              **两个控件都已经搬去上面那条标签条**（预览/编辑切换在最右端、刷新在每颗标签的
              × 左侧）—— 这里一条工具栏都不再挂。此前它们挂在 Monaco 的 `toolbar` / `actions`
              槽位里，问题在于**预览态下 Monaco 整块不挂**：切换钮只能靠一条补出来的窄条勉强
              留住，刷新则彻底消失。而「Agent 刚改完盘上的文件、我想把新内容拉回来」恰恰在
              预览 markdown 时最需要 —— 现在它就在标签上，两种模式下都在。
            */
            <MonacoEditor
              value={activeTab.loading ? '' : activeTab.content}
              onChange={(v) => patchTab(activeTab.path, { content: v })}
              language={monacoLanguageOf(fileName)}
              showLanguageSelector
              showCopyButton
              showHeader={activeTab.viewMode === 'edit'}
              wordWrap={wordWrap}
              lineNumbers={lineNumbers}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="text-center text-sm text-foreground">
                <Files className="mx-auto mb-2 size-8 opacity-30" />
                {t("从左侧选择一个文件查看或编辑")}
              </div>
            </div>
          )}
        </div>
      </PaneShell>

      {/* 手机菜单（Sheet 从底部弹出） */}
      <Sheet
        open={mobileMenuEntry !== null}
        onOpenChange={(open) => {
          if (!open) setMobileMenuEntry(null)
        }}
      >
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle className="text-left">
              {mobileMenuEntry?.name}
              <span className="ml-2 text-xs text-muted-foreground">
                {mobileMenuEntry?.type === 'dir' ? t('文件夹') : t('文件')}
              </span>
            </SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 pb-2">
            {mobileMenuEntry &&
              menuActionsOf(mobileMenuEntry).map((a) => (
                <button
                  key={a.label}
                  type="button"
                  disabled={a.disabled}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent',
                    'disabled:pointer-events-none disabled:opacity-50',
                    a.danger && 'text-destructive hover:bg-destructive/10'
                  )}
                  onClick={a.run}
                >
                  {a.icon}
                  {a.label}
                </button>
              ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* 上传：隐藏的本机选文件 input（仅 web 工作区渲染）。常挂在树上、靠 ref 触发 ——
          用「每次点按钮新建一个 input」的写法会在 Safari 上掉权限（用户手势与 click 之间
          隔了 render）。目标目录先写进 `uploadTarget`，再由 onChange 收文件。 */}
      {canUpload && (
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            const dir = uploadTarget ?? ''
            setUploadTarget(null)
            e.target.value = ''
            if (picked.length > 0) void runUpload(dir, picked)
          }}
        />
      )}

      {/* 同名冲突确认：绝不静默覆盖 —— 列清楚哪些文件会被盖掉，用户点头才带 overwrite 重传 */}
      <Dialog
        open={uploadConflict !== null}
        onOpenChange={(open) => {
          if (!open) setUploadConflict(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("覆盖同名文件？")}</DialogTitle>
            <DialogDescription>
              {uploadConflict
                ? t("{files} 在 {dir} 下已经存在，继续会覆盖它们原来的内容（不可恢复）。", {
                    files: uploadConflict.files.map((f) => `「${f.name}」`).join(t("、")),
                    dir: uploadConflict.dir ? `「${uploadConflict.dir}」` : t("根目录"),
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setUploadConflict(null)}>
              {t("取消")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={uploading.length > 0}
              onClick={() => {
                const pending = uploadConflict
                if (!pending) return
                setUploadConflict(null)
                void runUpload(pending.dir, pending.files, true)
              }}
            >
              {t("覆盖并上传")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗（多选时列出前几个名字） */}
      <Dialog
        open={deletingEntries.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeletingEntries([])
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deletingEntries.length > 1
                ? t("删除这 {count} 项？", { count: deletingEntries.length })
                : t("删除{kind}？", { kind: deletingEntries[0]?.type === 'dir' ? t('文件夹') : t('文件') })}
            </DialogTitle>
            <DialogDescription>
              {deletingEntries.length > 1
                ? t("{names}{more}（含文件夹里的全部子内容）将被永久删除，无法恢复。", {
                    names: deletingEntries.slice(0, 5).map((e) => `「${e.name}」`).join(t("、")),
                    more: deletingEntries.length > 5 ? t(" 等 {count} 项", { count: deletingEntries.length }) : "",
                  })
                : t("「{name}」{suffix}将被永久删除，无法恢复。", {
                    name: deletingEntries[0]?.name ?? "",
                    suffix: deletingEntries[0]?.type === 'dir' ? t('及其全部子内容') : '',
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeletingEntries([])}>
              {t("取消")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void confirmDelete()}>
              {t("删除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 粘贴确认弹窗：粘贴会往工作区写（复制）或搬走（剪切）东西，先问一句 */}
      <Dialog
        open={pastingDir !== null}
        onOpenChange={(open) => {
          if (!open) setPastingDir(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{clipboard?.mode === 'cut' ? t('移动到这里？') : t('粘贴到这里？')}</DialogTitle>
            <DialogDescription>
              {clipboard
                ? t("把 {items}{action}「{dir}」。{note}", {
                    items: clipboard.entries.length > 1
                      ? t("{count} 项（{names}{more}）", {
                          count: clipboard.entries.length,
                          names: clipboard.entries.slice(0, 3).map((e) => `「${e.name}」`).join(t("、")),
                          more: clipboard.entries.length > 3 ? t(" 等") : "",
                        })
                      : `「${clipboard.entries[0].name}」`,
                    action: clipboard.mode === 'cut' ? t('移动到') : t('复制到'),
                    dir: pastingDir || '/',
                    note: clipboard.mode === 'cut' &&
                      clipboard.entries.every((e) => pastingDir === parentDirOf(e.path))
                      ? t('（它们已经在这个目录里了）')
                      : '',
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPastingDir(null)}>
              {t("取消")}
            </Button>
            <Button size="sm" onClick={() => void confirmPaste()}>
              {clipboard?.mode === 'cut' ? t('移动') : t('粘贴')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 命名弹窗：「新建文件 / 文件夹」与「重命名」共用一套 UI，按 nameDialog.mode / kind 区分 */}
      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialog(null)
            setNameInput('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{nameDialogText?.title}</DialogTitle>
            <DialogDescription>{nameDialogText?.description}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={nameDialogText?.placeholder}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmName()
              }}
            />
          </div>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setNameDialog(null)
                setNameInput('')
              }}
            >
              {t("取消")}
            </Button>
            <Button size="sm" onClick={() => void confirmName()} disabled={nameBusy || !nameInput.trim()}>
              {nameBusy ? nameDialogText?.busy : nameDialogText?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 刷新脏标签确认：拉磁盘上的最新内容会覆盖本地未保存的改动 */}
      <Dialog
        open={pendingReload !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReload(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("刷新未保存的文件？")}</DialogTitle>
            <DialogDescription>
              {t("「{name}」有未保存的改动，刷新会用磁盘上的最新内容覆盖它们。", {
                name: pendingReload?.split('/').pop() ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPendingReload(null)}>
              {t("取消")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                const path = pendingReload
                setPendingReload(null)
                if (path) void reloadTab(path)
              }}
            >
              {t("丢弃并刷新")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 图片全屏查看器（portal 到 body，放这儿只为挂在组件树里） */}
      <ImageViewer
        src={imageZoomSrc ?? ''}
        alt={fileName ?? 'preview'}
        open={imageZoomSrc !== null}
        onOpenChange={(open) => {
          if (!open) setImageZoomSrc(null)
        }}
      />
    </SplitFrame>
  )
}