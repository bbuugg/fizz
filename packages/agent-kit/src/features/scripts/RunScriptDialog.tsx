"use client";

/**
 * 运行脚本对话框：选脚本 + 选主机，确认后在主区域开一条连到该主机的终端标签，
 * 脚本内容以**终端输入**的方式写进去（逐行回车，执行过程在终端里可见）。
 *
 * 实例**全 App 只有一个**（`ScriptRunHost`，挂在外壳顶层）：入口是脚本清单的卡片，
 * 谁都不自己渲染一份，只调 `openRunScriptDialog()`（见 `shared/lib/script-run.ts` 里为什么）。
 *
 * ## 每次运行都是**新开一条终端标签**（= 新建一条连接）
 *
 * 这是刻意保留的：从脚本清单发起意味着「我在管这批脚本」，目标主机要自己挑、执行现场
 * 要干净可辨 —— 复用某条正开着的终端会把两件事的输出搅在一起，也让人分不清脚本到底
 * 跑在哪台机器上。`openHostTab` 每次都生成新 seq、新 `TerminalPanel`、新会话。
 *
 * 想「不重连、在当前终端里立刻跑」的是**命令面板**那个入口：它在当前视图就是终端时
 * 就地写入（见 `features/scripts/run-script-command.ts`），根本不进这个对话框。
 *
 * 从 dogi 的 `features/scripts/RunScriptDialog.tsx` 平移，关键差别：
 * - dogi 是「连上主机后 `writeWhenReady`」，fizz 没有那条同步通道 —— 改成把脚本内容
 *   交给新开的终端标签（`tool.scriptInput`），由 `TerminalPanel` 在**终端就绪时写入一次**；
 * - 目标主机取自 `app.sshHosts`（SSH + 本地终端同一份清单）：SSH 走 `openHostTab`，
 *   本地终端走 `openLocalTerminalTab`，两者都把脚本内容带上。
 */
import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
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
import { openHostTab, openLocalTerminalTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { closeRunScriptDialog, useRunScriptRequest } from '@fizz/agent-kit/shared/lib/script-run'
import { hostSummary } from '@fizz/agent-kit/features/hosts/host-format'
import { scriptToTerminalInput } from '@fizz/agent-kit/features/scripts/script'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { HostConfig, LocalHostConfig, SshHostConfig } from '@fizz/contracts/types'

/** 保留当前选择；失效时用偏好值，再不行回退首项 */
function pickId(current: string, ids: string[], preferred?: string): string {
  if (current && ids.includes(current)) return current
  if (preferred && ids.includes(preferred)) return preferred
  return ids[0] ?? ''
}

export function RunScriptDialog({
  app,
  open,
  scriptId,
  onOpenChange
}: {
  app: AgentApp
  open: boolean
  /** 带预设脚本进入（清单行 / 编辑对话框点运行）：锁定该脚本并隐藏脚本下拉 */
  scriptId?: string
  onOpenChange: (open: boolean) => void
}) {
  /** 带预设脚本进入：锁定该脚本，不再做下拉预选 */
  const hasPreset = Boolean(scriptId)

  const [selectedScript, setSelectedScript] = useState('')
  const [selectedHost, setSelectedHost] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 预设脚本每次打开只应用一次，之后用户可自由改选 */
  const presetApplied = useRef(false)

  const effectiveScriptId = hasPreset ? scriptId : selectedScript

  useEffect(() => {
    if (!open) {
      presetApplied.current = false
      return
    }
    if (!hasPreset) {
      const preferred = presetApplied.current ? undefined : scriptId
      presetApplied.current = true
      setSelectedScript((cur) => pickId(cur, app.scripts.map((s) => s.id), preferred))
    }
    setError(null)
    setSelectedHost((cur) => pickId(cur, app.sshHosts.map((h) => h.id)))
  }, [open, scriptId, hasPreset, app.scripts, app.sshHosts])

  const script = app.scripts.find((s) => s.id === effectiveScriptId)
  const host = app.sshHosts.find((h) => h.id === selectedHost)
  const canRun = Boolean(script && host) && !running

  /**
   * 打开运行目标：SSH 主机 → 新开一条主机标签（= 新建连接）；
   * 本地终端 → 新开一条本机终端标签。两者都把脚本内容带上，由终端就绪时写入。
   *
   * 这里**不查有没有同主机的活终端**：从脚本清单发起就该是一条干净的新现场，
   * 理由见文件头「每次运行都是新开一条终端标签」。
   */
  const openTarget = (target: HostConfig, scriptInput: string): void => {
    if (target.kind === 'local') {
      const local = target as LocalHostConfig
      // 宿主本机终端：与当前项目无关（不取项目目录、不带项目 id）—— 脚本是「主机」侧的东西，
      // 与 AI 会话 / 项目是两条独立的线（见 `openLocalTerminalTab`）。
      openLocalTerminalTab({
        cwd: local.cwd ?? '',
        shellId: local.shellId ?? null,
        shellName: local.shellName,
        label: local.name,
        args: local.args,
        autoCommand: local.autoCommand,
        scriptInput
      })
      return
    }
    openHostTab(target as SshHostConfig, { scriptInput })
  }

  const handleRun = (): void => {
    if (!script || !host) return
    setRunning(true)
    setError(null)
    try {
      openTarget(host, scriptToTerminalInput(script.content))
      onOpenChange(false)
      toast.success(`已在「${host.name}」执行「${script.name}」`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(`运行失败：${msg}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>运行脚本</DialogTitle>
          <DialogDescription>
            选一台主机，脚本会逐行写进它的终端（执行过程在终端里可见）。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {/* 脚本 */}
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">脚本</span>
            {hasPreset ? (
              <div className="rounded-md border border-border/60 bg-secondary/40 px-3 py-1.5 text-sm text-foreground">
                {script ? script.name : '（脚本不存在）'}
              </div>
            ) : app.scripts.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有脚本，请先在主机侧栏新建。</p>
            ) : (
              <Select value={selectedScript} onValueChange={setSelectedScript}>
                <SelectTrigger variant="muted" className="w-full">
                  <SelectValue placeholder="选择脚本" />
                </SelectTrigger>
                <SelectContent>
                  {app.scripts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* 主机 */}
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">主机</span>
            {app.sshHosts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                还没有主机或终端，请先在主机侧栏用「+」添加。
              </div>
            ) : (
              <Select value={selectedHost} onValueChange={setSelectedHost}>
                <SelectTrigger variant="muted" className="w-full">
                  <SelectValue placeholder="选择主机" />
                </SelectTrigger>
                <SelectContent>
                  {app.sshHosts.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.kind === 'local' ? `${h.name}（本地终端）` : `${h.name}（${hostSummary(h)}）`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* 将执行 */}
          {script && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">将执行</span>
              <pre className="no-scrollbar max-h-32 overflow-auto rounded-md border border-border/60 bg-secondary/40 p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground select-text">
                {script.content}
              </pre>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canRun} onClick={handleRun}>
            <Play className="size-4" />
            连接并运行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 全局唯一的「运行脚本」对话框（外壳顶层挂一次）。
 *
 * 它只是个薄壳：把 `shared/lib/script-run.ts` 里的请求接到 `RunScriptDialog` 的
 * `open` / `scriptId` 上。**别在别处再渲染一份 `RunScriptDialog`** —— 弹窗是模态的，
 * 两份实例在「关一个、开另一个」的时序里容易把 body 的 `pointer-events` 收错。
 */
export function ScriptRunHost({ app }: { app: AgentApp }) {
  const request = useRunScriptRequest()
  return (
    <RunScriptDialog
      app={app}
      open={request.open}
      scriptId={request.scriptId}
      onOpenChange={(open) => {
        if (!open) closeRunScriptDialog()
      }}
    />
  )
}
