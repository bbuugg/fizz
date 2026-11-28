import { ImageViewer } from '@fizz/ui/image-viewer'
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@fizz/ui/sheet'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentFsEntry } from '@fizz/contracts/agent-api'
import type { Clipboard, MenuAction, NameDialogText } from '@fizz/agent-kit/features/files/files-panel-types'

export function FilesPanelOverlays({
  mobileMenuEntry,
  menuActionsOf,
  onCloseMobileMenu,
  uploadConflict,
  onCloseUploadConflict,
  uploading,
  onConfirmOverwrite,
  deletingEntries,
  onCloseDelete,
  onConfirmDelete,
  pastingDir,
  clipboard,
  parentDirOf,
  onClosePaste,
  onConfirmPaste,
  nameDialogText,
  nameInput,
  onNameInputChange,
  nameBusy,
  onCloseNameDialog,
  onConfirmName,
  pendingReload,
  onCloseReload,
  onConfirmReload,
  imageZoomSrc,
  fileName,
  onImageZoomOpenChange
}: {
  mobileMenuEntry: AgentFsEntry | null
  menuActionsOf: (entry: AgentFsEntry) => MenuAction[]
  onCloseMobileMenu: () => void
  uploadConflict: { dir: string; files: File[] } | null
  onCloseUploadConflict: () => void
  uploading: File[]
  onConfirmOverwrite: () => void
  deletingEntries: AgentFsEntry[]
  onCloseDelete: () => void
  onConfirmDelete: () => void
  pastingDir: string | null
  clipboard: Clipboard | null
  parentDirOf: (path: string) => string
  onClosePaste: () => void
  onConfirmPaste: () => void
  nameDialogText: NameDialogText | null
  nameInput: string
  onNameInputChange: (value: string) => void
  nameBusy: boolean
  onCloseNameDialog: () => void
  onConfirmName: () => void
  pendingReload: string | null
  onCloseReload: () => void
  onConfirmReload: (path: string) => void
  imageZoomSrc: string | null
  fileName: string | null
  onImageZoomOpenChange: (open: boolean) => void
}) {
  const t = useT()

  return (
    <>
      <Sheet open={mobileMenuEntry !== null} onOpenChange={(open) => !open && onCloseMobileMenu()}>
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
            {mobileMenuEntry && menuActionsOf(mobileMenuEntry).map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={action.disabled}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent',
                  'disabled:pointer-events-none disabled:opacity-50',
                  action.danger && 'text-destructive hover:bg-destructive/10'
                )}
                onClick={action.run}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={uploadConflict !== null} onOpenChange={(open) => !open && onCloseUploadConflict()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('覆盖同名文件？')}</DialogTitle>
            <DialogDescription>
              {uploadConflict
                ? t('{files} 在 {dir} 下已经存在，继续会覆盖它们原来的内容（不可恢复）。', {
                    files: uploadConflict.files.map((file) => `「${file.name}」`).join(t('、')),
                    dir: uploadConflict.dir ? `「${uploadConflict.dir}」` : t('根目录')
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button data-dialog-dismiss="" autoFocus size="sm" variant="ghost" onClick={onCloseUploadConflict}>
              {t('取消')}
            </Button>
            <Button size="sm" variant="destructive" disabled={uploading.length > 0} onClick={onConfirmOverwrite}>
              {t('覆盖并上传')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deletingEntries.length > 0} onOpenChange={(open) => !open && onCloseDelete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deletingEntries.length > 1
                ? t('删除这 {count} 项？', { count: deletingEntries.length })
                : t('删除{kind}？', { kind: deletingEntries[0]?.type === 'dir' ? t('文件夹') : t('文件') })}
            </DialogTitle>
            <DialogDescription>
              {deletingEntries.length > 1
                ? t('{names}{more}（含文件夹里的全部子内容）将被永久删除，无法恢复。', {
                    names: deletingEntries.slice(0, 5).map((entry) => `「${entry.name}」`).join(t('、')),
                    more: deletingEntries.length > 5 ? t(' 等 {count} 项', { count: deletingEntries.length }) : ''
                  })
                : t('「{name}」{suffix}将被永久删除，无法恢复。', {
                    name: deletingEntries[0]?.name ?? '',
                    suffix: deletingEntries[0]?.type === 'dir' ? t('及其全部子内容') : ''
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button data-dialog-dismiss="" autoFocus size="sm" variant="ghost" onClick={onCloseDelete}>
              {t('取消')}
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirmDelete}>{t('删除')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pastingDir !== null} onOpenChange={(open) => !open && onClosePaste()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{clipboard?.mode === 'cut' ? t('移动到这里？') : t('粘贴到这里？')}</DialogTitle>
            <DialogDescription>
              {clipboard
                ? t('把 {items}{action}「{dir}」。{note}', {
                    items: clipboard.entries.length > 1
                      ? t('{count} 项（{names}{more}）', {
                          count: clipboard.entries.length,
                          names: clipboard.entries.slice(0, 3).map((entry) => `「${entry.name}」`).join(t('、')),
                          more: clipboard.entries.length > 3 ? t(' 等') : ''
                        })
                      : `「${clipboard.entries[0].name}」`,
                    action: clipboard.mode === 'cut' ? t('移动到') : t('复制到'),
                    dir: pastingDir || '/',
                    note: clipboard.mode === 'cut' && clipboard.entries.every((entry) => pastingDir === parentDirOf(entry.path))
                      ? t('（它们已经在这个目录里了）')
                      : ''
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button data-dialog-dismiss="" size="sm" variant="ghost" onClick={onClosePaste}>{t('取消')}</Button>
            <Button size="sm" onClick={onConfirmPaste}>{clipboard?.mode === 'cut' ? t('移动') : t('粘贴')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={nameDialogText !== null} onOpenChange={(open) => !open && onCloseNameDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{nameDialogText?.title}</DialogTitle>
            <DialogDescription>{nameDialogText?.description}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              variant="muted"
              value={nameInput}
              onChange={(event) => onNameInputChange(event.target.value)}
              placeholder={nameDialogText?.placeholder}
              autoFocus
              onKeyDown={(event) => event.key === 'Enter' && onConfirmName()}
            />
          </div>
          <DialogFooter>
            <Button data-dialog-dismiss="" size="sm" variant="ghost" onClick={onCloseNameDialog}>{t('取消')}</Button>
            <Button size="sm" onClick={onConfirmName} disabled={nameBusy || !nameInput.trim()}>
              {nameBusy ? nameDialogText?.busy : nameDialogText?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingReload !== null} onOpenChange={(open) => !open && onCloseReload()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('刷新未保存的文件？')}</DialogTitle>
            <DialogDescription>
              {t('「{name}」有未保存的改动，刷新会用磁盘上的最新内容覆盖它们。', {
                name: pendingReload?.split('/').pop() ?? ''
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button data-dialog-dismiss="" autoFocus size="sm" variant="ghost" onClick={onCloseReload}>{t('取消')}</Button>
            <Button size="sm" variant="destructive" onClick={() => pendingReload && onConfirmReload(pendingReload)}>
              {t('丢弃并刷新')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImageViewer
        src={imageZoomSrc ?? ''}
        alt={fileName ?? 'preview'}
        open={imageZoomSrc !== null}
        onOpenChange={onImageZoomOpenChange}
      />
    </>
  )
}
