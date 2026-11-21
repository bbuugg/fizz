/**
 * 「新建容器型项目」弹窗。
 *
 * 与「从 Git 导入」「新建 worktree」的关键差别：**目录不可自定义**。这类项目的目录由
 * 服务端在固定的容器项目根下按随机 slug 生成（`<容器项目根>/<12 位 slug>`），用户能定的
 * 只有「叫什么、用哪个运行环境、预览服务在容器内听哪个端口、要不要顺带 clone 一个仓库」。
 * 所以这个弹窗里**没有**任何目录选择器 —— 有的话就是在骗用户。
 *
 * 运行环境（镜像）来自 `CONTAINER_ENV_IMAGES`，**手动选、不做 AI 自动匹配**（spec 的口径）：
 * 建议端口随所选项自动填进占位符，用户不填就表示「这个项目不支持预览」。
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { NumberField } from '@fizz/ui/number-field'
import { Label } from '@fizz/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fizz/ui/select'
import { CONTAINER_ENV_IMAGES } from '@fizz/contracts/types'
import type { ContainerEnvId } from '@fizz/contracts/types'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { limitsError } from '@fizz/agent-kit/features/projects/container-limits'

export function NewContainerProjectDialog({
  app,
  open,
  onOpenChange,
  onCreated
}: {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功，带上新项目（调用方据此选中它） */
  onCreated: (workspace: AgentWorkspace) => void
}) {
  const [name, setName] = useState('')
  const [image, setImage] = useState<ContainerEnvId>(CONTAINER_ENV_IMAGES[0].id)
  const [gitUrl, setGitUrl] = useState('')
  /** 资源限额（可选，空 = 不限制）：与「容器设置」同一套边界，见 container-limits.ts */
  const [memory, setMemory] = useState<number | null>(null)
  const [cpus, setCpus] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 每次打开都重置：别残留上次的输入（低频操作，重来一遍不心疼，与 GitCloneDialog 一致）
  useEffect(() => {
    if (!open) return
    setName('')
    setImage(CONTAINER_ENV_IMAGES[0].id)
    setGitUrl('')
    setMemory(null)
    setCpus(null)
    setBusy(false)
  }, [open])

  const selected = CONTAINER_ENV_IMAGES.find((img) => img.id === image)
  /** 空 = 0 = 不限制（显式发 0，JSON 会把 undefined 丢掉） */
  const memoryValue = memory ?? 0
  const cpusValue = cpus ?? 0
  const invalid = limitsError(memoryValue, cpusValue)
  const canSubmit = !busy && !invalid

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    void app
      .createContainerProject({
        image,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
        // 0 = 不限制：显式发出去，别让「留空」变成 undefined 被 JSON 丢掉
        memoryLimitMb: memoryValue,
        cpus: cpusValue
      })
      .then((workspace) => {
        setBusy(false)
        // 失败时不关弹窗：服务端的原因已经进了底部错误条，用户可以直接改了再提交
        if (!workspace) return
        onOpenChange(false)
        onCreated(workspace)
      })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建容器型项目</DialogTitle>
          <DialogDescription>
            项目目录由服务端在固定位置生成（不可自定义）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="container-project-name">名称（可选）</Label>
            <Input
              variant="muted"
              id="container-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="缺省用自动生成的目录名"
              autoFocus
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>运行环境</Label>
            <Select
              value={image}
              onValueChange={(v) => setImage(v as ContainerEnvId)}
              disabled={busy}
            >
              <SelectTrigger variant="muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTAINER_ENV_IMAGES.map((img) => (
                  <SelectItem key={img.id} value={img.id}>
                    {img.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/*
            ⚠️ 这里**没有**「预览端口」输入框：用户拿到的是一条域名，端口是「框架监听哪个」
            这种内部细节。服务端按镜像自动定（见 `CONTAINER_ENV_IMAGES[].suggestedPreviewPort`），
            宿主侧映射端口每次启动重新分配，域名始终按 slug 现查当前映射。
          */}

          {/*
            资源限额（可选）：留空 = 不限制（`--memory` / `--cpus` 只在给了正数时才加）。
            创建后还能在项目「更多 → 容器设置」里改，那两处共用 `container-limits.ts` 的边界。
          */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="container-project-memory">内存上限（MB，可选）</Label>
              {/* 不传 min/max：0 也算合法（= 不限制），边界由 `limitsError` 说人话 */}
              <NumberField
                variant="muted"
                id="container-project-memory"
                step={64}
                value={memory}
                placeholder="不限制"
                disabled={busy}
                onValueChange={setMemory}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="container-project-cpus">CPU 上限（核，可选）</Label>
              <NumberField
                variant="muted"
                id="container-project-cpus"
                integer={false}
                step={0.1}
                value={cpus}
                placeholder="不限制"
                disabled={busy}
                onValueChange={setCpus}
              />
            </div>
          </div>
          {invalid ? <p className="text-xs text-destructive">{invalid}</p> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="container-project-git">Git 地址（可选）</Label>
            <Input
              variant="muted"
              id="container-project-git"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="创建后在服务端克隆到项目目录里"
              disabled={busy}
            />
          </div>
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
