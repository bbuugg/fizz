/**
 * 文件管理器的几个小弹窗：改名 / 新建 / 删除确认 / 压缩 / 解压 / 属性。
 *
 * 全部是**受控**的纯展示组件（`open` + 回调），状态留在面板里 —— 与项目里其它弹窗
 * 同一套写法，好处是「取消」不会在组件内部留下半截输入。
 *
 * 样式一律 `sm:max-w-md`（AGENTS.md 的表单弹窗口径），窄屏上下排。
 */
import { useEffect, useState } from 'react'
import { FileArchive, FolderInput, Info, Trash2 } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import type { FmEntry } from '@fizz/contracts/agent-api'
import { formatSize, formatTime } from '@fizz/agent-kit/features/file-manager/file-kind'

/** 新建 / 改名共用的输入弹窗 */
export function NameDialog({
  open,
  title,
  description,
  label,
  defaultValue = '',
  confirmText = '确定',
  onOpenChange,
  onSubmit
}: {
  open: boolean
  title: string
  description?: string
  label: string
  defaultValue?: string
  confirmText?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(defaultValue)
  // 每次打开都重置：上一次输了一半的名字不该留到下一次（用户会误按确定）
  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  const submit = (): void => {
    const name = value.trim()
    if (!name) return
    onSubmit(name)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fm-name">{label}</Label>
          <Input
            id="fm-name"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </div>
        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 危险动作的确认框（删除 / 清空回收站 / 彻底删除） */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '删除',
  extra,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  confirmText?: string
  /** 列表性的补充说明（被删的都有哪些） */
  extra?: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {extra ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-secondary/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {extra}
          </pre>
        ) : null}
        <DialogFooter>
          <Button data-dialog-dismiss="" autoFocus variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 压缩：给个包名，目标目录就是当前目录 */
export function CompressDialog({
  open,
  count,
  defaultName,
  dirPath,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  /** 选中的条目数（只说数量，不列名字 —— 一列就把弹窗撑破了） */
  count: number
  defaultName: string
  dirPath: string
  onOpenChange: (open: boolean) => void
  onConfirm: (fileName: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(defaultName)
  useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])

  // 用户可能只输 `backup`，补上 `.zip`：解压时按扩展名认格式，没扩展名会「不认识」
  const fileName = name.trim() ? (name.trim().toLowerCase().endsWith('.zip') ? name.trim() : `${name.trim()}.zip`) : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="size-4" />
            压缩为 zip
          </DialogTitle>
          <DialogDescription>
            把选中的 {count} 项打包到 {dirPath}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fm-zip-name">压缩包名</Label>
          <Input
            id="fm-zip-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fileName) {
                onConfirm(fileName)
                onOpenChange(false)
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!fileName}
            onClick={() => {
              onConfirm(fileName)
              onOpenChange(false)
            }}
          >
            压缩
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 解压：目标目录默认「压缩包旁边、同名的文件夹」 */
export function ExtractDialog({
  open,
  archive,
  defaultTarget,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  archive: FmEntry | null
  defaultTarget: string
  onOpenChange: (open: boolean) => void
  onConfirm: (target: string) => void
}): React.JSX.Element {
  const [target, setTarget] = useState(defaultTarget)
  useEffect(() => {
    if (open) setTarget(defaultTarget)
  }, [open, defaultTarget])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="size-4" />
            解压
          </DialogTitle>
          <DialogDescription>
            {archive ? archive.name : ''} · 同名文件会被覆盖，已有目录会合并
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fm-extract-to">解压到</Label>
          <Input
            id="fm-extract-to"
            autoFocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && target.trim()) {
                onConfirm(target.trim())
                onOpenChange(false)
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!target.trim()}
            onClick={() => {
              onConfirm(target.trim())
              onOpenChange(false)
            }}
          >
            解压
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 属性：路径 / 大小 / 修改时间 / 类型 */
export function PropertiesDialog({
  entry,
  onClose
}: {
  entry: FmEntry | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="size-4" />
            属性
          </DialogTitle>
          <DialogDescription>{entry?.name}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-xs">
          <dt className="text-muted-foreground">路径</dt>
          <dd className="font-mono break-all">{entry?.path}</dd>
          <dt className="text-muted-foreground">类型</dt>
          <dd>{entry?.isDir ? '文件夹' : entry?.isLink ? '链接 / 文件' : '文件'}</dd>
          <dt className="text-muted-foreground">大小</dt>
          <dd>{entry?.isDir ? '-' : formatSize(entry?.size ?? 0)}</dd>
          <dt className="text-muted-foreground">修改时间</dt>
          <dd>{formatTime(entry?.mtime ?? 0)}</dd>
        </dl>
        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
