'use client'

/**
 * 数据导入 / 导出对话框（左下角菜单「导入 / 导出」进入，对齐 dogi 的 `DataTransferDialog`）。
 *
 * ## 导出
 *
 * 勾选类型 → 选形态（zip / 单文件 JSON）→ 服务端把内容以 base64 回传 → 本地 `Blob` 下载。
 * 文件内容**不经过服务器磁盘**：导出即「读库 → 序列化 → 下载」，中间不落临时文件。
 *
 * ## 导入
 *
 * 分两步（同 dogi 的 pick → apply）：先选文件让服务端**只解析不写库**，界面把
 * 「这一包里有什么、各多少条、多少个分组」列出来让人勾；确认后才真正写。
 * 导入是**按 id 覆盖**的，所以这一步预览不是装饰 —— 它决定了会不会动到现有条目。
 *
 * ## ⚠️ 主机只导出连接信息
 *
 * 密码 / 私钥 / 口令在服务端是加密落盘的、绑本机密钥，拷到别处解不开，所以导出包
 * **本来就不带**（见 `@fizz/workspace` 的 `transfer.ts`）。导入后需要重新填。
 * 覆盖已存在的主机时也不会把本机存着的凭据抹掉。
 *
 * ## 文案表在这里写一份，不从 `@fizz/workspace` 引
 *
 * `@fizz/workspace` 是 Node 专用包（带 `node:fs`），浏览器产物引不得。
 * 三类数据的显示名很短，各写一份的代价远小于为了省几个字去拆包。
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileDown, FileUp, FolderOpen } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import { Label } from '@fizz/ui/label'
import { RadioGroup, RadioGroupItem } from '@fizz/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { triggerBlobDownload } from '@fizz/agent-client/download-file'
import { base64ToBytes, pickFileBase64 } from '@fizz/agent-kit/shared/lib/pick-file'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type {
  TransferEntry,
  TransferFormat,
  TransferImportResult,
  TransferKind
} from '@fizz/contracts/types'

/** 对话框模式：null = 关闭 */
export type TransferMode = 'export' | 'import' | null

const KIND_LABEL: Record<TransferKind, string> = {
  api: '接口请求',
  hosts: '主机',
  scripts: '脚本'
}

/** 显示顺序：接口请求在前（最常用），主机（有凭据要重填的坑）中间，脚本最后 */
const ALL_KINDS: TransferKind[] = ['api', 'hosts', 'scripts']

/** 导入时认的扩展名（`.json` 单文件 / `.zip` 整包） */
const ACCEPT = '.json,.zip,application/json,application/zip'

/** 已解析、待确认的导入包（内容留在渲染端，apply 时再传一次） */
interface PendingBundle {
  fileName: string
  dataBase64: string
  entries: TransferEntry[]
}

/** 把「新增 / 覆盖 / 跳过」拼成人能读的一行；跳过的 0 不显示（多数时候确实是 0） */
function summarize(result: TransferImportResult, kinds: TransferKind[]): string {
  return kinds
    .map((kind) => {
      const added = result.added[kind] ?? 0
      const updated = result.updated[kind] ?? 0
      const skipped = result.skipped[kind] ?? 0
      return `${KIND_LABEL[kind]} 新增 ${added} / 覆盖 ${updated}${skipped ? ` / 跳过 ${skipped}` : ''}`
    })
    .join('；')
}

export function DataTransferDialog({
  app,
  mode,
  onClose
}: {
  app: AgentApp
  mode: TransferMode
  onClose: () => void
}) {
  /** 勾选的类型 */
  const [selected, setSelected] = useState<TransferKind[]>(ALL_KINDS)
  /** 导出形态；`json` 只允许勾一类（服务端也会拒） */
  const [format, setFormat] = useState<TransferFormat>('zip')
  /** 已解析的导入包 */
  const [bundle, setBundle] = useState<PendingBundle | null>(null)
  const [busy, setBusy] = useState(false)

  const exporting = mode === 'export'

  // 每次打开都回到初始勾选，避免上一次的选择残留（同 dogi）
  useEffect(() => {
    if (mode === null) return
    setSelected(ALL_KINDS)
    setFormat('zip')
    setBundle(null)
    setBusy(false)
  }, [mode])

  // 勾选变了之后如果不再满足「只有一类」，把形态推回 zip（否则提交时必然被服务端拒）
  useEffect(() => {
    if (selected.length !== 1 && format === 'json') setFormat('zip')
  }, [selected, format])

  const countOf = (kind: TransferKind): number =>
    kind === 'api' ? app.apiRequests.length : kind === 'hosts' ? app.sshHosts.length : app.scripts.length

  const toggle = (kind: TransferKind, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, kind] : prev.filter((k) => k !== kind)))
  }

  /** 关闭：顺手把已解析的包丢掉（内容只在内存里，不清就是白白留着） */
  const handleClose = (): void => {
    setBundle(null)
    onClose()
  }

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await app.exportTransferData({ kinds: selected, format })
      if (!result) return // 失败已写 error
      const bytes = base64ToBytes(result.dataBase64)
      // 用 Uint8Array 而不是直接传 base64 字符串：zip 是二进制，当文本写会把每个字节截断
      triggerBlobDownload(new Blob([bytes as BlobPart], { type: result.mime }), result.fileName)
      const parts = selected.map((k) => `${KIND_LABEL[k]} ${result.counts[k] ?? 0} 条`)
      toast.success(`已导出（${parts.join('、')}）`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handlePick = async (): Promise<void> => {
    setBusy(true)
    try {
      const file = await pickFileBase64(ACCEPT)
      if (!file) return // 用户取消
      const inspected = await app.inspectTransferData({
        dataBase64: file.dataBase64,
        fileName: file.name
      })
      if (!inspected) return // 失败已写 error
      setBundle({ fileName: file.name, dataBase64: file.dataBase64, entries: inspected.entries })
      setSelected(inspected.entries.map((e) => e.kind))
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!bundle) return
    setBusy(true)
    try {
      const result = await app.applyTransferData({
        dataBase64: bundle.dataBase64,
        fileName: bundle.fileName,
        kinds: selected
      })
      if (!result) return // 失败已写 error
      toast.success(`导入完成：${summarize(result, selected)}`)
      setBundle(null)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = exporting ? selected.length > 0 : Boolean(bundle) && selected.length > 0

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {exporting ? <FileUp className="size-4" /> : <FileDown className="size-4" />}
            {exporting ? '导出数据' : '导入数据'}
          </DialogTitle>
          <DialogDescription>
            {exporting
              ? '勾选要导出的数据，打包成一个文件下载。'
              : '选择一个之前导出的数据包（zip 或单个 JSON）。'}
          </DialogDescription>
        </DialogHeader>

        {exporting ? (
          <div className="space-y-3">
            <div className="space-y-1">
              {ALL_KINDS.map((kind) => (
                <label
                  key={kind}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-foreground/5"
                >
                  <Checkbox
                    checked={selected.includes(kind)}
                    onCheckedChange={(v) => toggle(kind, v === true)}
                  />
                  <span className="text-sm">{KIND_LABEL[kind]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{countOf(kind)} 条</span>
                </label>
              ))}
            </div>

            <div className="space-y-1.5 rounded-md border border-border/60 p-2.5">
              <RadioGroup
                value={format}
                onValueChange={(v) => setFormat(v as TransferFormat)}
                className="gap-1.5"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="zip" id="transfer-format-zip" />
                  <Label htmlFor="transfer-format-zip" className="text-sm font-normal">
                    压缩包（zip）
                  </Label>
                  <span className="ml-auto text-xs text-muted-foreground">可一次带走多类</span>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="json"
                    id="transfer-format-json"
                    disabled={selected.length !== 1}
                  />
                  <Label
                    htmlFor="transfer-format-json"
                    className="text-sm font-normal"
                  >
                    单文件 JSON
                  </Label>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {selected.length === 1 ? '与 api.json 同构' : '需只勾一类'}
                  </span>
                </div>
              </RadioGroup>
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              主机只导出连接信息（地址 / 端口 / 账号 / 跳板），密码与私钥由本机密钥加密、
              仅本机可用，**不导出** —— 导入后需要重新填写。
            </p>
          </div>
        ) : bundle ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {bundle.fileName}：勾选要导入的数据（**同 id 会覆盖**现有条目）：
            </p>
            <div className="space-y-1">
              {bundle.entries.map((entry) => (
                <label
                  key={entry.kind}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-foreground/5"
                >
                  <Checkbox
                    checked={selected.includes(entry.kind)}
                    onCheckedChange={(v) => toggle(entry.kind, v === true)}
                  />
                  <span className="text-sm">{KIND_LABEL[entry.kind]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {entry.itemCount} 条 · {entry.groupCount} 个分组
                  </span>
                </label>
              ))}
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void handlePick()}>
              <FolderOpen className="size-3.5" />
              重新选择文件
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4">
            <p className="text-sm text-muted-foreground">选择之前导出的 zip 数据包，或单个 JSON</p>
            <Button variant="outline" disabled={busy} onClick={() => void handlePick()}>
              <FolderOpen className="size-3.5" />
              选择数据包…
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={handleClose} disabled={busy}>
            取消
          </Button>
          <Button
            disabled={!canSubmit || busy}
            onClick={() => void (exporting ? handleExport() : handleImport())}
          >
            {busy ? '处理中…' : exporting ? '导出' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
