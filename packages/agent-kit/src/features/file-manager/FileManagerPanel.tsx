/**
 * 文件管理器面板（主区域单例标签 `files:list`）：照搬 linux_web 那一套桌面文件管理器。
 *
 * ## 能力对照（linux_web → 这里）
 *
 * | 能力 | 说明 |
 * | --- | --- |
 * | 前进 / 后退 / 上级 / 主目录 / 盘符 | 历史栈在 `useFileManager` 里；面包屑可点 |
 * | 网格 / 列表两种视图 | 视图与「显示隐藏文件」记在 localStorage |
 * | 多选 | 单击、Ctrl/⌘ 切换、Shift 连选、**空白处拖框选**、Ctrl+A 全选 |
 * | 剪切 / 复制 / 粘贴 | 剪贴板在内存里（不碰系统剪贴板：跨进程的文件剪贴板做不干净） |
 * | 拖拽移动 / 复制 | 拖到文件夹或面包屑上 = 移动；按住 Ctrl / Alt = 复制；不能拖进自己 |
 * | 右键菜单 | 条目 → 条目动作（多选时是批量），空白处 → 新建 / 粘贴 / 刷新 / 全选 |
 * | 新建文件 / 文件夹 / 重命名 / 批量重命名 | 批量重命名 -> `名字 (1).ext`、`名字 (2).ext`… |
 * | 删除 → 回收站 / 彻底删除 / 还原 / 清空 | 回收站是**自己的**（数据目录下），不用系统回收站 |
 * | 上传（文件 / 文件夹，拖拽） | JSON + base64（desktop 的 IPC 桥只认字符串，见 AGENTS.md） |
 * | 下载（文件 / 目录） | 目录由服务端现场打 zip |
 * | 压缩（zip）/ 解压（zip / tar / tar.gz / gz） | 解压挡 zip-slip；xz / bz2 / 7z / rar 不支持 |
 * | 预览 | 图片 / 视频 / 音频 / PDF / 压缩包目录 / 文本（可就地编辑） |
 * | Office 预览 | **不做**（要 LibreOffice 转码），给下载与「本机应用打开」两条路 |
 *
 * ## 这一层只管「画」
 *
 * 状态与动作全在 `use-file-manager.ts`；弹窗在 `FileDialogs.tsx` / `FilePreviewDialog.tsx`。
 * 这么切是因为面板本身已经有「工具栏 + 两种视图 + 框选 + 键盘 + 右键菜单」，再塞业务逻辑
 * 就没人读得动了。
 *
 * ## 两条踩过的坑（别改回去）
 *
 * 1. **右键菜单只能有一个 Radix 根**：`ContextMenuTrigger` 用
 *    `composeEventHandlers(props.onContextMenu, 打开菜单)`，默认 `checkForDefaultPrevented`
 *    为 true —— 子元素先 `preventDefault()` 的话，冒泡到 trigger 时「打开菜单」整段被跳过，
 *    菜单一次都不弹。所以条目的 `onContextMenu` 里**不许** preventDefault，
 *    抑制原生菜单交给 Radix。
 * 2. **上传的拖拽与「拖动条目移动」是两套判定**：前者认 `dataTransfer.types` 里的 `Files`，
 *    后者认自造的 `application/x-fizz-fm-paths`。`dragover` 两个分支必须互斥，
 *    否则从列表里拖一个文件到目录上会被当成「从系统拖了个文件进来」去上传。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FilePlus2,
  FolderDown,
  FolderInput,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  LayoutGrid,
  List,
  ListOrdered,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import type { FmEntry, FmTrashItem } from '@fizz/contracts/agent-api'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  CompressDialog,
  ConfirmDialog,
  ExtractDialog,
  NameDialog,
  PropertiesDialog
} from '@fizz/agent-kit/features/file-manager/FileDialogs'
import { FilePreviewDialog } from '@fizz/agent-kit/features/file-manager/FilePreviewDialog'
import {
  formatSize,
  formatTime,
  iconOf,
  kindOf,
  type FileKind
} from '@fizz/agent-kit/features/file-manager/file-kind'
import { isInsideDir } from '@fizz/agent-kit/features/file-manager/fm-paths'
import { useFileManager } from '@fizz/agent-kit/features/file-manager/use-file-manager'

/**
 * 图片缩略图的 URL 缓存（`路径 → objectURL`）。
 *
 * 为什么不在组件里各自 `useEffect` 拉一次：翻目录时同一张图会被挂载 / 卸载很多次
 * （切视图、改选中、静默刷新），每次都重新走一遍「带鉴权 fetch + 造 objectURL」
 * 既慢又漏内存。这里按路径缓存，cap 100，超了从最老的开始 revoke。
 */
const thumbCache = new Map<string, string>()
const THUMB_CACHE_MAX = 100

/** 超过这个大小的图片不做缩略图（拉全图只为画 40px 太亏） */
const THUMB_MAX_BYTES = 8 * 1024 * 1024

/**
 * 内部拖动用的自定义 MIME。
 *
 * 为什么要一个自造的类型：`dragover` 里必须能区分「从系统拖文件进来（上传）」和
 * 「拖着自己列表里的条目移动」—— 前者 `types` 里有 `Files`，后者没有。只靠
 * `text/plain` 分辨不出来（从浏览器外部拖一段文字进来也有它）。
 */
const FM_DRAG_MIME = 'application/x-fizz-fm-paths'

function cacheThumb(path: string, url: string): void {
  thumbCache.set(path, url)
  if (thumbCache.size <= THUMB_CACHE_MAX) return
  const oldest = thumbCache.keys().next().value
  if (oldest) {
    const old = thumbCache.get(oldest)
    if (old) URL.revokeObjectURL(old)
    thumbCache.delete(oldest)
  }
}

/**
 * 取一张图片的缩略图 URL（命中缓存就直接用）。
 *
 * 只在网格视图、且是**图片**且体积不大时才拉：目录里几百张图同时拉全图会把内网带宽
 * 与渲染进程内存一起打满。**缓存条目自己不能 revoke** —— revoke 了下次进来的同一张
 * 图会变成裂图；淘汰交给 `cacheThumb` 统一做。
 */
function useThumb(path: string, enabled: boolean): string | null {
  const { app } = useAppContext()
  const apiRef = useRef(app.api)
  apiRef.current = app.api

  const [url, setUrl] = useState<string | null>(() => thumbCache.get(path) ?? null)

  useEffect(() => {
    setUrl(thumbCache.get(path) ?? null)
    if (!enabled) return
    // 还没连上服务端：不退化成错误提示（缩略图不是用户主动要的），等下次进目录再说
    const api = apiRef.current
    if (!api) return
    let cancelled = false
    void api.files
      .mediaUrl(path)
      .then((next) => {
        if (cancelled) return
        cacheThumb(path, next)
        setUrl(next)
      })
      .catch(() => {
        /* 缩略图失败就退回类型图标，不要弹错 —— 用户没主动要求看它 */
      })
    return () => {
      cancelled = true
    }
  }, [path, enabled])

  return url
}

/** 图标按钮（工具栏用）：`title` 兼作无障碍标签，省一层 Tooltip */
function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  danger
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  /** 破坏性动作（删除 / 彻底删除）：悬停转红，一排灰图标里唯一该让人停一下的那个 */
  danger?: boolean
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'size-7 shrink-0 p-0',
        active && 'text-primary',
        danger && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
      )}
      // `label` 在纯图标按钮上不是装饰：没有文字就只剩 title / aria-label 两条可读线索
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  )
}

/**
 * 操作栏里的分组细线。
 *
 * 一排十几个纯灰图标，不给分隔就成了一串找不着边的点：`复制 / 剪切 / 粘贴` 是剪贴板，
 * `重命名 / 删除 / 属性` 是单条信息，`压缩 / 解压` 是打包 —— 用一条 1px 竖线切开，
 * 扫视成本立刻降下来。
 */
function ActionDivider(): React.JSX.Element {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
}

/** 网格视图里的一块磁贴（图片走缩略图，其余走类型图标） */
function GridTile({
  id,
  name,
  kind,
  size,
  selected,
  dropActive,
  dragging,
  onOpen,
  onSelect
}: {
  /** 条目 id（绝对路径 / 回收站 id）—— 框选靠它把矩形命中的元素映射回选中集 */
  id: string
  name: string
  kind: FileKind
  size: number
  selected: boolean
  /** 正被拖拽的东西悬停在它上面（只有目录会有这个状态） */
  dropActive?: boolean
  /** 这个条目自己正在被拖 */
  dragging?: boolean
  onOpen: () => void
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
}): React.JSX.Element {
  const { Icon, className } = iconOf(kind, kind === 'dir')
  const thumb = useThumb(id, kind === 'image' && size > 0 && size < THUMB_MAX_BYTES)
  return (
    <button
      type="button"
      data-fm-id=""
      data-fm-path={id}
      className={cn(
        'group flex w-full min-w-0 flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center outline-none',
        selected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-secondary/70',
        // 拖到自己身上：淡一点，明确「这个不能当落点」
        dragging && 'opacity-50',
        // 落点高亮要压过选中态的 ring，所以放后面
        dropActive && 'bg-primary/20 ring-2 ring-primary'
      )}
      onClick={(e) => onSelect(e)}
      onDoubleClick={onOpen}
      title={name}
    >
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="size-10 shrink-0 rounded object-cover"
          // 缩略图还没回来 / 失败时留白，不要抖动出两个图标
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <Icon className={cn('size-10 shrink-0', className)} strokeWidth={1.5} />
      )}
      <span className="line-clamp-2 w-full text-xs leading-snug break-all">{name}</span>
    </button>
  )
}

/** 列表视图的一行 */
function ListRow({
  id,
  name,
  kind,
  size,
  mtime,
  selected,
  dropActive,
  dragging,
  onOpen,
  onSelect,
  onCheck
}: {
  id: string
  name: string
  kind: FileKind
  size: number
  mtime: number
  selected: boolean
  /** 正被拖拽的东西悬停在它上面（只有目录会有这个状态） */
  dropActive?: boolean
  /** 这个条目自己正在被拖 */
  dragging?: boolean
  onOpen: () => void
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onCheck: () => void
}): React.JSX.Element {
  const { Icon, className } = iconOf(kind, kind === 'dir')
  return (
    <div
      data-fm-id=""
      data-fm-path={id}
      className={cn(
        'group flex cursor-pointer items-center gap-3 px-3 py-1.5',
        selected ? 'bg-primary/10' : 'hover:bg-secondary/60',
        dragging && 'opacity-50',
        dropActive && 'bg-primary/20 ring-1 ring-inset ring-primary'
      )}
      onClick={(e) => onSelect(e)}
      onDoubleClick={onOpen}
    >
      <Checkbox
        className="shrink-0"
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={onCheck}
      />
      <Icon className={cn('size-4 shrink-0', className)} />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {kind === 'dir' ? '-' : formatSize(size)}
      </span>
      <span className="hidden w-32 shrink-0 text-xs text-muted-foreground sm:block">
        {formatTime(mtime)}
      </span>
    </div>
  )
}

/**
 * 一个条目的右键菜单项（网格 / 列表共用）。
 *
 * 菜单项按「这是什么」裁剪：目录不给「解压」，非压缩包不给「解压」。
 *
 * ⚠️ 这里**不返回 `<ContextMenu>`**：整个内容区只有**一个** Radix 菜单根
 * （见内容区那段注释），这个组件只贡献菜单项。理由不是审美 —— Radix 的
 * `ContextMenuTrigger` 里 `composeEventHandlers(props.onContextMenu, 打开菜单)` 默认
 * `checkForDefaultPrevented: true`，**子元素只要先 preventDefault，冒泡到 trigger 时
 * 「打开菜单」这段就被跳过**，菜单一次都不会弹（之前每块磁贴自带 trigger + 自己的
 * `onContextMenu` 里 preventDefault，就是这个症状）。
 */
function ItemMenuItems({
  entry,
  targets,
  onPreview,
  onRename,
  onCopy,
  onCut,
  onPaste,
  onDownload,
  onCompress,
  onExtract,
  onTrash,
  onDeleteForever,
  onProperties
}: {
  entry: FmEntry
  /** 这一项动作要作用的路径（右键的那个一定包含；多选时是整批） */
  targets: string[]
  onPreview: () => void
  onRename: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onDownload: () => void
  onCompress: () => void
  onExtract: () => void
  onTrash: () => void
  onDeleteForever: () => void
  onProperties: () => void
}): React.JSX.Element {
  const isArchive = !entry.isDir && kindOf(entry.name, false) === 'archive'
  const many = targets.length > 1
  return (
    <>
      <ContextMenuItem onSelect={onPreview}>{entry.isDir ? '打开' : '预览'}</ContextMenuItem>
      <ContextMenuSeparator />
      {/* 重命名是单条动作：多选时不给（批量重命名在操作栏 / 选中后右键仍是这一项） */}
      <ContextMenuItem onSelect={onRename} disabled={many}>
        <Pencil className="size-3.5" />
        重命名
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopy}>
        <Copy className="size-3.5" />
        {many ? `复制 ${targets.length} 项` : '复制'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCut}>
        <Scissors className="size-3.5" />
        {many ? `剪切 ${targets.length} 项` : '剪切'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onPaste}>
        <ClipboardPaste className="size-3.5" />
        粘贴到当前目录
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onDownload}>
        <Download className="size-3.5" />
        {many ? `下载 ${targets.length} 项` : '下载'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCompress}>
        <FileArchive className="size-3.5" />
        {many ? `压缩 ${targets.length} 项为 zip` : '压缩为 zip'}
      </ContextMenuItem>
      {isArchive ? (
        <ContextMenuItem onSelect={onExtract}>
          <FolderInput className="size-3.5" />
          解压到…
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onProperties} disabled={many}>
        <Info className="size-3.5" />
        属性
      </ContextMenuItem>
      <ContextMenuItem onSelect={onTrash} className="text-destructive">
        <Trash2 className="size-3.5" />
        {many ? `把 ${targets.length} 项移到回收站` : '移到回收站'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onDeleteForever} className="text-destructive">
        <Trash2 className="size-3.5" />
        {many ? `彻底删除 ${targets.length} 项…` : '彻底删除…'}
      </ContextMenuItem>
    </>
  )
}

/**
 * 空白处的右键菜单（没有点到任何条目）。
 *
 * 与条目的菜单共用同一个 Radix 根 —— 所以这里也只返回菜单项。空白处的动作都是
 * 「对**当前目录**做什么」：新建、粘贴、刷新、全选。
 */
function BlankMenuItems({
  path,
  showHidden,
  hasClipboard,
  clipboardCount,
  inTrash,
  trashCount,
  onNewFile,
  onNewDir,
  onPaste,
  onRefresh,
  onSelectAll,
  onToggleHidden,
  onEmptyTrash
}: {
  path: string
  showHidden: boolean
  hasClipboard: boolean
  clipboardCount: number
  inTrash: boolean
  trashCount: number
  onNewFile: () => void
  onNewDir: () => void
  onPaste: () => void
  onRefresh: () => void
  onSelectAll: () => void
  onToggleHidden: () => void
  onEmptyTrash: () => void
}): React.JSX.Element {
  if (inTrash) {
    return (
      <>
        <ContextMenuItem onSelect={onRefresh}>
          <RefreshCw className="size-3.5" />
          刷新
        </ContextMenuItem>
        <ContextMenuItem onSelect={onSelectAll} disabled={!trashCount}>
          全选
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onEmptyTrash} disabled={!trashCount} className="text-destructive">
          <Trash2 className="size-3.5" />
          清空回收站
        </ContextMenuItem>
      </>
    )
  }
  return (
    <>
      <ContextMenuItem onSelect={onNewDir}>
        <FolderPlus className="size-3.5" />
        新建文件夹
      </ContextMenuItem>
      <ContextMenuItem onSelect={onNewFile}>
        <FilePlus2 className="size-3.5" />
        新建文件
      </ContextMenuItem>
      <ContextMenuItem onSelect={onPaste} disabled={!hasClipboard}>
        <ClipboardPaste className="size-3.5" />
        {clipboardCount ? `粘贴 ${clipboardCount} 项` : '粘贴'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRefresh}>
        <RefreshCw className="size-3.5" />
        刷新
      </ContextMenuItem>
      <ContextMenuItem onSelect={onSelectAll}>全选</ContextMenuItem>
      <ContextMenuItem onSelect={onToggleHidden}>
        {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        {showHidden ? '不显示隐藏文件' : '显示隐藏文件'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* 只是让用户确认「现在这个目录是哪」，不可点；长路径要能截断，别把菜单撑爆 */}
      <ContextMenuItem disabled className="font-mono text-[10px] text-muted-foreground">
        <span className="max-w-52 truncate" title={path}>
          {path}
        </span>
      </ContextMenuItem>
    </>
  )
}

/** 回收站条目 / 回收站空白处的共用动作（还原、彻底删除） */
function TrashMenuItems({
  count,
  onRestore,
  onDelete
}: {
  count: number
  onRestore: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <>
      <ContextMenuItem onSelect={onRestore}>
        <RotateCcw className="size-3.5" />
        {count > 1 ? `还原 ${count} 项` : '还原'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onDelete} className="text-destructive">
        <Trash2 className="size-3.5" />
        {count > 1 ? `彻底删除 ${count} 项…` : '彻底删除…'}
      </ContextMenuItem>
    </>
  )
}


export function FileManagerPanel(): React.JSX.Element {
  const fm = useFileManager()
  const { app } = useAppContext()
  const apiRef = useRef(app.api)
  apiRef.current = app.api

  /** 取文件管理接口（未连接服务端时抛一句人能读懂的话） */
  const files = () => {
    const api = apiRef.current
    if (!api) throw new Error('还没连上服务端，稍后再试')
    return api.files
  }

  // ---------------- 弹窗状态 ----------------
  const [nameDialog, setNameDialog] = useState<
    null | { kind: 'new-file' | 'new-dir' | 'rename' | 'batch-rename'; entry?: FmEntry }
  >(null)
  const [confirm, setConfirm] = useState<
    null | { kind: 'delete' | 'delete-forever' | 'empty-trash' | 'delete-trash'; paths?: string[]; ids?: string[] }
  >(null)
  const [compressOpen, setCompressOpen] = useState(false)
  const [extractEntry, setExtractEntry] = useState<FmEntry | null>(null)
  const [propsEntry, setPropsEntry] = useState<FmEntry | null>(null)
  const [previewEntry, setPreviewEntry] = useState<FmEntry | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dirInputRef = useRef<HTMLInputElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  // ---------------- 选中派生 ----------------
  const selectedEntries = useMemo(
    () => fm.entries.filter((e) => fm.selected.has(e.path)),
    [fm.entries, fm.selected]
  )
  const singleEntry = selectedEntries.length === 1 ? selectedEntries[0] : null
  const selectedTrash = useMemo(
    () => fm.trashItems.filter((t) => fm.selected.has(t.id)),
    [fm.trashItems, fm.selected]
  )
  const inTrash = fm.mode === 'trash'
  const selectionCount = inTrash ? selectedTrash.length : selectedEntries.length

  const openEntry = useCallback(
    (entry: FmEntry) => {
      if (entry.isDir) void fm.navigateTo(entry.path)
      else setPreviewEntry(entry)
    },
    [fm]
  )

  /** 右键那一项真正要作用的路径：它在选中集里就是整批，否则只有它自己 */
  const targetsFor = useCallback(
    (entry: FmEntry): string[] =>
      fm.selected.has(entry.path) ? selectedEntries.map((x) => x.path) : [entry.path],
    [fm.selected, selectedEntries]
  )

  /** 路径 → 条目（下载 / 压缩这些按 `FmEntry[]` 收口的动作要用） */
  const entriesOf = useCallback(
    (paths: string[]): FmEntry[] =>
      paths
        .map((p) => fm.entries.find((e) => e.path === p))
        .filter((e): e is FmEntry => e !== undefined),
    [fm.entries]
  )

  // ---------------- 右键菜单（整块内容区共用一个菜单根，见内容区的注释） ----------------
  const [menuTarget, setMenuTarget] = useState<
    null | { kind: 'entry'; entry: FmEntry } | { kind: 'trash'; item: FmTrashItem } | { kind: 'blank' }
  >(null)

  /**
   * 内容区的 contextmenu：先认领「右键的是谁」，再交给 Radix 打开菜单。
   *
   * ⚠️ **不要在这里 `preventDefault()`**：`ContextMenuTrigger` 的处理器是
   * `composeEventHandlers(props.onContextMenu, 打开菜单)`，默认 `checkForDefaultPrevented`
   * 为 true —— 我们一 preventDefault，它那段「打开」直接不执行，菜单永远不出来。
   * 原生菜单的抑制由 Radix 自己做完。
   */
  const onContentContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-fm-id]')
    const tid = el?.dataset.fmTid
    const path = el?.dataset.fmPath
    if (tid) {
      const item = fm.trashItems.find((t) => t.id === tid)
      if (item) {
        // 右键未选中的条目：先选中它（与资源管理器一致），已选中就保留整批
        if (!fm.selected.has(item.id)) fm.setSelected(new Set([item.id]))
        setMenuTarget({ kind: 'trash', item })
        return
      }
    }
    if (path) {
      const entry = fm.entries.find((x) => x.path === path)
      if (entry) {
        if (!fm.selected.has(entry.path)) fm.setSelected(new Set([entry.path]))
        setMenuTarget({ kind: 'entry', entry })
        return
      }
    }
    setMenuTarget({ kind: 'blank' })
  }

  // ---------------- 内部拖拽：拖到文件夹上 = 移动（Ctrl / Alt = 复制） ----------------
  /** 正在拖的路径（ref：dragover 里要立刻读到，state 会晚一帧） */
  const dragPathsRef = useRef<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [dropPath, setDropPath] = useState<string | null>(null)

  const resetDrag = useCallback(() => {
    dragPathsRef.current = []
    setDragging(false)
    setDropPath(null)
  }, [])

  /** 拖起一个条目：拖的若是选中集里的一项，就整批拖走 */
  const onItemDragStart = (entry: FmEntry, e: React.DragEvent): void => {
    if (inTrash) {
      e.preventDefault()
      return
    }
    const paths = fm.selected.has(entry.path) ? selectedEntries.map((x) => x.path) : [entry.path]
    if (!fm.selected.has(entry.path)) fm.setSelected(new Set([entry.path]))
    dragPathsRef.current = paths
    e.dataTransfer.effectAllowed = 'copyMove'
    // Firefox 必须 setData 才会真的开始拖；自定义类型是「这是内部拖动」的标记
    e.dataTransfer.setData(FM_DRAG_MIME, JSON.stringify(paths))
    e.dataTransfer.setData('text/plain', paths.join('\n'))
    setDragging(true)
  }

  /** 能不能把正拖着的东西放进 `dir`（不能放进自己，也不能放进自己的子目录） */
  const canDropInto = (dir: string): boolean => {
    const paths = dragPathsRef.current
    if (!paths.length || !dir) return false
    return !paths.some((p) => isInsideDir(p, dir))
  }

  const onDirDragOver = (dir: string, e: React.DragEvent): void => {
    if (!canDropInto(dir)) return
    // 必须 stopPropagation：否则容器的上传分支也会看到这个事件（虽然它按 Files 过滤了，
    // 但两处都 preventDefault 会让 dropEffect 互相覆盖）
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move'
    if (dropPath !== dir) setDropPath(dir)
  }

  const onDirDrop = (dir: string, e: React.DragEvent): void => {
    if (!canDropInto(dir)) return
    e.preventDefault()
    e.stopPropagation()
    const paths = dragPathsRef.current
    const copy = e.ctrlKey || e.altKey
    resetDrag()
    void fm.transfer(paths, dir, copy ? 'copy' : 'move')
  }

  /**
   * 目录条目专用的落点 props（非目录不给）。
   *
   * 写成函数是为了网格 / 列表两处共用同一套判断 —— `dragOver` 在没有内部拖动时**必须
   * 什么都不做**，否则会把「拖文件进来上传」的落点抢走（那条走容器的 Files 分支）。
   */
  const folderDropProps = (entry: FmEntry) =>
    entry.isDir
      ? {
          onDragOver: (e: React.DragEvent) => onDirDragOver(entry.path, e),
          onDragLeave: () => setDropPath((prev) => (prev === entry.path ? null : prev)),
          onDrop: (e: React.DragEvent) => onDirDrop(entry.path, e)
        }
      : {}

  // ---------------- 框选 ----------------
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)

  const onContentPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // 点在条目 / 滚动条 / 按钮上都不算框选起点
    if ((e.target as HTMLElement).closest('[data-fm-id],button,input,[role="checkbox"]')) return
    const keep = e.ctrlKey || e.metaKey
    if (!keep) fm.clearSelection()
    marqueeStartRef.current = { x: e.clientX, y: e.clientY }
    setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY })
  }

  const onContentPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = marqueeStartRef.current
    if (!start) return
    setMarquee({ x1: start.x, y1: start.y, x2: e.clientX, y2: e.clientY })
    const container = containerRef.current
    if (!container) return
    const left = Math.min(start.x, e.clientX)
    const right = Math.max(start.x, e.clientX)
    const top = Math.min(start.y, e.clientY)
    const bottom = Math.max(start.y, e.clientY)
    const hits = new Set<string>()
    for (const el of container.querySelectorAll<HTMLElement>('[data-fm-id]')) {
      const rect = el.getBoundingClientRect()
      if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue
      // `data-fm-id` 只是「这是可选中条目」的标记；真正的 id 在 path / tid 上
      const key = el.dataset.fmPath ?? el.dataset.fmTid
      if (key) hits.add(key)
    }
    fm.setSelected(hits)
  }

  const endMarquee = (): void => {
    marqueeStartRef.current = null
    setMarquee(null)
  }

  // ---------------- 键盘 ----------------
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      fm.selectAll()
      return
    }
    if (mod && e.key.toLowerCase() === 'c' && selectionCount) {
      e.preventDefault()
      fm.copySelection(selectedEntries.map((x) => x.path))
      return
    }
    if (mod && e.key.toLowerCase() === 'x' && selectionCount) {
      e.preventDefault()
      fm.cutSelection(selectedEntries.map((x) => x.path))
      return
    }
    if (mod && e.key.toLowerCase() === 'v' && fm.clipboard) {
      e.preventDefault()
      void fm.paste()
      return
    }
    if (e.key === 'Delete' && selectionCount) {
      e.preventDefault()
      if (inTrash) setConfirm({ kind: 'delete-trash', ids: selectedTrash.map((t) => t.id) })
      else setConfirm({ kind: 'delete', paths: selectedEntries.map((x) => x.path) })
      return
    }
    if (e.key === 'F2' && singleEntry && !inTrash) {
      e.preventDefault()
      setNameDialog({ kind: 'rename', entry: singleEntry })
      return
    }
    if (e.key === 'Enter' && singleEntry && !inTrash) {
      e.preventDefault()
      openEntry(singleEntry)
      return
    }
    if (e.key === 'Backspace' && fm.canUp && !inTrash) {
      e.preventDefault()
      fm.goUp()
      return
    }
    if (e.key === 'Escape') fm.clearSelection()
  }

  // ---------------- 上传 ----------------
  const pickFiles = (): void => fileInputRef.current?.click()
  const pickDir = (): void => dirInputRef.current?.click()

  // 拖拽上传：只在文件模式、且真的拖的是文件时接
  const canUpload = !inTrash && !fm.loading
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!canUpload) return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void fm.upload(files, fm.path)
  }

  /**
   * 首次读完之后把焦点交给内容区：键盘快捷键（Ctrl+A / Delete / F2）才有落点。
   * 只在**第一次**做 —— 每次刷新都抢焦点会在用户正打字时把光标抢走。
   */
  const focusedOnceRef = useRef(false)
  useEffect(() => {
    if (focusedOnceRef.current || fm.loading) return
    focusedOnceRef.current = true
    containerRef.current?.focus({ preventScroll: true })
  }, [fm.loading])

  const crumbs = fm.crumbs
  const viewIsGrid = fm.view === 'grid'
  const roots = fm.roots

  /**
   * 内容区那唯一一个菜单的内容：右键在条目上 → 条目动作；在空白处 → 目录级动作。
   *
   * 判定在 `onContentContextMenu` 里做完（只记 `menuTarget`），这里只按它铺菜单项 ——
   * 菜单项由 Radix 在 `onSelect` 里自动关闭，不需要我们管 open 状态。
   */
  const renderMenuItems = (): React.JSX.Element => {
    if (menuTarget?.kind === 'trash') {
      const ids = fm.selected.has(menuTarget.item.id)
        ? selectedTrash.map((t) => t.id)
        : [menuTarget.item.id]
      return (
        <TrashMenuItems
          count={ids.length}
          onRestore={() => void fm.restoreTrash(ids)}
          onDelete={() => setConfirm({ kind: 'delete-trash', ids })}
        />
      )
    }
    if (menuTarget?.kind === 'entry') {
      const entry = menuTarget.entry
      const targets = targetsFor(entry)
      return (
        <ItemMenuItems
          entry={entry}
          targets={targets}
          onPreview={() => openEntry(entry)}
          onRename={() => setNameDialog({ kind: 'rename', entry })}
          onCopy={() => fm.copySelection(targets)}
          onCut={() => fm.cutSelection(targets)}
          onPaste={() => void fm.paste()}
          onDownload={() => void fm.download(entriesOf(targets))}
          onCompress={() => {
            // 压缩对话框读的是 `selectedEntries`，先确保选中集就是这一批
            if (targets.length > 1) fm.setSelected(new Set(targets))
            setCompressOpen(true)
          }}
          onExtract={() => setExtractEntry(entry)}
          onTrash={() => setConfirm({ kind: 'delete', paths: targets })}
          onDeleteForever={() => setConfirm({ kind: 'delete-forever', paths: targets })}
          onProperties={() => setPropsEntry(entry)}
        />
      )
    }
    return (
      <BlankMenuItems
        path={fm.path}
        showHidden={fm.showHidden}
        hasClipboard={!!fm.clipboard}
        clipboardCount={fm.clipboard?.paths.length ?? 0}
        inTrash={inTrash}
        trashCount={fm.trashItems.length}
        onNewFile={() => setNameDialog({ kind: 'new-file' })}
        onNewDir={() => setNameDialog({ kind: 'new-dir' })}
        onPaste={() => void fm.paste()}
        onRefresh={() => fm.reload()}
        onSelectAll={fm.selectAll}
        onToggleHidden={() => fm.setShowHidden(!fm.showHidden)}
        onEmptyTrash={() => setConfirm({ kind: 'empty-trash' })}
      />
    )
  }
  const menuItems = renderMenuItems()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ---------- 工具栏 ---------- */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5">
        <ToolButton icon={<ArrowLeft className="size-4" />} label="后退" onClick={fm.back} disabled={!fm.canBack || inTrash} />
        <ToolButton icon={<ArrowRight className="size-4" />} label="前进" onClick={fm.forward} disabled={!fm.canForward || inTrash} />
        <ToolButton icon={<ArrowUp className="size-4" />} label="上一级" onClick={fm.goUp} disabled={!fm.canUp || inTrash} />
        <ToolButton
          icon={<Home className="size-4" />}
          label="主目录"
          onClick={() => roots && void fm.navigateTo(roots.home)}
          disabled={inTrash}
        />
        {/* 盘符 / 常用位置：Windows 有多个盘，得有地方选 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 shrink-0 p-0"
              title="这台电脑 / 常用位置"
              aria-label="这台电脑"
              disabled={inTrash}
            >
              <HardDrive className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {roots?.places.map((place) => (
              <DropdownMenuItem key={place.id} onSelect={() => void fm.navigateTo(place.path)}>
                <Home className="size-3.5" />
                <span className="truncate">{place.label}</span>
                <span className="ml-auto max-w-24 truncate font-mono text-[10px] text-muted-foreground">
                  {place.path}
                </span>
              </DropdownMenuItem>
            ))}
            {roots?.drives.length ? <DropdownMenuSeparator /> : null}
            {roots?.drives.map((drive) => (
              <DropdownMenuItem key={drive.id} onSelect={() => void fm.navigateTo(drive.path)}>
                <HardDrive className="size-3.5" />
                <span className="truncate">{drive.label}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => fm.setMode('trash')}>
              <Trash2 className="size-3.5" />
              回收站
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton
          icon={<RefreshCw className={cn('size-4', fm.loading && 'animate-spin')} />}
          label="刷新"
          onClick={() => fm.reload()}
        />

        {/* 面包屑（可点，横向溢出时自己滚） */}
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md bg-secondary/60 px-2 py-1">
          {inTrash ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
              <Trash2 className="size-3.5 text-amber-500" />
              回收站
            </span>
          ) : crumbs.length === 0 ? (
            <span className="text-xs text-muted-foreground">加载中…</span>
          ) : (
            crumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                {i > 0 ? <ChevronDown className="size-3 -rotate-90 text-muted-foreground" /> : null}
                <button
                  type="button"
                  className={cn(
                    'max-w-40 truncate rounded px-1 text-xs hover:bg-background/80',
                    i === crumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
                    // 拖动条目时可以丢到祖先目录上（= 移动到那一层）
                    dropPath === crumb.path && 'bg-primary/20 ring-1 ring-primary'
                  )}
                  title={crumb.path}
                  onClick={() => void fm.navigateTo(crumb.path)}
                  onDragOver={(e) => onDirDragOver(crumb.path, e)}
                  onDragLeave={() => setDropPath((prev) => (prev === crumb.path ? null : prev))}
                  onDrop={(e) => onDirDrop(crumb.path, e)}
                >
                  {crumb.label}
                </button>
              </span>
            ))
          )}
        </div>

        {inTrash ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={!fm.trashItems.length}
              onClick={() => setConfirm({ kind: 'empty-trash' })}
            >
              <Trash2 className="size-3.5" />
              清空回收站
            </Button>
            <ToolButton
              icon={<FolderDown className="size-4" />}
              label="回到文件"
              onClick={() => fm.setMode('files')}
            />
          </>
        ) : (
          <>
            <ToolButton
              icon={fm.showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              label={fm.showHidden ? '隐藏以 . 开头的文件' : '显示隐藏文件'}
              active={fm.showHidden}
              onClick={() => fm.setShowHidden(!fm.showHidden)}
            />
            <ToolButton
              icon={<FilePlus2 className="size-4" />}
              label="新建文件"
              onClick={() => setNameDialog({ kind: 'new-file' })}
            />
            <ToolButton
              icon={<FolderPlus className="size-4" />}
              label="新建文件夹"
              onClick={() => setNameDialog({ kind: 'new-dir' })}
            />
            {/*
              上传：左半直接选文件，右半箭头弹「上传文件 / 上传文件夹」——
              与会话详情顶栏的终端入口同一个分裂按钮形状（也是 SFTP 面板那一套）。
            */}
            <div className="flex shrink-0 items-center">
              <Button
                size="sm"
                className="h-7 gap-1 rounded-r-none px-2 text-xs"
                disabled={!canUpload}
                title="上传文件（可多选）"
                onClick={pickFiles}
              >
                <Upload className="size-3.5" />
                上传
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="h-7 rounded-l-none border-l border-primary-foreground/25 px-1"
                    disabled={!canUpload}
                    title="上传文件 / 文件夹"
                    aria-label="上传文件或文件夹"
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={pickFiles}>
                    <Upload className="size-3.5" />
                    上传文件
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={pickDir}>
                    <FolderDown className="size-3.5" />
                    上传文件夹
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <ToolButton
              icon={viewIsGrid ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
              label={viewIsGrid ? '切换为列表视图' : '切换为网格视图'}
              onClick={() => fm.setView(viewIsGrid ? 'list' : 'grid')}
            />
          </>
        )}
      </div>

      {/*
        ---------- 选中操作栏 ----------

        整条栏**只有图标**（`ToolButton`：label 进 title / aria-label）。

        为什么不带文字：这一排最多十个动作（下载 / 复制 / 剪切 / 粘贴 / 重命名 / 删除 /
        属性 / 批量重命名 / 压缩 / 解压），每个都带两三个字的话，窄屏会折成两三行，
        把内容区往下顶一截 —— 而它本来只该占一条。图标 + 悬停提示 + 分组细线，
        扫一眼能认出来，也不再挤。

        顺序（用户指定）：删除 / 属性 在「批量重命名」之前。
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-1">
        <span className="shrink-0 text-xs text-muted-foreground">
          {inTrash
            ? `${fm.trashItems.length} 项已删除 · 选中 ${selectionCount}`
            : `已选 ${selectionCount} 项`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-0.5">
          {inTrash ? (
            <>
              <ToolButton
                icon={<RotateCcw className="size-3.5" />}
                label="还原选中项"
                disabled={!selectionCount}
                onClick={() => void fm.restoreTrash(selectedTrash.map((t) => t.id))}
              />
              <ActionDivider />
              <ToolButton
                danger
                icon={<Trash2 className="size-3.5" />}
                label="彻底删除（不可恢复）"
                disabled={!selectionCount}
                onClick={() => setConfirm({ kind: 'delete-trash', ids: selectedTrash.map((t) => t.id) })}
              />
              <ActionDivider />
              <ToolButton
                icon={<X className="size-3.5" />}
                label="取消选择"
                disabled={!selectionCount}
                onClick={fm.clearSelection}
              />
            </>
          ) : (
            <>
              <ToolButton
                icon={<Download className="size-3.5" />}
                label="下载选中项（目录由服务端打 zip）"
                disabled={!selectionCount}
                onClick={() => void fm.download(selectedEntries)}
              />
              <ActionDivider />
              <ToolButton
                icon={<Copy className="size-3.5" />}
                label="复制"
                disabled={!selectionCount}
                onClick={() => fm.copySelection(selectedEntries.map((x) => x.path))}
              />
              <ToolButton
                icon={<Scissors className="size-3.5" />}
                label="剪切"
                disabled={!selectionCount}
                onClick={() => fm.cutSelection(selectedEntries.map((x) => x.path))}
              />
              <ToolButton
                icon={<ClipboardPaste className="size-3.5" />}
                label={
                  fm.clipboard ? `粘贴 ${fm.clipboard.paths.length} 项到当前目录` : '剪贴板是空的'
                }
                disabled={!fm.clipboard}
                onClick={() => void fm.paste()}
              />
              <ActionDivider />
              <ToolButton
                icon={<Pencil className="size-3.5" />}
                label="重命名"
                disabled={!singleEntry}
                onClick={() => singleEntry && setNameDialog({ kind: 'rename', entry: singleEntry })}
              />
              {/* 删除：紧跟在重命名后面（多选时也能用，作用于整批） */}
              <ToolButton
                danger
                icon={<Trash2 className="size-3.5" />}
                label={
                  selectionCount > 1 ? `把选中的 ${selectionCount} 项移到回收站` : '移到回收站'
                }
                disabled={!selectionCount}
                onClick={() =>
                  setConfirm({ kind: 'delete', paths: selectedEntries.map((x) => x.path) })
                }
              />
              <ToolButton
                icon={<Info className="size-3.5" />}
                label="属性"
                disabled={!singleEntry}
                onClick={() => setPropsEntry(singleEntry)}
              />
              {/*
                批量重命名用 `ListOrdered` 而不是也拿 `Pencil`：纯图标时两把同样的铅笔
                分不清哪个是「改一个」哪个是「按序号重排一批」。
              */}
              <ToolButton
                icon={<ListOrdered className="size-3.5" />}
                label="批量重命名为「名字 (1).ext」「名字 (2).ext」…"
                disabled={selectionCount < 2}
                onClick={() => setNameDialog({ kind: 'batch-rename' })}
              />
              <ActionDivider />
              <ToolButton
                icon={<FileArchive className="size-3.5" />}
                label="压缩为 zip"
                disabled={!selectionCount}
                onClick={() => setCompressOpen(true)}
              />
              {singleEntry && kindOf(singleEntry.name, singleEntry.isDir) === 'archive' ? (
                <ToolButton
                  icon={<FolderInput className="size-3.5" />}
                  label="解压到…"
                  onClick={() => setExtractEntry(singleEntry)}
                />
              ) : null}
              <ActionDivider />
              <ToolButton
                icon={<X className="size-3.5" />}
                label="取消选择"
                disabled={!selectionCount}
                onClick={fm.clearSelection}
              />
            </>
          )}
        </div>
      </div>

      {/*
        ---------- 内容区 ----------

        ⚠️ 整块内容区**只包一个** Radix 菜单根，trigger 就是这个滚动容器：
        右键落在条目上 → 条目的菜单项；落在空白处 → 「对当前目录做什么」的菜单项。
        不能给每块磁贴单独包一个 `ContextMenu`（原来就是那样）—— 那样既没法做空白处菜单，
        又踩了 `composeEventHandlers` 的 `checkForDefaultPrevented`：磁贴自己的
        `onContextMenu` 里一 preventDefault，冒泡到 trigger 时「打开菜单」就被整段跳过，
        菜单永远弹不出来。
      */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            tabIndex={0}
            className="relative min-h-0 flex-1 overflow-auto outline-none select-none"
            onKeyDown={onKeyDown}
            onPointerDown={onContentPointerDown}
            onPointerMove={onContentPointerMove}
            onPointerUp={endMarquee}
            onPointerLeave={endMarquee}
            onContextMenu={onContentContextMenu}
            onDragEnter={(e) => {
              // 只认「从系统里拖文件进来」；内部拖动条目移动走 folder 自己的 dragover
              if (!canUpload || !e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              dragDepthRef.current++
              setDragActive(true)
            }}
            onDragOver={(e) => {
              if (!canUpload || !e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
              if (dragDepthRef.current === 0) setDragActive(false)
            }}
            onDrop={onDrop}
          >
            {dragActive && canUpload ? (
              <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/5">
                <div className="flex flex-col items-center gap-2 text-primary">
                  <Upload className="size-7" />
                  <span className="text-sm">松手即上传到 {fm.path}</span>
                </div>
              </div>
            ) : null}

            {fm.error ? (
              <div className="mx-4 mt-10 flex flex-col items-center gap-3 rounded-md border border-dashed border-destructive/40 px-4 py-6 text-center text-sm text-destructive">
                <span>{fm.error}</span>
                <Button variant="outline" size="sm" onClick={() => fm.reload()}>
                  <RefreshCw className="size-3.5" />
                  重试
                </Button>
              </div>
            ) : fm.loading && !(inTrash ? fm.trashItems.length : fm.entries.length) ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在读取目录…
              </div>
            ) : inTrash ? (
              fm.trashItems.length === 0 ? (
                <div className="mx-4 mt-10 rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                  回收站是空的。
                </div>
              ) : (
                <div className="flex flex-col">
                  {fm.trashItems.map((item) => (
                    <TrashRow
                      key={item.id}
                      item={item}
                      selected={fm.selected.has(item.id)}
                      onSelect={(e) => fm.selectItem(item.id, e)}
                      onRestore={() => void fm.restoreTrash([item.id])}
                    />
                  ))}
                </div>
              )
            ) : fm.visibleEntries.length === 0 ? (
              <div className="mx-4 mt-10 rounded-md px-4 py-8 text-center text-xs text-muted-foreground">
                {fm.showHidden ? '这个目录是空的。' : '这个目录是空的（也可能全是隐藏文件，点右上角那只眼睛）。'}
              </div>
            ) : viewIsGrid ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-1 p-2">
                {fm.visibleEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className="min-w-0"
                    // 拖动条目 = 移动（按住 Ctrl / Alt 拖 = 复制到那个目录）
                    draggable
                    onDragStart={(e) => onItemDragStart(entry, e)}
                    onDragEnd={resetDrag}
                    {...folderDropProps(entry)}
                  >
                    <GridTile
                      id={entry.path}
                      name={entry.name}
                      kind={kindOf(entry.name, entry.isDir)}
                      size={entry.size}
                      selected={fm.selected.has(entry.path)}
                      dragging={dragging && dragPathsRef.current.includes(entry.path)}
                      dropActive={dropPath === entry.path}
                      onSelect={(e) => fm.selectItem(entry.path, e)}
                      onOpen={() => openEntry(entry)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col">
                {fm.visibleEntries.map((entry) => (
                  <div
                    key={entry.path}
                    draggable
                    onDragStart={(e) => onItemDragStart(entry, e)}
                    onDragEnd={resetDrag}
                    {...folderDropProps(entry)}
                  >
                    <ListRow
                      id={entry.path}
                      name={entry.name}
                      kind={kindOf(entry.name, entry.isDir)}
                      size={entry.size}
                      mtime={entry.mtime}
                      selected={fm.selected.has(entry.path)}
                      dragging={dragging && dragPathsRef.current.includes(entry.path)}
                      dropActive={dropPath === entry.path}
                      onSelect={(e) => fm.selectItem(entry.path, e)}
                      onOpen={() => openEntry(entry)}
                      onCheck={() =>
                        fm.selectItem(entry.path, { ctrlKey: true, metaKey: false, shiftKey: false })
                      }
                    />
                  </div>
                ))}
              </div>
            )}

            {fm.truncated ? (
              <p className="px-3 py-2 text-xs text-amber-600">
                条目太多，只显示了前 5000 项 —— 请进入更具体的目录。
              </p>
            ) : null}

            {/* 框选矩形（客户端坐标 → 容器内坐标） */}
            {marquee ? (
              <div
                className="pointer-events-none absolute z-10 rounded-sm border border-primary bg-primary/10"
                style={{
                  left: Math.min(marquee.x1, marquee.x2) - (containerRef.current?.getBoundingClientRect().left ?? 0),
                  top:
                    Math.min(marquee.y1, marquee.y2) -
                    (containerRef.current?.getBoundingClientRect().top ?? 0) +
                    (containerRef.current?.scrollTop ?? 0),
                  width: Math.abs(marquee.x2 - marquee.x1),
                  height: Math.abs(marquee.y2 - marquee.y1)
                }}
              />
            ) : null}

            {/* 批量动作进度：贴底一条，不遮内容 */}
            {fm.progress ? (
              <div className="pointer-events-none sticky bottom-0 left-0 right-0 z-20 flex items-center gap-2 bg-background/95 px-3 py-2 text-xs shadow-[0_-1px_0_0_var(--border)]">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span className="shrink-0">
                  {fm.progress.label} {fm.progress.done} / {fm.progress.total}
                </span>
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.round((fm.progress.done / Math.max(1, fm.progress.total)) * 100)}%` }}
                  />
                </div>
              </div>
            ) : null}
              </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">{menuItems}</ContextMenuContent>
      </ContextMenu>

      {/* ---------- 隐藏的文件选择框 ---------- */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void fm.upload(files, fm.path)
        }}
      />
      <input
        ref={dirInputRef}
        type="file"
        // `webkitdirectory` 不在 React 的 input 类型里，但浏览器认它（拿到的 File 带相对路径）
        {...({ webkitdirectory: '' } as Record<string, string>)}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void fm.upload(files, fm.path)
        }}
      />

      {/* ---------- 弹窗 ---------- */}
      <NameDialog
        open={nameDialog !== null}
        title={
          nameDialog?.kind === 'new-dir'
            ? '新建文件夹'
            : nameDialog?.kind === 'new-file'
              ? '新建文件'
              : nameDialog?.kind === 'batch-rename'
                ? '批量重命名'
                : '重命名'
        }
        description={
          nameDialog?.kind === 'batch-rename'
            ? `选中的 ${selectedEntries.length} 项会变成「名字 (1).ext」「名字 (2).ext」…`
            : nameDialog?.entry
              ? nameDialog.entry.path
              : fm.path
        }
        label={nameDialog?.kind === 'batch-rename' ? '新名字（不含序号与扩展名）' : '名字'}
        defaultValue={
          nameDialog?.kind === 'rename'
            ? (nameDialog.entry?.name ?? '')
            : nameDialog?.kind === 'batch-rename'
              ? ''
              : ''
        }
        confirmText={
          nameDialog?.kind === 'new-dir' ? '创建' : nameDialog?.kind === 'new-file' ? '创建' : '确定'
        }
        onOpenChange={(open) => !open && setNameDialog(null)}
        onSubmit={(value) => {
          if (!nameDialog) return
          if (nameDialog.kind === 'new-dir') void fm.mkdir(value)
          else if (nameDialog.kind === 'new-file') void fm.createFile(value)
          else if (nameDialog.kind === 'rename' && nameDialog.entry) void fm.rename(nameDialog.entry.path, value)
          else if (nameDialog.kind === 'batch-rename')
            void fm.batchRename(selectedEntries.map((x) => x.path), value)
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'empty-trash'
            ? '清空回收站？'
            : confirm?.kind === 'delete-forever'
              ? '彻底删除？'
              : confirm?.kind === 'delete-trash'
                ? '彻底删除选中项？'
                : '移到回收站？'
        }
        description={
          confirm?.kind === 'empty-trash'
            ? '回收站里的所有东西都会被永久删除，无法恢复。'
            : confirm?.kind === 'delete-trash'
              ? '这一步不进回收站，删掉就找不回来了。'
              : '文件会移到回收站，之后可以还原。'
        }
        extra={
          confirm?.kind === 'delete-trash'
            ? selectedTrash
                .filter((t) => (confirm?.ids ?? []).includes(t.id))
                .map((t) => `${t.name}  ←  ${t.originalPath}`)
                .join('\n')
            : (confirm?.paths ?? []).join('\n')
        }
        confirmText={
          confirm?.kind === 'empty-trash'
            ? '清空'
            : confirm?.kind === 'delete-trash'
              ? '彻底删除'
              : confirm?.kind === 'delete-forever'
                ? '彻底删除'
                : '移到回收站'
        }
        onOpenChange={(open) => !open && setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return
          if (confirm.kind === 'empty-trash') void fm.emptyTrash()
          else if (confirm.kind === 'delete-trash' && confirm.ids) void fm.deleteTrash(confirm.ids)
          else if (confirm.paths) void fm.remove(confirm.paths, confirm.kind === 'delete-forever')
        }}
      />

      <CompressDialog
        open={compressOpen}
        count={selectedEntries.length}
        defaultName={
          selectedEntries.length === 1
            ? `${selectedEntries[0].name.replace(/\.[^.]+$/, '')}.zip`
            : 'archive.zip'
        }
        dirPath={fm.path}
        onOpenChange={setCompressOpen}
        onConfirm={(fileName) => {
          const sep = fm.path.endsWith('/') || fm.path.endsWith('\\') ? '' : fm.path.includes('\\') ? '\\' : '/'
          void fm.compress(selectedEntries.map((x) => x.path), `${fm.path}${sep}${fileName}`)
        }}
      />

      <ExtractDialog
        open={!!extractEntry}
        archive={extractEntry}
        defaultTarget={
          extractEntry ? extractEntry.path.replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, '') : ''
        }
        onOpenChange={(open) => !open && setExtractEntry(null)}
        onConfirm={(target) => {
          if (extractEntry) void fm.extract(extractEntry.path, target)
        }}
      />

      <PropertiesDialog entry={propsEntry} onClose={() => setPropsEntry(null)} />

      <FilePreviewDialog entry={previewEntry} onClose={() => setPreviewEntry(null)} />
    </div>
  )
}

/**
 * 回收站里的一行（结构与普通文件行差不多，但操作是「还原 / 彻底删除」）。
 *
 * 右键菜单**不在这里**：整个内容区只有一个 Radix 菜单根（见 `ItemMenuItems` 的注释），
 * 这一行的菜单项由容器的 `onContextMenu` 认领后统一渲染。
 */
function TrashRow({
  item,
  selected,
  onSelect,
  onRestore
}: {
  item: FmTrashItem
  selected: boolean
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onRestore: () => void
}): React.JSX.Element {
  const { Icon, className } = iconOf(kindOf(item.name, item.isDir), item.isDir)
  return (
    <div
      data-fm-tid={item.id}
      data-fm-id=""
      className={cn(
        'flex cursor-pointer items-center gap-3 px-3 py-1.5',
        selected ? 'bg-primary/10' : 'hover:bg-secondary/60'
      )}
      onClick={(e) => onSelect(e)}
      onDoubleClick={onRestore}
    >
      <Checkbox
        className="shrink-0"
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => onSelect({ ctrlKey: true, metaKey: false, shiftKey: false })}
      />
      <Icon className={cn('size-4 shrink-0', className)} />
      <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
      <span className="hidden min-w-0 max-w-56 truncate font-mono text-[10px] text-muted-foreground sm:block">
        {item.originalPath}
      </span>
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{formatTime(item.deletedAt)}</span>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {item.isDir ? '-' : formatSize(item.size)}
      </span>
    </div>
  )
}

