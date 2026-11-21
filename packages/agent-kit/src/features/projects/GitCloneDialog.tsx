/**
 * 「从 Git 导入」弹窗：输入仓库地址 + 选克隆到的父目录 + 可选目录名，
 * 服务端 `git clone` 完直接登记成项目。
 *
 * 父目录走 `useDirectoryPicker`：桌面端弹**系统目录框**（后端就跑在本进程里，跟 clone 的
 * 落点是同一台机器），web 才叠一层内置的服务端目录浏览器（Radix portal 自然堆叠，没问题）。
 *
 * 克隆可能跑几分钟（大仓库慢网），所以**不能把人钉在这张弹窗上**，两条路都给：
 * - **取消**：`app.cancelBackgroundTask(cloneId)` —— 服务端杀掉 git 进程树、删掉克隆了一半
 *   的目录，回包时清理已经做完，可以立刻重试；
 * - **转到后台**：`app.detachBackgroundTask(cloneId)` —— 只是「人不等了」，git 继续跑，
 *   进度落到状态栏那张任务清单里（`BackgroundTasksBadge`），跑完还能从那儿打开新项目。
 *
 * 两条都走显式请求而不是断连接：desktop 的 IPC 桥不转发 AbortSignal，断也停不住服务端的
 * 进程（详见 contracts 里 `WorkspaceCloneInput.cloneId` 的注释）。
 *
 * 取消后弹窗**留在原地、输入还在**：多半是地址写错了，重填一遍比重开一次省事。
 */
import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Button } from '@fizz/ui/button'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { Input } from '@fizz/ui/input'
import { useDirectoryPicker } from '@fizz/agent-kit/shared/hooks/use-directory-picker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'

/** 与服务端 `repoNameFromUrl` 同源的目录名推导（预览用；真值以服务端为准） */
function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  return cleaned.split(/[/:]/).filter(Boolean).pop() ?? ''
}

/** 取消句柄：`crypto.randomUUID` 在老 WebView 里可能没有，兜一个不依赖安全上下文的 */
function newCloneId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `clone-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function GitCloneDialog({
  app,
  open,
  onOpenChange,
  onCloned
}: {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 克隆并登记成功，带上新项目（调用方据此选中 / 收尾） */
  onCloned: (workspace: AgentWorkspace) => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  /** 克隆到的父目录（**服务端**绝对路径；仓库是服务端在 clone，不是本机） */
  const [parentDir, setParentDir] = useState('')
  const [busy, setBusy] = useState(false)
  /** 正在取消：等服务端杀进程 + 删目录的那一下，防重复点、也防表单提前解锁 */
  const [canceling, setCanceling] = useState(false)
  /**
   * 本次克隆的句柄。取消 / 结束就置空 —— 它同时是「回来的结果还属不属于当前这趟」的判据：
   * 旧的 clone 请求可能在我们取消之后才回来，绝不能让它把新一轮的 busy 清掉。
   */
  const tr = useT()
  const cloneIdRef = useRef<string | null>(null)

  /**
   * 选克隆的父目录。桌面端弹系统目录框（服务端就在本进程里，指的是同一台机器），
   * web 才用内置的服务端目录浏览器 —— 见 `useDirectoryPicker`。
   */
  const { pick, node: dirPicker } = useDirectoryPicker(
    app,
    tr('这里列的是服务端上的目录。仓库会被克隆到选中的目录里。')
  )

  /** 选父目录，选完回填（取消 → `null`，保持原值） */
  const pickParentDir = (): void => {
    void pick().then((dir) => {
      if (dir) setParentDir(dir)
    })
  }

  // 每次打开都重置：别残留上次的输入（克隆目标 / 地址是低频操作，重来一遍不心疼）
  useEffect(() => {
    if (!open) return
    setUrl('')
    setName('')
    setParentDir('')
    setBusy(false)
    setCanceling(false)
    cloneIdRef.current = null
  }, [open])

  const trimmedUrl = url.trim()
  const dirName = name.trim() || repoNameFromUrl(trimmedUrl)
  // Windows / POSIX 都不允许的目录字符，提前拦（服务端还有同一道校验）
  const nameOk = !!dirName && !/[\\/:*?"<>|]/.test(dirName) && dirName !== '.' && dirName !== '..'
  const canSubmit = !!trimmedUrl && !trimmedUrl.startsWith('-') && !!parentDir && nameOk && !busy
  const destPreview = parentDir && nameOk ? `${parentDir.replace(/[\\/]+$/, '')}/${dirName}` : ''

  const submit = (): void => {
    if (!canSubmit) return
    const cloneId = newCloneId()
    cloneIdRef.current = cloneId
    setBusy(true)
    void app
      .cloneWorkspace({
        url: trimmedUrl,
        parentDir,
        cloneId,
        ...(name.trim() ? { name: name.trim() } : {})
      })
      .then((workspace) => {
        // 已被取消 / 已被新一趟取代：这趟的收尾不归它管（busy 由 cancel() 那边收）
        if (cloneIdRef.current !== cloneId) return
        cloneIdRef.current = null
        setBusy(false)
        if (!workspace) return // 失败：原因已进 app.error（底部错误条），弹窗留着让用户改
        onOpenChange(false)
        onCloned(workspace)
      })
  }

  /**
   * 取消这一趟克隆。
   *
   * 先置空句柄再发请求：这样即使在途的克隆请求**先**回来，也不会被当成成功去关闭弹窗 /
   * 选中项目。`cancelBackgroundTask` 自己吞掉错误且回包时服务端已清理干净，所以这里只管收尾 UI。
   */
  const cancel = (): void => {
    const cloneId = cloneIdRef.current
    if (!cloneId) return
    cloneIdRef.current = null
    setCanceling(true)
    void app.cancelBackgroundTask(cloneId).then(() => {
      setCanceling(false)
      setBusy(false)
    })
  }

  /**
   * 转到后台：**人不等了，活继续干**。
   *
   * 弹窗立刻关掉、`detach` 让那条等待中的请求马上收包（回 `{ detached: true }`，store 那边
   * 当正常结局处理）；克隆本体还在服务端跑，进度和结果在状态栏的任务清单里。
   */
  const moveToBackground = (): void => {
    const cloneId = cloneIdRef.current
    if (!cloneId) return
    cloneIdRef.current = null
    setBusy(false)
    onOpenChange(false)
    void app.detachBackgroundTask(cloneId)
  }

  /** 关闭：克隆中点关闭等于**取消**（不让用户被一个没有出口的弹窗困住） */
  const requestClose = (next: boolean): void => {
    if (next) {
      onOpenChange(true)
      return
    }
    if (busy) {
      cancel()
      return
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr('从 Git 导入项目')}</DialogTitle>
          <DialogDescription>
            {tr('在跑 Agent 的服务器上克隆仓库，克隆完成自动登记成项目。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">{tr('仓库地址')}</span>
            <Input
              variant="muted"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={tr('https://github.com/owner/repo.git 或 git@host:owner/repo.git')}
              autoFocus
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">{tr('克隆到（父目录）')}</span>
            <div className="flex gap-2">
              <Input
                variant="muted"
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                placeholder={tr('服务端上的绝对路径，如 /home/me/projects')}
                disabled={busy}
              />
              <Button
                variant="outline"
                className="shrink-0"
                disabled={busy}
                onClick={pickParentDir}
              >
                <FolderOpen className="size-4" />
                {tr('浏览')}
              </Button>
            </div>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">{tr('目录名（可选，缺省取仓库名）')}</span>
            <Input
              variant="muted"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={repoNameFromUrl(trimmedUrl) || 'repo'}
              disabled={busy}
            />
          </label>

          {/* 最终落点预览：用户要清楚知道东西会克隆到哪 */}
          {destPreview && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 break-all text-muted-foreground">
              {tr('将克隆到')}{' '}
              <span className="font-mono text-foreground">{destPreview}</span>
            </div>
          )}

          {/* 克隆中给一句「可以走」的明确提示：大仓库几分钟很正常，别让人以为卡死了 */}
          {busy && (
            <p className="text-xs leading-5 text-muted-foreground">
              {canceling
                ? tr('正在取消：停掉 git 并清理已下载的内容…')
                : tr('正在克隆，大仓库可能要几分钟。可以取消，也可以转到后台让它继续跑。')}
            </p>
          )}
        </div>

        <DialogFooter>
          {/*
            忙碌时是「取消 + 转到后台」两颗：这两个是**不同**的决定（活别干了 / 人不等了），
            不能合并成一个关闭动作 —— 关弹窗的默认语义选了「取消」，因为那是更安全的一种。
            闲置时回到常规的「取消 / 克隆并导入」。
          */}
          {busy ? (
            <>
              <Button data-dialog-dismiss="" variant="ghost" disabled={canceling} onClick={cancel}>
                {canceling ? <Loader2 className="size-4 animate-spin" /> : null}
                {tr('取消克隆')}
              </Button>
              <Button variant="outline" disabled={canceling} onClick={moveToBackground}>
                {tr('转到后台')}
              </Button>
            </>
          ) : (
            <>
              <Button data-dialog-dismiss="" variant="ghost" onClick={() => onOpenChange(false)}>
                {tr('取消')}
              </Button>
              <Button disabled={!canSubmit} onClick={submit}>
                {tr('克隆并导入')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      {/* 选父目录：桌面端是系统框（这里为 null），web 才是内置的服务端目录浏览器 */}
      {dirPicker}
    </Dialog>
  )
}
