/**
 * 「容器设置」弹窗：改**单个容器型项目**的内存 / CPU 上限。
 *
 * 为什么需要它：这两项只由 `docker run` 的 `--memory` / `--cpus` 决定，容器是「run 那一刻
 * 的形状」—— 改配置不会影响已经在跑的容器。所以这里必须把「怎么生效」摆到台面上：
 *
 * - **仅保存**：配置立刻落盘，容器继续按旧参数跑；下一次启动（关掉再打开 / 手动停掉再启动 /
 *   手动「重启容器」）时服务端用运行参数指纹发现对不上，自动删容器按新参数重建；
 * - **保存并重启**：保存后立刻走 `rebuildContainerProject`（停 → 删 → 起），几十秒到几分钟。
 *
 * 语义是「配置是权威、容器只是它的一个实例」，所以**不在这里偷偷重启** —— 用户可能正在
 * 跑一个长任务，打断的代价必须由他自己选。
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
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
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { CONTAINER_MEMORY_LIMIT_MIN_MB } from '@fizz/contracts/types'
import type { ContainerProjectsSnapshot } from '@fizz/contracts/types'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useStateValue } from '@fizz/agent-kit/shared/lib/state-ws'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'
import { limitsError } from '@fizz/agent-kit/features/projects/container-limits'

/** 边界常量与服务端共用（`@fizz/contracts/types`），这里只为提示文案 */
const MEMORY_MIN_MB = CONTAINER_MEMORY_LIMIT_MIN_MB

/**
 * 前端生成一个新预览 key（12 字节随机 → base64url，16 字符）。
 *
 * 不用 `crypto.randomUUID()`：桌面端渲染进程跑在 `file://` 下，不是 secure context，
 * 那个 API 在部分环境里直接不存在；`crypto.getRandomValues` 到处都有。
 * 字符集落在 `PREVIEW_KEY_PATTERN`（`[A-Za-z0-9_-]`）里，服务端会再校验一次形状。
 */
function randomPreviewKey(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function ContainerSettingsDialog({
  app,
  workspace,
  onOpenChange
}: {
  app: AgentApp
  /** 要设置的项目；`null` = 弹窗关闭 */
  workspace: AgentWorkspace | null
  onOpenChange: (open: boolean) => void
}) {
  /** 限额草稿：`null` = 空 = 不限制（落盘时转成 0，见 container-limits.ts） */
  const [memory, setMemory] = useState<number | null>(null)
  const [cpus, setCpus] = useState<number | null>(null)
  /** `'save' | 'restart'` = 正在提交（顶住连点，也顶住关弹窗） */
  const [busy, setBusy] = useState<'save' | 'restart' | null>(null)
  /** 预览 key 走本地状态：重新生成后立刻反映，不必等父组件拿到新引用 */
  const [previewKey, setPreviewKey] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  /** 容器现在的运行态：决定「保存并重启」能不能点、提示语怎么说 */
  const snapshot = useStateValue<ContainerProjectsSnapshot>('containerProjects', {
    available: false,
    projects: []
  })
  const project = workspace
    ? snapshot.projects.find((item) => item.workspaceId === workspace.id)
    : undefined
  const running = project?.state === 'running'
  const starting = project?.state === 'starting'
  /** 停止中（`docker stop` 的优雅退出窗口）：既不能算在跑，也不能算已停 */
  const stopping = project?.state === 'stopping'
  /** 出错时也允许「保存并重启」：重建正是把坏容器救回来的手段 */
  const canRestart = running || project?.state === 'error'

  /**
   * 每次**打开 / 换项目**都从落盘配置回填：`0` / 缺省 = 不限制 → 空输入框。
   *
   * 依赖只取 `workspace?.id`，并用 ref 记上一次的值：`workspace` 对象会随 state ws 刷新
   * 换新引用，直接拿它当依赖会在用户打字时把输入框冲掉；而同一项目关掉再打开（id 没变）
   * 也必须重新回填 —— 否则上次没保存的输入会留在框里。
   */
  const lastIdRef = useRef<string | null>(null)
  useEffect(() => {
    const id = workspace?.id ?? null
    if (id === lastIdRef.current) return
    lastIdRef.current = id
    if (!workspace?.container) return
    setMemory(
      workspace.container.memoryLimitMb && workspace.container.memoryLimitMb > 0
        ? workspace.container.memoryLimitMb
        : null
    )
    setCpus(
      workspace.container.cpus && workspace.container.cpus > 0 ? workspace.container.cpus : null
    )
    setPreviewKey(workspace.container.previewKey ?? '')
    setBusy(null)
    setRegenerating(false)
  }, [workspace?.id, workspace?.container])

  /** 空 = 0 = 不限制（服务端再归一化；显式发 0 是因为 JSON 会把 undefined 丢掉） */
  const memoryValue = memory ?? 0
  const cpusValue = cpus ?? 0
  const invalid = limitsError(memoryValue, cpusValue)

  const save = (restart: boolean): void => {
    if (!workspace || invalid || busy) return
    const api = app.api
    if (!api) {
      toast.error('还没有连接到服务端')
      return
    }
    setBusy(restart ? 'restart' : 'save')
    void (async () => {
      try {
        // `updateContainerProject` 失败时原因已经进了底部错误条，这里保持弹窗打开让用户改
        const ok = await app.updateContainerProject(workspace.id, {
          memoryLimitMb: memoryValue,
          cpus: cpusValue
        })
        if (!ok) return
        if (!restart) {
          toast.success(
            running ? '已保存，下次重启容器后生效' : '已保存，下次启动容器时生效'
          )
          onOpenChange(false)
          return
        }
        const { snapshot: next } = await api.rebuildContainerProject(workspace.id)
        const failure = next.projects.find((item) => item.workspaceId === workspace.id)?.error
        if (failure) toast.error(`容器没起来：${failure}`)
        else toast.success('已保存并重启容器')
        onOpenChange(false)
      } catch (err) {
        toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    })()
  }

  /** 换一把锁：立刻落盘（不碰容器），旧链接与旧 cookie 当场失效 */
  const regenerateKey = (): void => {
    if (!workspace || busy || regenerating) return
    if (!app.api) {
      toast.error('还没有连接到服务端')
      return
    }
    const next = randomPreviewKey()
    setRegenerating(true)
    void (async () => {
      try {
        const ok = await app.updateContainerProject(workspace.id, { previewKey: next })
        if (!ok) return
        setPreviewKey(next)
        toast.success('预览 key 已更新，旧链接立刻失效')
      } finally {
        setRegenerating(false)
      }
    })()
  }

  const copyKey = (): void => {
    if (!previewKey) return
    void writeClipboard(previewKey)
      .then(() => toast.success('预览 key 已复制'))
      .catch(() => toast.error('复制失败，请手动选中复制'))
  }

  return (
    <Dialog
      open={workspace !== null}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>容器设置{workspace ? ` · ${workspace.name}` : ''}</DialogTitle>
          <DialogDescription>
            限制这个项目容器能用的内存与 CPU。留空 = 不限制（用宿主机的全部资源）。
            <br />
            这两项只在容器创建时生效：改完选「仅保存」不会打断正在跑的容器，下次启动自动按新配置重建；
            选「保存并重启」会立刻停掉并重建容器，正在跑的会话会中断（<span className="font-mono">/workspace</span> 里的项目文件不受影响）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="container-memory-limit">内存上限（MB）</Label>
              {/*
                不传 min/max：这里 0 也算合法（= 不限制），边界由 `limitsError` 说人话。
                传 min 会把 0 标红，跟底下的提示自相矛盾。
              */}
              <NumberField
                variant="muted"
                id="container-memory-limit"
                step={64}
                value={memory}
                placeholder="不限制"
                disabled={busy !== null}
                autoFocus
                onValueChange={setMemory}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="container-cpu-limit">CPU 上限（核）</Label>
              <NumberField
                variant="muted"
                id="container-cpu-limit"
                integer={false}
                step={0.1}
                value={cpus}
                placeholder="不限制"
                disabled={busy !== null}
                onValueChange={setCpus}
              />
            </div>
          </div>

          {invalid ? (
            <p className="text-xs text-destructive">{invalid}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              例：内存 2048（2 GB）、CPU 1.5（一个半核）。内存不要小于 {MEMORY_MIN_MB} MB，
              否则镜像里的运行时基本起不来。
            </p>
          )}

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="container-preview-key">预览 key</Label>
            <div className="flex items-center gap-2">
              <Input
                variant="muted"
                id="container-preview-key"
                value={previewKey}
                readOnly
                placeholder="还没有预览 key"
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!previewKey}
                onClick={copyKey}
                title="复制预览 key"
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || regenerating}
                onClick={regenerateKey}
                title="换一个 key：已经拿到旧链接的人立刻打不开"
              >
                {regenerating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                重新生成
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">未对外发布</span>时，公网访问预览要带上它（应用内预览会自动带）；
              对外发布后不再校验。把带 key 的链接发给别人 = 私密分享。
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            {starting
              ? '容器正在启动，稍后才能重启；现在保存会在下次启动时生效。'
              : stopping
                ? '容器正在停止，等它退干净才能重启；现在保存会在下次启动时生效。'
                : running
                  ? '容器正在运行：选「仅保存」不会打断它。'
                  : project?.state === 'error'
                    ? '容器当前是错误状态：选「保存并重启」可以按新配置重建它。'
                    : '容器当前没在运行，下次启动时会自动按新配置创建。'}
          </p>

          {project?.pendingRestart ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              有改动尚未生效：容器仍按上次创建时的参数运行，下次启动时会自动按新配置重建。
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" disabled={busy !== null} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="secondary" disabled={!!invalid || busy !== null} onClick={() => save(false)}>
            {busy === 'save' ? <Loader2 className="size-4 animate-spin" /> : null}
            仅保存
          </Button>
          <Button
            disabled={!!invalid || busy !== null || !canRestart}
            onClick={() => save(true)}
            title={canRestart ? undefined : '容器没在运行，保存后下次启动即生效'}
          >
            {busy === 'restart' ? <Loader2 className="size-4 animate-spin" /> : null}
            保存并重启
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
