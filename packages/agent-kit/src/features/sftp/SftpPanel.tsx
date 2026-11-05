/**
 * SFTP 文件管理页（主区域标签）：浏览 / 管理远程主机的文件系统。
 *
 * 移植自 dogi 的 `features/sftp/SftpPage`，但**连接模型整个换了**，其余交互照搬：
 *
 * - dogi 在 Electron 主进程里跑，渲染端按「一个标签一个 connId」主动 open / close；
 *   这里 SSH 连接在**服务端**，且是**按 hostId 池化**的（见 `server/ssh/sftp.ts`）——
 *   页面不再管连接生命周期，每个操作用 hostId 直接打一条 HTTP 就行。少了一整类
 *   「标签关了、连接没关」的漏。
 * - dogi 的下载 / 上传要弹**系统对话框**（另存为 / 选文件），因为主进程能碰到本地磁盘；
 *   这里服务端很可能跟浏览器不在同一台机器上，**它看不见用户的本地路径** ——
 *   下载是「服务端回字节 → 渲染端触发浏览器另存为」，上传是「渲染端读文件成 base64 → 发上去」。
 *
 * ## 能力
 *
 * 浏览 / 进入目录 / 返回上级 / 跳转路径 / 刷新 / 新建文件夹 / 上传文件（多选）/
 * 下载（文件 / 整个文件夹递归）/ 复制到 / 移动到 / 重命名 / 删除（目录递归）/ 多选批量操作。
 *
 * ## 与 dogi 的两处刻意收敛
 *
 * 1. **页内不画传输进度条**：上传 / 下载一律交给模块级引擎（`file-transfer/engine.ts`），
 *    进度、速度、取消都在**状态栏那颗 `TransferBadge`** 里（与「后台任务」同一个位置）。
 *    面板关掉、切到别的标签，传输照样跑、照样看得见 —— 页内再画一条只会变成第二份真相。
 * 2. **复制 / 移动不可取消**：它们要么是一次瞬时 rename，要么是一段没有用户可感知进度的
 *    远端复制。只有上传带取消（大文件真的会卡在那里），走 `sftpAbort`。
 *
 * ## 刷新语义（两档，别混）
 *
 * - **连接那一下**（`connect`）：`/` 列目录 + realpath 兜底，整块换成「正在连接 xxx…」。
 *   只在**首次挂载 / 换主机 / 点重试**时发生，由 `connect` 的稳定引用保证。
 * - **列表刷新**（`load(dir, { silent: true })`）：上传完成、新建 / 重命名 / 删除 /
 *   移动之后走这条 —— 不碰 `loading`、失败不换错误页，数据回来原地换行。
 *   进入目录 / 手动刷新才用非静默，那时候「行变淡 + 图标转」是应有的反馈。
 *
 * ⚠️ 这个页面**不能**把 `app` 写进 effect / useCallback 依赖：`app` 每次渲染都是新对象，
 * 后果就是「列表每隔几秒自己刷新一次、还把人顶回根目录」。`app` 一律经 `appRef` 读。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowRightLeft,
  ArrowUp,
  ChevronDown,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Checkbox } from '@fizz/ui/checkbox'
import { Input } from '@fizz/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { runDownload, runUpload } from '@fizz/agent-kit/shared/lib/file-transfer/engine'
import { createBlobSink } from '@fizz/agent-kit/shared/lib/file-transfer/sink'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { joinSftpPath, normalizeSftpPath } from '@fizz/agent-kit/shared/lib/sftp-path'
import type { SftpEntry } from '@fizz/contracts/agent-api'
import type { SshHostConfig } from '@fizz/contracts/types'

/** 字节数的可读展示 */
function formatSize(n: number): string {
  if (!n) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 远端时间戳 → 本地可读时间 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

export function SftpPanel({ host }: { host: SshHostConfig }): React.JSX.Element {
  const { app } = useAppContext()

  /**
   * `app` 的**最新值**的 ref —— 只给 `load` 与「初次连接」那个 effect 读。
   *
   * ⚠️ `app` 对象每次渲染都是新的（见 AGENTS.md）。只要把它写进 `useEffect` /
   * `useCallback` 的依赖数组，上层每重渲染一次（流式期间每个 token 一次）就会：
   * 重新跑「初次连接」→ `setConnecting(true)` + 从 `/` 重列目录 → 用户正看着的
   * 目录被顶回根目录、整页闪一下「正在连接 xxx」。这不是「自动刷新」，
   * 是**依赖数组写错导致的重复初始化**。ref 让 `load` 只随 `host.id` 变化。
   */
  const appRef = useRef(app)
  appRef.current = app

  const [path, setPath] = useState('/')
  const [pathInput, setPathInput] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [connecting, setConnecting] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 弹窗状态：新建文件夹 / 重命名 / 删除确认 / 复制或移动的目标目录 */
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renaming, setRenaming] = useState<SftpEntry | null>(null)
  const [renameText, setRenameText] = useState('')
  const [pendingRemove, setPendingRemove] = useState<SftpEntry[] | null>(null)
  const [targetOp, setTargetOp] = useState<{ entries: SftpEntry[]; mode: 'move' | 'copy' } | null>(
    null
  )
  const [targetDir, setTargetDir] = useState('')

  /** 多选：选中的远端路径集合（entries 刷新后自动剔除已不存在的项） */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** Shift 范围选的锚点 */
  const anchorRef = useRef<string | null>(null)

  /**
   * 本主机有上传在跑 —— 顶住改造前「上传中禁用上传按钮」的行为。
   *
   * 页内进度 state 已经撤掉，但「同一台主机不要并发刷连接」这条**不能跟着丢**。
   * 选择器只回一个 boolean：store 每 patch 一次进度都会重算 `.some`（一片 4MB，频率很低），
   * 结果不变时 zustand 不会触发重渲染。
   */
  const uploading = useAgentStore((s) =>
    s.transfers.some((t) => t.kind === 'upload' && t.status === 'active' && t.hostId === host.id)
  )

  /** 挂载标记：防止异步回包写到已卸载的组件上 */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** 请求序号：只认最后一次发出的 `load` 的回包，先发后到的旧回包直接丢掉 */
  const seqRef = useRef(0)

  /**
   * 列目录。
   *
   * `opts.silent` = **静默刷新**：不动 `loading`，也不在失败时把整页换成错误页 ——
   * 上传完成、新建 / 重命名 / 删除 / 移动之后都走这条路。用户要的是「列表还是列表」：
   * 数据回来就原地替换行，回来之前界面上什么都不跳。
   *
   * 非静默（手动刷新、进入目录、跳转路径）才给 `loading`：那几处是用户主动发起的，
   * 行变淡 + 刷新图标转起来是**应有的**反馈，不是噪声。
   *
   * 失败：静默刷新用 toast 报错并**保留现有列表**（把已经看得到的目录换成一屏红字，
   * 比报错本身更难受）；非静默仍然走错误页，那一屏本来就没有可信内容。
   */
  const load = useCallback(
    async (dir: string, opts?: { silent?: boolean }): Promise<boolean> => {
      const silent = opts?.silent === true
      const seq = ++seqRef.current
      if (!silent) setLoading(true)
      try {
        const result = await appRef.current.sftpList(host.id, dir)
        // 已经卸载，或者后面又发了一次（回包顺序不保证），丢弃这次结果
        if (!aliveRef.current || seq !== seqRef.current) return true
        setEntries(result.entries)
        setPath(result.path)
        setPathInput(result.path)
        setError(null)
        return true
      } catch (e) {
        if (!aliveRef.current || seq !== seqRef.current) return true
        const message = e instanceof Error ? e.message : String(e)
        if (silent) toast.error('刷新列表失败：' + message)
        else setError(message)
        return false
      } finally {
        // ⚠️ 这里**不看** `silent`：静默刷新可能把前面那次非静默请求顶掉（seq 变了），
        // 若只在非静默分支清 `loading`，那个 loading 就永远停在 true（行一直发灰、
        // 刷新图标一直转）。谁最后落地谁负责收尾。
        if (aliveRef.current && seq === seqRef.current) setLoading(false)
      }
    },
    [host.id]
  )

  // entries 变化后：剔除已不存在的选中项（删除 / 移动走后列表里就没有了）
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(entries.filter((e) => prev.has(e.path)).map((e) => e.path))
      return valid.size === prev.size ? prev : valid
    })
  }, [entries])

  /**
   * 建立连接（= 列一次目录）：
   * 先试 `/`；win32-openssh 的默认目录是盘符风格路径（/C:/…），只在 readdir 失败时
   * 改用 realpath('.') 拿准工作目录再试一次。
   *
   * 这整段只跟 `host.id` 有关，所以引用是稳定的 —— 「重试」按钮与初次连接共用同一份逻辑。
   */
  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    const ok = await load('/')
    if (!aliveRef.current) return
    if (!ok) {
      try {
        const home = normalizeSftpPath(await appRef.current.sftpRealpath(host.id))
        await load(home)
      } catch {
        // realpath 也失败：保留 `/` 那次的错误提示（load 内部已 setError）
      }
    }
    if (aliveRef.current) setConnecting(false)
  }, [host.id, load])

  /**
   * 连接那一下。
   *
   * ⚠️ 依赖只有 `connect`（它自己只依赖 `host.id`）：这个 effect 是**连接建立**，
   * 不能再被渲染次数触发。之前它依赖 `app`，上层每重渲染一次就会把列表顶回
   * 根目录并闪一遍「正在连接 xxx」——用户看到的就是「列表老是自动刷新」。
   */
  useEffect(() => {
    // 同一实例挂到另一台主机上：先把上一台的内容清掉，别在连接页背后留着旧列表
    setEntries([])
    setPath('/')
    setPathInput('/')
    void connect()
  }, [connect])

  /** 进入目录（仅目录）；文件无操作 */
  const enter = (entry: SftpEntry): void => {
    if (entry.isDir && !error) void load(entry.path)
  }

  const goUp = (): void => {
    if (path === '/' || error) return
    const idx = path.lastIndexOf('/')
    void load(idx <= 0 ? '/' : path.slice(0, idx))
  }

  const submitPath = (): void => {
    const target = normalizeSftpPath(pathInput)
    if (target !== path && !error) void load(target)
  }

  const refresh = (): void => {
    if (!error) void load(path)
  }

  const submitMkdir = async (): Promise<void> => {
    const name = mkdirName.trim()
    if (!name) return
    try {
      await app.sftpMkdir(host.id, joinSftpPath(path, name))
      setMkdirOpen(false)
      setMkdirName('')
      toast.success('已创建文件夹')
      // 静默刷新：新目录回来时原地多一行，不闪 loading
      void load(path, { silent: true })
    } catch (e) {
      toast.error('创建失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const submitRename = async (): Promise<void> => {
    const entry = renaming
    const name = renameText.trim()
    if (!entry || !name || name === entry.name) {
      setRenaming(null)
      return
    }
    try {
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
      await app.sftpRename(host.id, entry.path, joinSftpPath(parent, name))
      setRenaming(null)
      void load(path, { silent: true })
    } catch (e) {
      toast.error('重命名失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const confirmRemove = async (): Promise<void> => {
    const items = pendingRemove
    if (!items) return
    setPendingRemove(null)
    const dirs = items.filter((i) => i.isDir)
    const files = items.length - dirs.length
    try {
      for (const entry of items) {
        await app.sftpRemove(host.id, entry.path)
      }
      toast.success(
        `已删除 ${items.length} 项` +
          (dirs.length ? `（含 ${dirs.length} 个文件夹）` : '') +
          (files ? `（含 ${files} 个文件）` : '')
      )
      void load(path, { silent: true })
    } catch (e) {
      toast.error('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * 下载单个远端文件。
   *
   * 分片拉取 + 落盘全交给 `runDownload`（进度 / 取消 / 失败都在传输徽标里显示），
   * 这里**不**再自己 toast 结果 —— 清单就是那个入口，两个地方各报一次只会重复。
   * `size` 直接取列表项里的 `SftpEntry.size`，不为它多发一次 stat。
   */
  const download = (entry: SftpEntry): void => {
    void runDownload({
      hostId: host.id,
      hostLabel: host.name,
      path: entry.path,
      name: entry.name,
      size: entry.size
    })
  }

  /**
   * 递归下载整个远端文件夹（逐文件走 `runDownload`）。
   *
   * ⚠️ 浏览器不能「一次另存为一个目录」，所以这里是**逐文件**下载 + 在本地按相对路径
   * 重命名 —— 浏览器会把每个文件都丢进下载目录（子目录名拼进文件名），用户拿到的是
   * 「文件夹名/子路径/文件名」这种扁平结构。这与 dogi 的 `showSaveDialog` 选目录后落盘
   * 不是一个体验，但 web 形态下没有更好的办法（File System Access API 在局域网 http 下
   * 不可用）。
   *
   * ⚠️ **显式传 `sink`（`createBlobSink`）**：不传的话 `createSink` 会给**每个文件**弹一次
   * 保存框 / 文件选择器 —— 50 个文件要点 50 次。文件夹下载保持「浏览器自己往下载目录里
   * 放」的老行为。
   *
   * ⚠️ 逐文件**串行**（`for` + `await`），与改造前一致：避免对同一台主机并发刷连接。
   */
  const downloadDir = (entry: SftpEntry): void => {
    void (async () => {
      const count = { ok: 0, fail: 0 }
      const walk = async (remotePath: string, relPrefix: string): Promise<void> => {
        let list: SftpEntry[]
        try {
          list = (await app.sftpList(host.id, remotePath)).entries
        } catch (e) {
          count.fail += 1
          toast.error(`读取 ${relPrefix || remotePath} 失败：${e instanceof Error ? e.message : e}`)
          return
        }
        for (const child of list) {
          const rel = relPrefix ? `${relPrefix}/${child.name}` : child.name
          if (child.isDir) {
            await walk(child.path, rel)
            continue
          }
          const flatName = `${entry.name}-${rel.replace(/\//g, '_')}`
          // 失败 / 取消的原因都在清单那一条里，这里只按终态统计个数
          const outcome = await runDownload({
            hostId: host.id,
            hostLabel: host.name,
            path: child.path,
            name: flatName,
            size: child.size,
            sink: async () => createBlobSink(flatName)
          })
          if (outcome === 'done') count.ok += 1
          else count.fail += 1
        }
      }
      toast.info(`开始下载文件夹「${entry.name}」…`)
      await walk(entry.path, '')
      if (!aliveRef.current) return
      if (count.ok) toast.success(`文件夹「${entry.name}」已下载 ${count.ok} 个文件`)
      else if (!count.fail) toast.info(`文件夹「${entry.name}」是空的`)
    })()
  }

  /** 打开「复制 / 移动到…」弹窗，目标目录默认当前目录（支持批量） */
  const openTargetOp = (items: SftpEntry[], mode: 'move' | 'copy'): void => {
    setTargetDir(path)
    setTargetOp({ entries: items, mode })
  }

  /** 确认复制 / 移动：to = targetDir + entry.name（同名会被覆盖） */
  const submitTargetOp = async (): Promise<void> => {
    const op = targetOp
    if (!op) return
    const dir = targetDir.trim()
    if (!dir) return
    setTargetOp(null)
    let lastErr: string | undefined
    for (const entry of op.entries) {
      const to = joinSftpPath(dir, entry.name)
      try {
        if (op.mode === 'move') await app.sftpMove(host.id, entry.path, to)
        else await app.sftpCopy(host.id, entry.path, to)
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (lastErr) {
      toast.error(`${op.mode === 'move' ? '移动' : '复制'}失败：` + lastErr)
    } else {
      toast.success(
        `已${op.mode === 'move' ? '移动' : '复制'} ${op.entries.length} 项到 ${dir}`
      )
    }
    setSelected(new Set())
    void load(path, { silent: true })
  }

  /**
   * 上传本地文件到当前远端目录（逐文件串行）。
   *
   * 分片、进度、失败原因全交给 `runUpload`，结果一律显示在状态栏的传输徽标里 —— 面板里
   * **没有**页内进度条了，也不在这里 toast 成败（两个地方各报一次只会重复）。
   *
   * ⚠️ 逐文件**串行**（`for` + `await`，**不是** `Promise.all`）：同一台主机并发刷连接
   * 没有好处，而分片本身已经是串行的，并发只会互相抢带宽。
   *
   * ⚠️ 取消现在是**按条**的（`TransferBadge` 清单里每行一个 ✕）：取消一个文件不会中断
   * 这一批剩下的文件。页内那条「取消整批」的通道随进度条一起撤掉了，徽标里也没有
   * 「全部取消」这种按钮。
   */
  const uploadFiles = (files: File[]): void => {
    if (!files.length) return
    void (async () => {
      for (const file of files) {
        await runUpload({ file, hostId: host.id, hostLabel: host.name, dir: path })
      }
      if (!aliveRef.current) return
      // 传完刷新一次列表；被取消 / 失败的文件不会留下完整文件，不需要分别处理。
      // ⚠️ 必须 silent：这条是**后台**刷新，闪一遍 loading 会让人以为「点了上传又把页面重置了」。
      void load(path, { silent: true })
    })()
  }

  /** 上传入口：隐藏的 `<input type=file multiple>`（`showOpenFilePicker` 在局域网 http 下不可用） */
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pickFiles = (): void => fileInputRef.current?.click()

  /** 上传文件夹：`webkitdirectory` 拿到的 File 自带 `webkitRelativePath`（保留目录结构） */
  const dirInputRef = useRef<HTMLInputElement | null>(null)
  const pickDir = (): void => dirInputRef.current?.click()

  // ---- 多选 ----
  const selectedEntries = entries.filter((e) => selected.has(e.path))
  const allSelected = entries.length > 0 && selected.size === entries.length
  const someSelected = selected.size > 0

  const clearSelection = (): void => {
    setSelected(new Set())
    anchorRef.current = null
  }

  const selectAll = (): void => {
    setSelected(new Set(entries.map((e) => e.path)))
    anchorRef.current = entries.length ? entries[entries.length - 1].path : null
  }

  /** 行点击：普通点选单个；Ctrl/⌘ 切换；Shift 范围选 */
  const onRowClick = (e: ReactMouseEvent, entry: SftpEntry): void => {
    if (e.shiftKey && anchorRef.current != null) {
      const a = entries.findIndex((x) => x.path === anchorRef.current)
      const b = entries.findIndex((x) => x.path === entry.path)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(entries[i].path)
          return next
        })
      }
      anchorRef.current = entry.path
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      anchorRef.current = entry.path
      return
    }
    setSelected(new Set([entry.path]))
    anchorRef.current = entry.path
  }

  /** 选中框切换单个（不触发行点击） */
  const toggleSelect = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    anchorRef.current = path
  }

  /** 批量下载：目录走 downloadDir，文件走 download */
  const bulkDownload = (): void => {
    const items = selectedEntries
    clearSelection()
    for (const entry of items) {
      if (entry.isDir) downloadDir(entry)
      else download(entry)
    }
  }

  const title = `${host.name}（${host.username}@${host.host}）`

  /** 两个上传入口共用一套禁用条件：连接中 / 目录读失败 / 本机已有上传在跑 */
  const uploadDisabled = connecting || Boolean(error) || uploading

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* 工具栏：返回上级 + 路径 + 刷新 / 新建文件夹 / 上传 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground" title={title}>
          {title}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          title="返回上级目录"
          aria-label="返回上级目录"
          disabled={path === '/' || Boolean(error)}
          onClick={goUp}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitPath()
          }}
          placeholder="远程路径，如 /var/www"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          title="刷新"
          aria-label="刷新"
          disabled={connecting || Boolean(error)}
          onClick={refresh}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          title="新建文件夹"
          aria-label="新建文件夹"
          disabled={connecting || Boolean(error)}
          onClick={() => {
            setMkdirName('')
            setMkdirOpen(true)
          }}
        >
          <FolderPlus className="size-4" />
        </Button>
        {/*
          上传收成**一个分裂按钮**（与会话详情顶栏的终端入口同一形状）：
          左半直接选文件（最常用的那个，少一次点击），右半箭头弹「上传文件 / 上传文件夹」。
          两个动作仍然是两个隐藏 `<input>`（见文件末尾），这里只负责把点击转过去 ——
          合的是**入口**，不是实现。
        */}
        <div className="flex shrink-0 items-center">
          <Button
            size="sm"
            className="gap-1.5 rounded-r-none"
            title="上传文件（可多选）"
            aria-label="上传文件"
            disabled={uploadDisabled}
            onClick={pickFiles}
          >
            <Upload className="size-3.5" />
            上传
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none border-l border-primary-foreground/25 px-1.5"
                title="上传文件 / 文件夹"
                aria-label="上传文件或文件夹"
                disabled={uploadDisabled}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={pickFiles}>
                <Upload className="size-3.5" />
                上传文件
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={pickDir}>
                <FolderUp className="size-3.5" />
                上传文件夹
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 多选操作栏：常驻显示；未选中时按钮禁用 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        <span className="shrink-0 text-xs font-medium text-foreground">已选 {selected.size} 项</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!someSelected}
            onClick={bulkDownload}
            title="下载选中项（目录走文件夹下载）"
          >
            <Download className="size-3.5" />
            下载
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!someSelected}
            onClick={() => openTargetOp(selectedEntries, 'copy')}
          >
            <Copy className="size-3.5" />
            复制到…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!someSelected}
            onClick={() => openTargetOp(selectedEntries, 'move')}
          >
            <ArrowRightLeft className="size-3.5" />
            移动到…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!someSelected}
            onClick={() => setPendingRemove(selectedEntries)}
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
          <Button variant="ghost" size="sm" disabled={!someSelected} onClick={clearSelection}>
            <X className="size-3.5" />
            取消选择
          </Button>
        </div>
      </div>

      {/* 文件列表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {connecting ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            正在连接 {host.username}@{host.host}:{host.port}…
          </div>
        ) : error ? (
          <div className="mx-4 mt-10 flex flex-col items-center gap-3 rounded-md border border-dashed border-destructive/40 px-4 py-6 text-center text-sm text-destructive">
            <span>{error}</span>
            {/* 出错后工具栏那几个按钮都是禁用的（`disabled` 里带着 `Boolean(error)`），
                这里是唯一的出口 —— 不然只能关标签重开 */}
            <Button variant="outline" size="sm" onClick={() => void connect()}>
              <RefreshCw className="size-3.5" />
              重试
            </Button>
          </div>
        ) : (
          <>
            {/* 表头（首列勾选框支持全选） */}
            <div className="sticky top-0 z-10 flex items-center gap-3 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <Checkbox
                className="shrink-0"
                checked={allSelected}
                onCheckedChange={(checked) => (checked ? selectAll() : clearSelection())}
                disabled={entries.length === 0}
              />
              <span className="min-w-0 flex-1">名称</span>
              <span className="w-24 shrink-0 text-right">大小</span>
              <span className="w-44 shrink-0">修改时间</span>
              <span className="w-10 shrink-0" />
            </div>
            {entries.length === 0 ? (
              <div className="mx-4 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                目录为空。
              </div>
            ) : (
              <div className="flex flex-col">
                {entries.map((entry) => (
                  <ContextMenu key={entry.path}>
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          'group flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-secondary/60',
                          selected.has(entry.path) && 'bg-primary/10 hover:bg-primary/15',
                          loading && 'opacity-60'
                        )}
                        onClick={(e) => onRowClick(e, entry)}
                        onDoubleClick={() => enter(entry)}
                        title={entry.isDir ? '双击进入' : undefined}
                      >
                        <Checkbox
                          className="shrink-0"
                          checked={selected.has(entry.path)}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() => toggleSelect(entry.path)}
                        />
                        {entry.isDir ? (
                          <Folder className="size-5 shrink-0 text-sky-500" />
                        ) : (
                          <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                        <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
                          {entry.isDir ? '-' : formatSize(entry.size)}
                        </span>
                        <span className="w-44 shrink-0 truncate text-xs text-muted-foreground">
                          {formatTime(entry.mtime)}
                        </span>
                        <span className="w-10 shrink-0 text-center">
                          {!entry.isDir && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-5 p-0 opacity-0 group-hover:opacity-100"
                              title="下载"
                              aria-label="下载"
                              onClick={(e) => {
                                e.stopPropagation()
                                download(entry)
                              }}
                            >
                              <Download className="size-3.5" />
                            </Button>
                          )}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-44">
                      {entry.isDir ? (
                        <>
                          <ContextMenuItem onSelect={() => enter(entry)}>
                            <Folder className="size-3.5" />
                            打开
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => downloadDir(entry)}>
                            <Download className="size-3.5" />
                            下载文件夹
                          </ContextMenuItem>
                        </>
                      ) : (
                        <ContextMenuItem onSelect={() => download(entry)}>
                          <Download className="size-3.5" />
                          下载
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onSelect={() => openTargetOp([entry], 'copy')}>
                        <Copy className="size-3.5" />
                        复制到…
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => openTargetOp([entry], 'move')}>
                        <ArrowRightLeft className="size-3.5" />
                        移动到…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          setRenaming(entry)
                          setRenameText(entry.name)
                        }}
                      >
                        <Pencil className="size-3.5" />
                        重命名
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => setPendingRemove([entry])}
                      >
                        <Trash2 className="size-3.5" />
                        删除
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 隐藏的文件选择框：上传文件（多选）/ 上传文件夹 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          uploadFiles(files)
        }}
      />
      <input
        ref={dirInputRef}
        type="file"
        // `webkitdirectory` 不在 React 的 input 类型里，但浏览器认它
        {...({ webkitdirectory: '' } as Record<string, string>)}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          uploadFiles(files)
        }}
      />

      {/* 新建文件夹 */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>将创建在 {path}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="文件夹名称"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mkdirName.trim()) void submitMkdir()
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMkdirOpen(false)}>
              取消
            </Button>
            <Button disabled={!mkdirName.trim()} onClick={() => void submitMkdir()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 复制 / 移动到…（填目标目录，目标路径 = 目标目录 + 原名称） */}
      <Dialog open={targetOp !== null} onOpenChange={(open) => !open && setTargetOp(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{targetOp?.mode === 'move' ? '移动到…' : '复制到…'}</DialogTitle>
            <DialogDescription>
              将{targetOp?.mode === 'move' ? '移动' : '复制'} {targetOp?.entries.length ?? 0} 项
              {targetOp?.entries.some((e) => e.isDir) ? '（含文件夹，将递归处理）' : ''} 到指定目录
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="目标目录，如 /var/www"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && targetDir.trim()) void submitTargetOp()
            }}
          />
          <p className="text-xs text-muted-foreground">
            目标路径：
            {targetDir.trim()
              ? joinSftpPath(targetDir.trim(), targetOp?.entries[0]?.name ?? '')
              : '—'}
            （同名文件会被覆盖）
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTargetOp(null)}>
              取消
            </Button>
            <Button disabled={!targetDir.trim()} onClick={() => void submitTargetOp()}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名 */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameText.trim()) void submitRename()
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button disabled={!renameText.trim()} onClick={() => void submitRename()}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（目录会递归删除，必须明确警示）；支持批量 */}
      <Dialog open={pendingRemove !== null} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除？</DialogTitle>
            <DialogDescription>
              将删除 {pendingRemove?.length ?? 0} 项
              {pendingRemove?.some((e) => e.isDir) ? '（含文件夹，将递归删除其全部内容）' : ''}
              ，该操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingRemove(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
