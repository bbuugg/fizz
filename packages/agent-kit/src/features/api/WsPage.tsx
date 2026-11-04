"use client";

/**
 * WebSocket 调试页（主区域）：一个标签 = 一条保存的 WebSocket 连接。
 *
 * 与 `ApiPage` 的分工完全一致：多标签由 `PanelView` 承担、列表由 `ApiPanel` 承担，
 * 这里只负责「一条连接」的连接、收发与日志。
 *
 * ## 与 dogi 的关键差异：连接由**服务端中继**建立
 *
 * dogi 是 Electron 单体，连接交给主进程（`window.api.ws`）；本仓库是「server + 渲染端」
 * 分离，浏览器原生 `WebSocket` 又不能设自定义握手头 / 不能跳 wss 自签证书校验。所以连接
 * 由服务端中继建立（`/api/api-client/ws/:connId`）：本页用 `openApiClientSocket(connId)`
 * 拿到一条**属于当前 connId** 的浏览器 WS，双方用 JSON 帧通信（见 `WsRelayClientMessage` /
 * `WsEvent`）。因此不再有「全局事件订阅 + connId 过滤」那套 —— 每条连接各自一条 socket。
 *
 * 其余部分（长连接语义、日志只在内存、草稿不自动保存 —— 点「保存」或 Ctrl/Cmd+S 落盘）与 dogi 一致。
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  ChevronDown,
  ChevronUp,
  Eraser,
  Info,
  Save,
  Send,
  Settings2,
  Trash2,
  Unplug
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Checkbox } from '@fizz/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '@fizz/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import MonacoEditor from '@fizz/agent-kit/features/files/MonacoEditor'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { openApiClientSocket } from '@fizz/agent-client/web-host'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { closeTab } from '@fizz/agent-kit/shared/lib/panel-store'
import { apiTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { openApiTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import {
  COMMON_HEADERS,
  NEW_WS_REQUEST_ID,
  emptyHeader,
  formatBytes,
  headerValueSuggestions,
  isBlankHeader,
  normalizeHeaders,
  pairsToHeaders,
  tidyHeaderRows
} from '@fizz/agent-kit/features/api/api-client'
import type {
  ApiHeaderPair,
  WsConnectOptions,
  WsEvent,
  WsReadyState
} from '@fizz/contracts/types'
import type { WorkbenchSocket } from '@fizz/agent-client/host'

/** 发送区高度占比的默认值与上下限（拖动分隔条时按此范围夹取） */
const COMPOSER_RATIO_DEFAULT = 0.32
const COMPOSER_RATIO_MIN = 0.12
const COMPOSER_RATIO_MAX = 0.8
/**
 * 日志区至少保留的高度（px）。
 * 与 ApiPage 同一个理由：只按比例卡上限不够，窗口一矮，80% 的发送区
 * 照样能把日志压成 0，压扁后内容会溢出糊在发送区上。
 */
const MIN_LOG_PANE_H = 120
/**
 * 日志条数上限。长连接下消息可能是持续的，不设上限会一直吃内存；
 * 超过就丢最旧的（调试场景里最近的帧才有价值）。
 */
const LOG_LIMIT = 1000

/** 日志筛选：全部 / 只看发送 / 只看接收 / 只看系统（连接、关闭、错误） */
const LOG_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'sent', label: '发送' },
  { value: 'received', label: '接收' },
  { value: 'system', label: '系统' }
] as const
type LogFilter = (typeof LOG_FILTERS)[number]['value']

/** 发送编码：文本帧（原样发字符串）/ 二进制帧（把输入当 base64 解成字节发出去） */
const MSG_ENCODINGS = [
  { value: 'text', label: '文本' },
  { value: 'base64', label: 'Base64' }
] as const
type MsgEncoding = (typeof MSG_ENCODINGS)[number]['value']

/** 一条日志（收 / 发 / 系统事件） */
interface WsLogEntry {
  id: string
  dir: 'sent' | 'received' | 'system'
  /** 文本原文，或二进制帧的 base64 */
  data: string
  encoding: 'text' | 'base64'
  /** 字节数（系统消息为 0） */
  bytes: number
  at: number
  /** 系统消息的级别：info 正常流程，error 连接失败 / 异常关闭 */
  level?: 'info' | 'error'
}

export function WsPage({ requestId }: { requestId: string }) {
  const { app } = useAppContext()
  const request = app.apiRequests.find((r) => r.id === requestId) ?? null
  /** 本标签是否是「未保存的新连接」草稿（requestId 为哨兵值，不是真实存储条目） */
  const isDraft = requestId === NEW_WS_REQUEST_ID

  // ---------- 连接配置草稿（不自动保存，Ctrl/Cmd+S 才落盘） ----------
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  /** 连接协议：ws:// 或 wss://（不再由用户手写，放左侧下拉选择） */
  const [wsScheme, setWsScheme] = useState<'ws' | 'wss'>('wss')
  const [headers, setHeaders] = useState<ApiHeaderPair[]>([emptyHeader()])
  /** 子协议：界面上是逗号分隔的一行文本，落盘时拆成数组（见 parseProtocols） */
  const [subprotocols, setSubprotocols] = useState('')
  /** 跳过 wss 自签证书校验；落盘为 `rejectUnauthorized: false`（见下方说明） */
  const [skipTls, setSkipTls] = useState(false)

  // ---------- 连接状态 ----------
  const [state, setState] = useState<WsReadyState>('closed')
  /** 协商出来的子协议（服务端选的） */
  const [protocol, setProtocol] = useState('')

  // ---------- 消息日志 ----------
  const [log, setLog] = useState<WsLogEntry[]>([])
  const [filter, setFilter] = useState<LogFilter>('all')

  // ---------- 发送区 ----------
  const [draft, setDraft] = useState('')
  const [encoding, setEncoding] = useState<MsgEncoding>('text')
  const [sending, setSending] = useState(false)

  // ---------- 视图与保存状态 ----------
  const [composerCollapsed, setComposerCollapsed] = useState(false)
  const [composerRatio, setComposerRatio] = useState(COMPOSER_RATIO_DEFAULT)
  const [configOpen, setConfigOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveNameOpen, setSaveNameOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  /** 页面根容器：拖动分隔条时按它的高度换算比例 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 连接行（地址 + 连接按钮）：它的底边就是日志区的顶边，用来算发送区的高度上限 */
  const connRowRef = useRef<HTMLDivElement | null>(null)
  /** 日志滚动容器：新帧到达时自动滚到底（用户手动往上翻了就不打扰） */
  const logRef = useRef<HTMLDivElement | null>(null)
  /**
   * 当前连接的 connId 与中继 socket。
   *
   * 每条连接各有一条打到服务端中继的浏览器 WS（`openApiClientSocket`），所以事件订阅在
   * `connect()` 里按这条 socket 装，不随 connId 变化反复拆装。
   */
  const connIdRef = useRef<string | null>(null)
  const socketRef = useRef<WorkbenchSocket | null>(null)
  /** 日志是否贴在底部（决定新帧到达要不要自动滚动） */
  const pinnedRef = useRef(true)

  /**
   * 追加一条日志（截断到 LOG_LIMIT 条）。
   * 只调用 setLog 的函数式更新，不闭包任何会变的值，所以事件回调里可以安全使用。
   */
  const pushLog = (entry: Omit<WsLogEntry, 'id'>): void => {
    setLog((prev) => {
      const next = [...prev, { ...entry, id: `${entry.at}-${prev.length}` }]
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
    })
  }

  /** 拆掉当前中继 socket（连上后只走一次；`close()` 会把浏览器 socket 标记为主动关闭，不再回调 onClose） */
  const teardownSocket = (): void => {
    const socket = socketRef.current
    socketRef.current = null
    if (!socket) return
    try {
      socket.close()
    } catch {
      // 已经关了
    }
  }

  /**
   * 处理一条中继事件（`WsEvent`）。只认当前连接的 connId —— 理论上每条 socket 只承载自己
   * 那条连接的事件，但仍按 connId 过滤一次，避免竞态下把上一条连接的事件混进来。
   *
   * 注意 `error` / `close` 之后要把 connIdRef 清掉：握手失败时可能先来 error 再来 close，
   * 清掉之后紧跟的 close 会被过滤掉，界面不会出现「一条错误 + 一条已关闭」的重复噪音，
   * 也避免某些情况只发 error 不发 close 时界面卡在「连接中」。同时把中继 socket 拆掉。
   */
  const handleEvent = (raw: string): void => {
    let ev: WsEvent
    try {
      ev = JSON.parse(raw) as WsEvent
    } catch {
      return
    }
    if (ev.connId !== connIdRef.current) return
    if (ev.type === 'open') {
      setState('open')
      setProtocol(ev.protocol)
      pushLog({
        dir: 'system',
        level: 'info',
        data: ev.protocol ? `已连接（子协议 ${ev.protocol}）` : '已连接',
        encoding: 'text',
        bytes: 0,
        at: Date.now()
      })
      // 服务端降级连上（如缺 undici、自定义头被忽略）：不改连接成败，单独提示一条
      if (ev.warning) {
        pushLog({
          dir: 'system',
          level: 'error',
          data: `注意：${ev.warning}`,
          encoding: 'text',
          bytes: 0,
          at: Date.now()
        })
      }
    } else if (ev.type === 'message') {
      pushLog({
        dir: 'received',
        data: ev.data,
        encoding: ev.encoding,
        bytes: ev.bytes,
        at: ev.at
      })
    } else if (ev.type === 'close') {
      setState('closed')
      connIdRef.current = null
      setProtocol('')
      pushLog({
        dir: 'system',
        level: ev.code === 1000 ? 'info' : 'error',
        data: `连接已关闭（${ev.code}${ev.reason ? ' ' + ev.reason : ''}）`,
        encoding: 'text',
        bytes: 0,
        at: ev.at
      })
      teardownSocket()
    } else {
      setState('closed')
      connIdRef.current = null
      pushLog({
        dir: 'system',
        level: 'error',
        data: ev.message,
        encoding: 'text',
        bytes: 0,
        at: Date.now()
      })
      teardownSocket()
    }
  }

  /**
   * 切换请求：用新连接重置草稿与连接（不冲刷未保存的改动 —— 那是用户自己的事）。
   * 顺带把上一条连接关掉：日志属于上一条连接，留着会张冠李戴。
   */
  useEffect(() => {
    const req = useAgentStore.getState().apiRequests.find((r) => r.id === requestId) ?? null
    setName(req?.name ?? '')
    const parsed = splitWsScheme(req?.url ?? '')
    setWsScheme(parsed.scheme)
    setUrl(parsed.rest)
    setHeaders(req?.headers?.length ? normalizeHeaders(req.headers) : [emptyHeader()])
    setSubprotocols((req?.subprotocols ?? []).join(', '))
    // 只有显式存了 false 才表示「跳过校验」：字段名沿用项目里 HTTP 那套
    // （undici 的 connect.rejectUnauthorized，false = 不校验）
    setSkipTls(req?.rejectUnauthorized === false)
    setProtocol('')
    setLog([])
    setState('closed')
    pinnedRef.current = true

    return () => {
      // 换请求 / 关标签：把连接关掉，别让中继留着一条没人看的 socket
      connIdRef.current = null
      teardownSocket()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  /**
   * 关闭 / 刷新守卫（**只给未保存的新连接草稿标签**）：填了任何内容再关 / 再刷 → 先确认「丢弃」。
   *
   * 与 `ApiPage` 同一套（草稿不自动保存，关掉即丢弃改动；刷新标签同样会卸载重挂、丢掉草稿，
   * 所以两个钩子共用同一份脏判据）。空白草稿直接放行；保存路径里的
   * `closeTab(apiTabKey(NEW_WS_REQUEST_ID))` 走裸关闭、不经过这里。
   */
  const confirm = useConfirm()
  const dirtyRef = useRef(false)
  dirtyRef.current =
    isDraft &&
    (name.trim() !== '' ||
      url.trim() !== '' ||
      subprotocols.trim() !== '' ||
      wsScheme !== 'wss' ||
      skipTls ||
      headers.some((h) => !isBlankHeader(h)))
  useEffect(() => {
    if (!isDraft) return
    return registerTabCloseGuard(apiTabKey(requestId), {
      beforeClose: async () => {
        if (!dirtyRef.current) return 'close'
        const ok = await confirm({
          title: '丢弃未保存的改动？',
          description: '这条连接还没有保存，关闭标签会丢弃当前的改动。',
          confirmLabel: '丢弃并关闭',
          destructive: true
        })
        return ok ? 'close' : 'cancel'
      },
      beforeReload: async () => {
        if (!dirtyRef.current) return 'reload'
        const ok = await confirm({
          title: '丢弃未保存的改动并刷新？',
          description: '这条连接还没有保存，刷新标签会重新挂载页面、丢弃当前的改动。',
          confirmLabel: '丢弃并刷新',
          destructive: true
        })
        return ok ? 'reload' : 'cancel'
      }
    })
  }, [isDraft, requestId, confirm])

  /** 新帧到达后自动滚到底（除非用户自己往上翻了） */
  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [log])

  /**
   * 保存当前草稿 —— **唯一落盘入口**（工具栏「保存」按钮与 Ctrl/Cmd+S 都走到这里）。
   * 已保存的连接整条覆盖写；groupId 必须从 store 里现取带回去，
   * 否则按一次 Ctrl+S 就会把它从分组里踢出去。
   */
  const saveNow = async (): Promise<void> => {
    if (isDraft) {
      const nm = name.trim()
      if (!nm) {
        setSaveName('')
        setSaveNameOpen(true)
        return
      }
      await persistDraft(nm)
      return
    }
    setSaving(true)
    try {
      const current = useAgentStore.getState().apiRequests.find((r) => r.id === requestId)
      const ok = await app.saveApiRequest({
        id: requestId,
        name: name.trim(),
        // WebSocket 没有方法：占位成 GET，列表里显示的是协议标记（WS）而不是它
        method: 'GET',
        url: url.trim() ? `${wsScheme}://${url.trim()}` : '',
        headers,
        body: '',
        protocol: 'ws',
        subprotocols: parseProtocols(subprotocols),
        // 不跳过校验时**不写**这个字段：false 的语义恰好是「跳过」
        ...(skipTls ? { rejectUnauthorized: false } : {}),
        groupId: current?.groupId,
        createdAt: 0,
        updatedAt: 0
      })
      if (ok) toast.success('已保存')
    } finally {
      setSaving(false)
    }
  }

  /** 草稿真正落盘：按给定名称写入列表，并把草稿标签切成真实标签 */
  const persistDraft = async (nm: string): Promise<void> => {
    setSaving(true)
    try {
      const before = new Set(useAgentStore.getState().apiRequests.map((r) => r.id))
      const ok = await app.saveApiRequest({
        id: '',
        name: nm,
        method: 'GET',
        url: url.trim() ? `${wsScheme}://${url.trim()}` : '',
        headers,
        body: '',
        protocol: 'ws',
        subprotocols: parseProtocols(subprotocols),
        ...(skipTls ? { rejectUnauthorized: false } : {}),
        createdAt: 0,
        updatedAt: 0
      })
      if (!ok) return
      const created = useAgentStore.getState().apiRequests.find((r) => !before.has(r.id))
      // 草稿标签 → 真实标签：关掉草稿（其卸载清理会顺手断开连接），避免残留空白标签
      closeTab(apiTabKey(NEW_WS_REQUEST_ID))
      if (created) openApiTab(created)
      toast.success('已保存')
    } finally {
      setSaving(false)
    }
  }

  /** 弹窗确认落盘：名称取自弹窗输入框（为空则不提交） */
  const confirmSaveDraft = async (): Promise<void> => {
    const nm = saveName.trim()
    if (!nm) return
    await persistDraft(nm)
    setSaveNameOpen(false)
  }

  // ---------- 连接 ----------
  const connect = (): void => {
    // 协议由左侧下拉决定，输入框只填 host/path；用户若误粘贴了带协议的完整地址，这里去掉多余前缀
    const host = url.trim().replace(/^wss?:\/\//i, '')
    if (!host) {
      pushLog({
        dir: 'system',
        level: 'error',
        data: '请填写连接地址',
        encoding: 'text',
        bytes: 0,
        at: Date.now()
      })
      return
    }
    const target = `${wsScheme}://${host}`
    // 重连前先拆掉上一条 socket（可能还挂着上一次失败的连接）
    teardownSocket()
    // connId 必须**先**定下来再发起连接：事件回调靠 connIdRef 过滤，晚一步设就会把
    // 首帧当成别人的连接丢掉
    const id = newConnId()
    connIdRef.current = id
    setState('connecting')
    pushLog({
      dir: 'system',
      level: 'info',
      data: `正在连接 ${target}`,
      encoding: 'text',
      bytes: 0,
      at: Date.now()
    })

    const options: WsConnectOptions = { url: target }
    const headerMap = pairsToHeaders(headers)
    if (Object.keys(headerMap).length) options.headers = headerMap
    const protocols = parseProtocols(subprotocols)
    if (protocols.length) options.protocols = protocols
    if (skipTls) options.rejectUnauthorized = false

    let socket: WorkbenchSocket
    try {
      socket = openApiClientSocket(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      connIdRef.current = null
      setState('closed')
      pushLog({ dir: 'system', level: 'error', data: msg, encoding: 'text', bytes: 0, at: Date.now() })
      return
    }
    socketRef.current = socket
    socket.onMessage((data) => {
      if (typeof data === 'string') handleEvent(data)
    })
    // 中继 socket 本身断了（服务端重启 / 网络抖动）：目标连接随之失效，补一条系统日志
    socket.onClose((reason) => {
      if (connIdRef.current !== id) return
      connIdRef.current = null
      socketRef.current = null
      setState('closed')
      setProtocol('')
      pushLog({
        dir: 'system',
        level: 'error',
        data: reason ? `中继连接已断开：${reason}` : '中继连接已断开',
        encoding: 'text',
        bytes: 0,
        at: Date.now()
      })
    })
    // 首帧必须是 connect：中继收到它才去连外部目标（未就绪的上行帧由宿主缓存）
    socket.send(JSON.stringify({ type: 'connect', options }))
  }

  /** 断开：先切到 closing（按钮进入 loading 且不可重复点），真正的 closed 由 close 事件带回来 */
  const disconnect = (): void => {
    const socket = socketRef.current
    const id = connIdRef.current
    if (!socket || !id) return
    setState('closing')
    socket.send(JSON.stringify({ type: 'close' }))
    // 兜底：目标早就断了 / 中继没回 close 事件时，别把界面卡在「断开中」
    window.setTimeout(() => {
      if (connIdRef.current !== id) return
      connIdRef.current = null
      setState('closed')
      setProtocol('')
      teardownSocket()
    }, 1500)
  }

  // ---------- 发送 ----------
  const send = (): void => {
    const socket = socketRef.current
    if (!socket || !connIdRef.current || state !== 'open') {
      toast.warning('连接尚未就绪')
      return
    }
    if (!draft) return
    setSending(true)
    try {
      // 上行失败（如目标已断）由中继回一条 error 事件带出来，这里不额外处理
      socket.send(JSON.stringify({ type: 'send', data: draft, encoding }))
      pushLog({
        dir: 'sent',
        data: draft,
        encoding,
        bytes: payloadBytes(draft, encoding),
        at: Date.now()
      })
    } finally {
      setSending(false)
    }
  }

  // ---------- 请求头增删改（与 ApiPage 同一套「末行自动补空槽位」交互） ----------
  const updateHeader = (idx: number, field: keyof ApiHeaderPair, value: string): void => {
    setHeaders((prev) => tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p))))
  }
  const removeHeader = (idx: number): void => {
    setHeaders((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
  }

  /**
   * 拖动分隔条调整发送区高度。
   *
   * 与 ApiPage 的响应分隔条同一套算法：按根容器高度换算成比例（窗口缩放后仍正确），
   * 上限由「日志区至少留 MIN_LOG_PANE_H」反推。指针管线（含触摸安全的 `touch-action`）
   * 统一走 `useDragResize`，别再手写 `pointermove`（见该 hook 的文件头）。
   */
  const startResize = useDragResize<{
    total: number
    startRatio: number
    maxRatio: number
  }>({
    axis: 'y',
    onStart: () => {
      const rootRect = rootRef.current?.getBoundingClientRect()
      const rowRect = connRowRef.current?.getBoundingClientRect()
      if (!rootRect || !rowRect || rootRect.height <= 0) return null
      const total = rootRect.height
      // 日志区之上还有工具栏 + 连接行（固定高度），上限要从这里减掉
      const fixedAbove = rowRect.bottom - rootRect.top
      return {
        total,
        startRatio: composerRatio,
        maxRatio: Math.min(
          COMPOSER_RATIO_MAX,
          Math.max(COMPOSER_RATIO_MIN, (total - fixedAbove - MIN_LOG_PANE_H) / total)
        )
      }
    },
    // 向上拖（deltaY 为负）= 发送区变高
    onMove: (deltaY, drag) =>
      setComposerRatio(
        Math.min(drag.maxRatio, Math.max(COMPOSER_RATIO_MIN, drag.startRatio - deltaY / drag.total))
      )
  })

  /** 快捷键：Ctrl/Cmd+S 保存（与工具栏「保存」按钮同效），Ctrl/Cmd+Enter 发送一帧 */
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveNow()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  if (!request && !isDraft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Cable className="size-12 opacity-30" />
        <div className="text-sm">该连接已被删除</div>
        <div className="text-xs text-muted-foreground">从左侧列表选择其他连接</div>
      </div>
    )
  }

  const isOpen = state === 'open'
  const busy = state === 'connecting' || state === 'closing'
  const headerCount = Object.keys(pairsToHeaders(headers)).length
  const shown = filter === 'all' ? log : log.filter((e) => e.dir === filter)
  const sentCount = log.filter((e) => e.dir === 'sent').length
  const recvCount = log.filter((e) => e.dir === 'received').length

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-background" onKeyDown={onKeyDown}>
      {/* 工具栏：名称 + 连接状态 + 连接配置 + 保存（Ctrl/Cmd+S 只是加速方式，不是唯一入口） */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="连接名称（可选，缺省显示地址）"
          className="min-w-0 flex-1 border-0 px-0 text-[0.9375rem] font-semibold shadow-none focus-visible:ring-0"
        />
        <StateBadge state={state} />
        {isOpen && protocol && (
          <span className="shrink-0 text-xs text-muted-foreground" title="服务端协商出的子协议">
            子协议 {protocol}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 text-xs text-muted-foreground"
          title="握手请求头 / 子协议 / TLS 选项"
          onClick={() => setConfigOpen(true)}
        >
          <Settings2 className="size-3.5" />
          连接配置{headerCount ? ` (${headerCount})` : ''}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={saving}
          title="保存（Ctrl+S）"
          onClick={() => void saveNow()}
        >
          <Save className="size-4" />
          保存
        </Button>
      </div>

      {/* 连接行：协议下拉 + 地址 + 连接/断开 */}
      <div ref={connRowRef} className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold text-sky-500">
          WS
        </span>
        <Select
          value={wsScheme}
          onValueChange={(v) => setWsScheme(v as 'ws' | 'wss')}
        >
          <SelectTrigger size="sm" className="w-24 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wss">wss://</SelectItem>
            <SelectItem value="ws">ws://</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={url}
          onChange={(e: ReactChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          placeholder="连接地址，如 echo.example.com/socket"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        {isOpen || busy ? (
          <Button
            variant="destructive"
            size="sm"
            className="shrink-0"
            onClick={disconnect}
            disabled={state === 'closing'}
            title="断开连接"
          >
            <Unplug className="size-4" />
            {state === 'closing' ? '断开中' : '断开'}
          </Button>
        ) : (
          <Button size="sm" className="shrink-0" onClick={connect} title="建立连接（Ctrl+Enter 发送消息）">
            <Cable className="size-4" />
            连接
          </Button>
        )}
      </div>

      {/* 日志区：主区域，占满剩余高度（overflow-hidden：被压扁时裁掉，不要溢到发送区上） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          <Segmented
            ariaLabel="日志筛选"
            options={LOG_FILTERS}
            value={filter}
            onChange={setFilter}
          />
          <span className="text-muted-foreground">{shown.length} 条</span>
          <span className="text-muted-foreground">
            <ArrowUpRight className="mr-0.5 inline size-3" />
            {sentCount}
            <ArrowDownLeft className="mx-0.5 inline size-3" />
            {recvCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            title="清空消息日志（日志只存在内存里，关标签即丢）"
            disabled={log.length === 0}
            onClick={() => setLog([])}
          >
            <Eraser className="size-3.5" />
            清空
          </Button>
        </div>

        <div
          ref={logRef}
          className="min-h-0 flex-1 select-text overflow-auto px-1.5 pb-2"
          onScroll={(e) => {
            const el = e.currentTarget
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {shown.length === 0 ? (
            <div className="mx-2 mt-6 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {log.length === 0
                ? '还没有消息'
                : `没有符合「${LOG_FILTERS.find((f) => f.value === filter)?.label}」的日志。`}
            </div>
          ) : (
            <div className="flex flex-col">
              {shown.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/*
        拖拽条：调整发送区高度。**常驻**（只在折叠时隐藏）——
        不能等连上才出现，否则没连接时根本抓不到这条分隔线。
      */}
      {!composerCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整发送区高度"
          className="group/cs relative z-20 -my-2 h-4 shrink-0 cursor-row-resize touch-none select-none [-webkit-touch-callout:none] sm:-my-1 sm:h-2"
          title="拖动调整发送区高度"
          onPointerDown={startResize}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/cs:bg-primary" />
        </div>
      )}

      {/*
        发送区：高度由上面的分隔条拖动决定（没折叠就固定占比，保证拖动一定有可见效果）。
        bg-background 必须显式写：这一块是不透明的面板，否则下面被压扁的日志区会透出来。
      */}
      <div
        className="flex shrink-0 flex-col overflow-hidden bg-background"
        style={composerCollapsed ? undefined : { height: Math.round(composerRatio * 100) + '%' }}
      >
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">发送</span>
          <Segmented
            ariaLabel="发送编码"
            options={MSG_ENCODINGS}
            value={encoding}
            onChange={setEncoding}
          />
          <span className="truncate text-muted-foreground">
            {encoding === 'text' ? '按文本帧发送' : '把内容当 base64 解成二进制帧发送'}
          </span>
          {encoding === 'text' && (
            <button
              className="shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              title="按 JSON 美化发送内容（不改变语义）"
              onClick={() => setDraft((v) => prettyJson(v))}
            >
              格式化
            </button>
          )}
          <span className="ml-auto shrink-0 text-muted-foreground">Ctrl+Enter 发送</span>
          <Button
            size="sm"
            className="shrink-0"
            disabled={!isOpen || sending || !draft}
            onClick={send}
            title={isOpen ? '发送一帧（Ctrl+Enter）' : '连接建立后才能发送'}
          >
            <Send className="size-3.5" />
            发送
          </Button>
          <button
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title={composerCollapsed ? '展开发送区' : '折叠发送区'}
            onClick={() => setComposerCollapsed((v) => !v)}
          >
            {composerCollapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>

        {!composerCollapsed && (
          <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
            <div className="h-full overflow-hidden">
              <MonacoEditor
                value={draft}
                onChange={setDraft}
                language={encoding === 'base64' ? 'plaintext' : 'json'}
                showLanguageSelector={encoding === 'text'}
                showWordWrapToggle
                showCopyButton
                toolbar={
                  isOpen ? undefined : (
                    <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                      尚未连接，发送按钮在连接建立后才可用
                    </span>
                  )
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* 连接配置抽屉：握手请求头 / 子协议 / TLS —— 都是「设一次就不动」的东西，不占主界面 */}
      <Sheet open={configOpen} onOpenChange={setConfigOpen}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-[520px]">
          <SheetHeader>
            <SheetTitle>连接配置</SheetTitle>
            <SheetDescription>握手时带上，改完点「保存」或按 Ctrl/Cmd+S 落盘</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-2">
            <section>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                握手请求头
                <span className="ml-2 font-normal text-muted-foreground">
                  浏览器原生 WebSocket 不允许设头，这里是服务端中继代发的
                </span>
              </div>
              {/* 不用表格组件（强制 rowKey），与 ApiPage 一样直接铺 flex 行 */}
              <div className="flex flex-col divide-y divide-border/40">
                {headers.map((h, i) => {
                  const suggestions = headerValueSuggestions(h.key)
                  return (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <div className="w-[180px] shrink-0">
                        <Input
                          value={h.key}
                          onChange={(e) => updateHeader(i, 'key', e.target.value)}
                          placeholder="名称，如 Authorization"
                          list="ws-common-headers"
                          className="h-8 w-full font-mono text-xs"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <Input
                          value={h.value}
                          onChange={(e) => updateHeader(i, 'value', e.target.value)}
                          placeholder={suggestions ? '可从常见取值中选择' : '值'}
                          list={suggestions ? `ws-header-values-${i}` : undefined}
                          className="h-8 w-full font-mono text-xs"
                        />
                        {suggestions && (
                          <datalist id={`ws-header-values-${i}`}>
                            {suggestions.map((v) => (
                              <option key={v} value={v} />
                            ))}
                          </datalist>
                        )}
                      </div>
                      <div className="w-8 shrink-0 text-center">
                        {/* 末行空槽位不给删除按钮：删了 tidyHeaderRows 也会立刻补回来 */}
                        {i === headers.length - 1 && isBlankHeader(h) ? null : (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="size-7 text-muted-foreground"
                            title="删除该请求头"
                            onClick={() => removeHeader(i)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* 常见头名的补全源（原生 datalist，替代 antd AutoComplete） */}
              <datalist id="ws-common-headers">
                {COMMON_HEADERS.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </section>

            <section>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                子协议（Sec-WebSocket-Protocol）
              </div>
              <Input
                value={subprotocols}
                onChange={(e) => setSubprotocols(e.target.value)}
                placeholder="多个用逗号分隔，如 graphql-ws, json"
                className="font-mono text-xs"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                留空则不发送该请求头；服务端选中哪一个会显示在工具栏上。
              </p>
            </section>

            <section>
              <div className="mb-2 text-xs font-medium text-muted-foreground">TLS</div>
              <label className="flex items-center gap-2">
                <Checkbox checked={skipTls} onCheckedChange={(v) => setSkipTls(v === true)} />
                <span className="text-xs">跳过证书校验（仅 wss 自签证书时使用）</span>
              </label>
              <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                <span>开启后该连接的证书不再校验，仅建议在调试自签证书服务时临时使用。</span>
              </p>
            </section>
          </div>
          <SheetFooter className="flex-row justify-end">
            <Button size="sm" variant="ghost" onClick={() => setConfigOpen(false)}>
              关闭
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* 草稿按 Ctrl/Cmd+S 时名称为空才走到这里：要求补一个名称再落盘 */}
      <Dialog open={saveNameOpen} onOpenChange={setSaveNameOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>保存 WebSocket 连接</DialogTitle>
            <DialogDescription>保存后该连接才会显示在左侧列表中（消息日志不落盘）。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="连接名称，如：本地推送服务"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSaveDraft()
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveNameOpen(false)}>
              取消
            </Button>
            <Button disabled={!saveName.trim() || saving} onClick={() => void confirmSaveDraft()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 连接状态徽标（工具栏用） */
function StateBadge({ state }: { state: WsReadyState }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
        state === 'open' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        state === 'connecting' && 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
        state === 'closing' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        state === 'closed' && 'bg-muted text-muted-foreground'
      )}
    >
      {STATE_LABEL[state]}
    </span>
  )
}

/** 连接状态的中文名（工具栏徽标用） */
const STATE_LABEL: Record<WsReadyState, string> = {
  connecting: '连接中',
  open: '已连接',
  closing: '断开中',
  closed: '未连接'
}

/** 日志行：时间 · 方向 · 编码 · 体积 · 内容 */
function LogRow({ entry }: { entry: WsLogEntry }) {
  const isSystem = entry.dir === 'system'
  const text = entry.encoding === 'text' && !isSystem ? prettyJson(entry.data) : entry.data
  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b border-border/40 px-2 py-1.5',
        isSystem && entry.level === 'error' && 'bg-destructive/5'
      )}
    >
      <span className="w-[68px] shrink-0 font-mono text-xs leading-4 text-muted-foreground">
        {clockOf(entry.at)}
      </span>
      {isSystem ? (
        <>
          <span
            className={cn(
              'w-12 shrink-0 text-xs leading-4',
              entry.level === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {entry.level === 'error' ? '错误' : '系统'}
          </span>
          <span className="w-14 shrink-0" />
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-pre-wrap break-all text-xs leading-4',
              entry.level === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {entry.data}
          </span>
        </>
      ) : (
        <>
          <span
            className={cn(
              'flex w-12 shrink-0 items-center gap-1 text-xs leading-4',
              entry.dir === 'sent' ? 'text-blue-500' : 'text-emerald-500'
            )}
          >
            {entry.dir === 'sent' ? (
              <ArrowUpRight className="size-3 shrink-0" />
            ) : (
              <ArrowDownLeft className="size-3 shrink-0" />
            )}
            {entry.dir === 'sent' ? '发送' : '接收'}
          </span>
          <span className="w-14 shrink-0 text-xs leading-4 text-muted-foreground">
            {entry.encoding === 'base64' ? 'binary' : 'text'}
          </span>
          <span className="w-14 shrink-0 text-right font-mono text-xs leading-4 text-muted-foreground">
            {formatBytes(entry.bytes)}
          </span>
          {/* 长帧不截断，容器内滚动：调试时经常要看完整的 payload */}
          <pre className="max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-4">
            {text}
          </pre>
        </>
      )}
    </div>
  )
}

/**
 * 从保存的完整地址里拆出协议与剩余部分。
 * 没有协议时默认 wss（安全优先）；输入框只展示剩余部分，协议由下拉决定。
 */
function splitWsScheme(full: string): { scheme: 'ws' | 'wss'; rest: string } {
  const m = /^wss?:\/\//i.exec(full.trim())
  if (m) {
    const scheme = m[0].toLowerCase().replace('://', '') as 'ws' | 'wss'
    return { scheme, rest: full.trim().slice(m[0].length) }
  }
  return { scheme: 'wss', rest: full.trim() }
}

/** 逗号 / 空白分隔的子协议串 → 数组（去空、去重保序） */
function parseProtocols(raw: string): string[] {
  const out: string[] = []
  for (const p of raw.split(/[,\s]+/)) {
    const v = p.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 生成连接 id。
 *
 * 用 `crypto.randomUUID()` 更省事，但渲染端在 `file://` 下不一定是 secure context，
 * 所以按项目里其它地方的写法用「时间戳 + 随机数」，冲突概率可以忽略。
 */
function newConnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 一帧的字节数：文本按 utf8，base64 按解码后的长度估算 */
function payloadBytes(data: string, encoding: MsgEncoding): number {
  if (encoding === 'base64') {
    const clean = data.replace(/\s+/g, '')
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
  }
  return new TextEncoder().encode(data).length
}

/** 时间戳 → HH:MM:SS.mmm（帧日志要精确到毫秒，relTime 那种「几秒前」不适合） */
function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * 能当 JSON 解析就美化输出（只影响显示，发送的仍是原文）。
 * 解析不了就原样返回 —— 不因为「看起来像 JSON」就改写用户的字节。
 */
function prettyJson(text: string): string {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return text
  }
}