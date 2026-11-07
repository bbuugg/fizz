/**
 * 协作 Agent 的配置弹窗（新建 / 编辑）。
 *
 * 从 `CollabWorkspace.tsx` 拆出来的原因：Agent 名单与配置表单是两件事 —— 名单要一直
 * 可见（看谁在跑、随时停止），表单只在增删改时弹出，拆开后名单渲染不必知道表单字段。
 */
import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AiPermissionMode, CollabAgentConfig } from '@fizz/contracts/types'

/** 工具白名单的可选项（勾上的才会挂给这个 Agent） */
const TOOL_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'read_file', label: '读文件', hint: 'read_file' },
  { key: 'list_files', label: '列目录', hint: 'list_files' },
  { key: 'search_files', label: '搜内容', hint: 'search_files' },
  { key: 'find_files', label: '找文件', hint: 'find_files' },
  { key: 'write_file', label: '写文件', hint: 'write_file' },
  { key: 'edit_file', label: '改文件', hint: 'edit_file' },
  { key: 'delete_file', label: '删文件', hint: 'delete_file' },
  { key: 'execute_command', label: '执行命令', hint: 'execute_command' },
  { key: 'web_fetch', label: '抓网页', hint: 'web_fetch' }
]

export function AgentConfigDialog({
  app,
  agent,
  isNew,
  onOpenChange,
  onSave
}: {
  app: AgentApp
  agent: CollabAgentConfig
  isNew: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agent: CollabAgentConfig) => void
}) {
  const [draft, setDraft] = useState<CollabAgentConfig>(agent)
  const modelValue =
    draft.configId && draft.modelId ? `${draft.configId}::${draft.modelId}` : 'inherit'

  const set = (patch: Partial<CollabAgentConfig>): void =>
    setDraft((prev) => ({ ...prev, ...patch }))

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isNew ? '添加智能体' : `编辑「${agent.name}」`}</DialogTitle>
          <DialogDescription>
            与其他 Agent 共享同一工作区与同一条会话；默认只读，需要改动文件 / 执行命令时再放开权限。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="collab-name">名字</Label>
              <Input
                id="collab-name"
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="例如：调研员"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="collab-role">职责</Label>
              <Input
                id="collab-role"
                value={draft.role}
                onChange={(event) => set({ role: event.target.value })}
                placeholder="一句话说明它擅长什么；用户 @ 点名与广播判定都靠它"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="collab-instructions">提示词（可选）</Label>
              <textarea
                id="collab-instructions"
                value={draft.instructions}
                onChange={(event) => set({ instructions: event.target.value })}
                rows={3}
                className="min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                placeholder="这个 Agent 的工作方式 / 输出格式 / 边界"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5">
                <Label>模型</Label>
                <Select
                  value={modelValue}
                  onValueChange={(value) => {
                    if (value === 'inherit') {
                      setDraft((prev) => {
                        const next = { ...prev }
                        delete next.configId
                        delete next.modelId
                        return next
                      })
                      return
                    }
                    const [configId, modelId] = value.split('::')
                    set({ configId, modelId })
                  }}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随主会话</SelectItem>
                    {app.models.flatMap((config) =>
                      (config.models ?? []).map((model) => (
                        <SelectItem
                          key={`${config.id}::${model.id}`}
                          value={`${config.id}::${model.id}`}
                        >
                          {config.name} / {model.id}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid min-w-0 gap-1.5">
                <Label>权限</Label>
                <Select
                  value={draft.permissionMode}
                  onValueChange={(value) => set({ permissionMode: value as AiPermissionMode })}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="readonly">只读</SelectItem>
                    <SelectItem value="confirm">改动需确认</SelectItem>
                    <SelectItem value="full">完全访问</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>工具</Label>
              <div className="flex flex-wrap gap-1.5">
                {TOOL_OPTIONS.map((tool) => {
                  const checked = draft.tools.includes(tool.key)
                  return (
                    <button
                      key={tool.key}
                      type="button"
                      title={tool.hint}
                      onClick={() =>
                        set({
                          tools: checked
                            ? draft.tools.filter((t) => t !== tool.key)
                            : [...draft.tools, tool.key]
                        })
                      }
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors',
                        checked
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-accent'
                      )}
                    >
                      {checked ? (
                        <Check className="size-3" />
                      ) : (
                        <X className="size-3 opacity-40" />
                      )}
                      {tool.label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[0.65rem] text-muted-foreground">
                白名单外的工具不会挂给这个 Agent；写类工具还需要权限档允许。
              </p>
            </div>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSave({
                ...draft,
                name: draft.name.trim() || '未命名智能体',
                role: draft.role.trim(),
                ...(draft.modelId?.trim() ? { modelId: draft.modelId.trim() } : {})
              })
            }
          >
            {isNew ? '添加' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
