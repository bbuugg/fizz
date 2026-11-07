/**
 * 「添加远端工作区」弹窗：选一台 SSH 主机 + 填远端 POSIX 目录。
 *
 * 与本地目录那条路（系统目录框 / 服务端目录浏览器）的区别：目录在**另一台机器**上，
 * 只有服务端能用 SFTP 看到它。所以这里不做本地预检 —— 路径是否存在由
 * `POST /api/workspaces` 现探一次，失败原因（主机不可达 / 目录不存在）就地显示，
 * 用户改完路径直接重试，不必关掉弹窗。
 *
 * 「浏览」只是顺手给的一层：基于同一个 SFTP 列目录接口，不支持的服务器 / 没权限时
 * 报错留在面板里，手填路径永远可用。
 */
import { useEffect, useRef, useState } from 'react'
import { Folder, FolderUp, Loader2 } from 'lucide-react'
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
import { Label } from '@fizz/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fizz/ui/select'
import type { AgentWorkspace, SftpEntry } from '@fizz/contracts/agent-api'
import type { SshHostConfig } from '@fizz/contracts/types'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function RemoteWorkspaceDialog({
  app,
  open,
  onOpenChange,
  onCreated
}: {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功，带上新工作区（调用方据此选中它） */
  onCreated: (workspace: AgentWorkspace) => void
}) {
  const tr = useT()
  /** 只有 SSH 主机能承载远端目录（本机终端条目没有远端可言） */
  const sshHosts = app.sshHosts.filter((host): host is SshHostConfig => host.kind !== 'local')
  const [hostId, setHostId] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 目录浏览面板：只列目录（文件选了也不能当工作区根） */
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<SftpEntry[]>([])
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  /** 只认最后一次加载的回包（连续切目录时旧回包可能后到） */
  const browseSeq = useRef(0)

  // 每次打开都重置：别残留上次的主机 / 路径（与其它项目弹窗一致）
  useEffect(() => {
    if (!open) return
    const hosts = app.sshHosts.filter((host) => host.kind !== 'local')
    setHostId(hosts[0]?.id ?? '')
    setPath('')
    setName('')
    setBusy(false)
    setError(null)
    setBrowsing(false)
    setBrowsePath('')
    setBrowseEntries([])
    setBrowseError(null)
    // app 每帧都是新对象，不能进依赖；只在「打开」这一刻重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadDir = (dir: string): void => {
    if (!hostId) return
    const seq = ++browseSeq.current
    setBrowseBusy(true)
    setBrowseError(null)
    void app
      .sftpList(hostId, dir)
      .then((result) => {
        if (seq !== browseSeq.current) return
        setBrowsePath(result.path)
        setBrowseEntries(result.entries.filter((entry) => entry.isDir))
      })
      .catch((e: unknown) => {
        if (seq !== browseSeq.current) return
        setBrowseError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (seq === browseSeq.current) setBrowseBusy(false)
      })
  }

  const toggleBrowse = (): void => {
    if (browsing) {
      setBrowsing(false)
      return
    }
    setBrowsing(true)
    loadDir(path.trim().startsWith('/') ? path.trim() : '/')
  }

  const trimmedPath = path.trim()
  const pathLooksAbsolute = trimmedPath.startsWith('/')
  const canSubmit = !busy && !!hostId && pathLooksAbsolute

  const submit = (): void => {
    if (!canSubmit) return
    const api = app.api
    if (!api) {
      setError(tr('还没有连上服务端。'))
      return
    }
    setBusy(true)
    setError(null)
    void api
      .addWorkspace({
        path: trimmedPath,
        remote: { hostId },
        ...(name.trim() ? { name: name.trim() } : {})
      })
      .then(async (workspace) => {
        await app.refresh()
        setBusy(false)
        onOpenChange(false)
        onCreated(workspace)
      })
      .catch((e: unknown) => {
        setBusy(false)
        // 服务端已把「主机不可达 / 目录不存在 / 不是目录」翻成人话，原样展示
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr('添加远端工作区')}</DialogTitle>
          <DialogDescription>
            {tr('Agent 的文件读写与命令都在这台 SSH 主机上的目录里执行。会话历史仍保存在本机。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {sshHosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tr('还没有 SSH 主机：先在「主机」里添加一台，再回来选它。')}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>{tr('SSH 主机')}</Label>
                <Select value={hostId} onValueChange={setHostId} disabled={busy}>
                  <SelectTrigger>
                    <SelectValue placeholder={tr('选择一台主机')} />
                  </SelectTrigger>
                  <SelectContent>
                    {sshHosts.map((host) => (
                      <SelectItem key={host.id} value={host.id}>
                        {host.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="remote-workspace-path">{tr('远端目录（绝对路径）')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="remote-workspace-path"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/srv/app"
                    autoFocus
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit()
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy || !hostId}
                    onClick={toggleBrowse}
                  >
                    {browsing ? tr('收起') : tr('浏览')}
                  </Button>
                </div>
                {trimmedPath && !pathLooksAbsolute ? (
                  <p className="text-xs text-destructive">{tr('请填写以 / 开头的绝对路径。')}</p>
                ) : null}
              </div>

              {browsing ? (
                <div className="rounded-md border">
                  <div className="flex items-center gap-1 border-b px-1 py-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-xs"
                      disabled={browseBusy || browsePath === '/'}
                      onClick={() => loadDir(browsePath.replace(/\/[^/]+\/?$/, '') || '/')}
                    >
                      <FolderUp className="size-3.5" />
                      {tr('上一级')}
                    </Button>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {browsePath || '/'}
                    </span>
                    {browseBusy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                  </div>
                  <div className="max-h-40 overflow-auto py-1">
                    {browseError ? (
                      <p className="px-2 py-1 text-xs text-destructive">{browseError}</p>
                    ) : browseEntries.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        {browseBusy ? tr('正在读取…') : tr('这里没有子目录')}
                      </p>
                    ) : (
                      browseEntries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent"
                          onClick={() => {
                            setPath(entry.path)
                            loadDir(entry.path)
                          }}
                        >
                          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{entry.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="remote-workspace-name">{tr('项目名（可选）')}</Label>
                <Input
                  id="remote-workspace-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tr('留空 = 用目录名')}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                  }}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                {tr('首期远端工作区暂不支持 worktree、技能 / 项目规则注入与插件 / MCP / ACP；文件面板、终端、源码管理与 Agent 工具可用。')}
              </p>
            </>
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button data-dialog-dismiss="" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? tr('连接中…') : tr('添加')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}