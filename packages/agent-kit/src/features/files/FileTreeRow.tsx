import { useT } from '@fizz/agent-kit/shared/lib/language'
import { treeIndent } from '@fizz/agent-kit/shared/lib/tree-indent'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { previewKindOf } from '@fizz/agent-kit/shared/lib/preview'
import {
  ChevronDown,
  ChevronRight,
  FileAudio,
  FileCode,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Folder,
  FolderOpen
} from 'lucide-react'
import type { ComponentProps, ReactNode, TouchEvent as ReactTouchEvent, MouseEvent as ReactMouseEvent } from 'react'

/** 手机长按手势回调，挂在行容器上。 */
export interface TouchHandlers {
  onTouchStart: (e: ReactTouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: ReactTouchEvent) => void
}

export function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (ext === 'json' || ext === 'jsonc') return <FileJson className="size-4 shrink-0 text-amber-500" />
  const kind = previewKindOf(name)
  if (kind === 'image' || kind === 'svg') return <FileImage className="size-4 shrink-0 text-emerald-500" />
  if (kind === 'video') return <FileVideo className="size-4 shrink-0 text-violet-500" />
  if (kind === 'audio') return <FileAudio className="size-4 shrink-0 text-pink-500" />
  // md 与 html 都是「可预览也能改」的文本，用同一支文档图标。
  if (kind === 'markdown' || kind === 'html') return <FileCode2 className="size-4 shrink-0 text-sky-500" />
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return <FileCode className="size-4 shrink-0 text-sky-500" />
  }
  return <FileText className="size-4 shrink-0 text-muted-foreground" />
}

/**
 * 文件树的一行。桌面右键菜单与手机长按菜单共用行本体。
 *
 * 整体用 div 而不是 button：尾部需要容纳手机端的「更多操作」按钮。
 * Radix ContextMenuTrigger 的合成 props 必须透传到真实 DOM，右键菜单才能工作。
 */
export function TreeRow({
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
  selected?: boolean
  ignored?: boolean
  onActivate: (e: ReactMouseEvent<HTMLButtonElement>) => void
  trailing?: ReactNode
  touch?: TouchHandlers
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
        title={ignored ? t('{name}（命中忽略规则，默认不显示）', { name }) : name}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {isDir ? (
          <>
            {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            {open ? <FolderOpen className="size-4 shrink-0 text-primary/80" /> : <Folder className="size-4 shrink-0 text-primary/80" />}
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
