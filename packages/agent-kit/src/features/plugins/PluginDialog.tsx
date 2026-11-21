"use client";

/**
 * 插件请求的**对话框**（shadcn Dialog）。
 *
 * 「新增 / 编辑一条配置」这种交互，用户预期是弹窗，而不是「侧栏里换一屏」。而块里
 * 没有「弹窗」这种语义 —— 弹窗是**宿主的能力**（与「开标签页」同理），所以做成
 * 动作结果里的 `openDialog`：插件请求，宿主渲染。
 *
 * 字段沿用 `form` 块那一份（`PluginFormField`），提交时把**所有字段**的值作为 `args`
 * 交给同一个 `onAction`。
 *
 * 提交**失败不关窗**：填错的字段留在框里改，比「关掉重填一遍」好。
 */
import { useEffect, useState } from 'react'
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
import { Textarea } from '@fizz/ui/textarea'
import type { PluginSurfaceActionResult } from '@fizz/contracts/agent-api'

type OpenDialog = NonNullable<PluginSurfaceActionResult['openDialog']>

/** 初值取自字段的 `value`（编辑已有条目时就是当前值） */
function initialOf(request: OpenDialog): Record<string, string> {
  // 纯确认框没有字段：空对象即可（提交时 args 也是空的）
  return Object.fromEntries((request.fields ?? []).map((f) => [f.id, f.value ?? '']))
}

export function PluginDialog({
  request,
  busy,
  onClose,
  onSubmit
}: {
  request: OpenDialog
  busy?: boolean
  onClose: () => void
  /** 返回 false = 提交失败（对话框保持打开，值留着改） */
  onSubmit: (actionId: string, args: Record<string, string>) => Promise<boolean>
}) {
  const [values, setValues] = useState<Record<string, string>>(() => initialOf(request))
  // 请求换了（又点了一次「新增」、或换了一条来编辑）→ 初值跟着换
  useEffect(() => {
    setValues(initialOf(request))
  }, [request])

  const submit = async (): Promise<void> => {
    if (await onSubmit(request.actionId, { ...values })) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.description && <DialogDescription>{request.description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-2">
          {(request.fields ?? []).map((field) => (
            <div key={field.id} className="space-y-1">
              {field.label && (
                <label
                  htmlFor={`plugin-dialog-${field.id}`}
                  className="block text-[0.6875rem] text-muted-foreground"
                >
                  {field.label}
                </label>
              )}
              {/* 多行字段用 textarea（整段文本 / JSON），且回车是换行而不是提交 */}
              {field.multiline ? (
                <Textarea
                  variant="muted"
                  id={`plugin-dialog-${field.id}`}
                  value={values[field.id] ?? ''}
                  placeholder={field.placeholder}
                  disabled={busy}
                  rows={6}
                  aria-label={field.label ?? field.id}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  className="w-full font-mono text-xs"
                />
              ) : (
                <Input
                  variant="muted"
                  id={`plugin-dialog-${field.id}`}
                  type={field.secret ? 'password' : 'text'}
                  value={values[field.id] ?? ''}
                  placeholder={field.placeholder}
                  disabled={busy}
                  aria-label={field.label ?? field.id}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                  className="h-8 w-full text-xs"
                />
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {request.cancelLabel || '取消'}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {request.submitLabel || '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
