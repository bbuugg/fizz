/**
 * 浏览器画面面板：右侧 SidePanel 里的一个标签。
 *
 * 与 dogi 的 `BrowserPane` 同构：订阅 `/api/browser` 的 screencast 帧流实时显示，
 * 顶栏做地址栏 + 前进后退刷新 + 视口切换，画面区把鼠标 / 滚轮 / 键盘事件转成
 * `BrowserInputEvent` 发回后端 → 后端经 CDP 作用到真实页面（面板不只是「看」，还能亲手操作）。
 *
 * 会话 id 由 conversationId 推出（`agent-browser:<conversationId>`），与 Agent 工具
 * 是**同一份浏览器** —— 模型导航 / 点击后，这里立刻能看到画面。
 *
 * **不自动启动浏览器**：空态给一颗「启动浏览器」按钮，用户点了才重连一次并带上
 * `autostart`，让服务端把 Chromium 拉起来（2026-11 用户要求）。
 *
 * 以前是「面板正被看着就连上自动拉起」，两个毛病：① 打开面板那一刻就在冷启动，只想瞄
 * 一眼画面的人也得等；② 「有时候自动起来了、有时候显示未启动」完全取决于挂载那一刻的
 * 标签前后台状态，用户看不出规律。现在起没起只由那颗按钮决定，状态一目了然。
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  Monitor,
  Play,
  RotateCw,
  Smartphone
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { openBrowserSocket } from '@fizz/agent-client/web-host'
import type {
  BrowserClientMessage,
  BrowserEvent,
  BrowserFrame,
  BrowserInputEvent,
  BrowserMouseButton,
  BrowserSessionState,
  BrowserViewportMode
} from '@fizz/contracts'

/** 把鼠标按键的 event.button（0/1/2…）翻译成 CDP 的语义键名 */
function toButton(button: number): BrowserMouseButton {
  switch (button) {
    case 1:
      return 'middle'
    case 2:
      return 'right'
    default:
      return 'left'
  }
}

/** 从 KeyboardEvent 推算 CDP 的修饰键位掩码（Alt=1 / Ctrl=2 / Meta=4 / Shift=8） */
function modifiersOf(e: KeyboardEvent | MouseEvent): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  )
}

/**
 * 空态那颗「启动浏览器」：**手动**拉起（面板不再自动启动，见文件头）。
 *
 * 两种空态（还没启动 / 已被关掉）共用同一颗，它们走同一条重连路径（见 `startBrowser`），
 * 长相与文案也就该一致。
 */
function StartButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" className="mt-1" onClick={onClick}>
      <Play className="size-3.5" />
      启动浏览器
    </Button>
  )
}

interface BrowserPaneProps {
  conversationId: string
  workspaceId?: string
}

/**
 * 注意：`workspaceId` 当前未使用（浏览器进程跟会话走，不跟工作区目录走），但保留入口
 * 以便将来「浏览器落盘路径按工作区区分」时不用改调用方。
 */
export function BrowserPane({ conversationId }: BrowserPaneProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const socketRef = useRef<ReturnType<typeof openBrowserSocket> | null>(null)
  const buttonsMaskRef = useRef(0)
  /**
   * 「这次**重连**顺手把浏览器拉起来」：只有用户点「启动浏览器」时会置 true（见
   * `startBrowser`）。取完立刻清掉，免得后续任何一次重连又白拉一个 Chromium。
   */
  const autostartRef = useRef(false)
  /** 重连序号：effect 只认 `conversationId`，要主动重开连接就把它 +1 */
  const [gen, setGen] = useState(0)

  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [state, setState] = useState<BrowserSessionState | null>(null)
  const [closed, setClosed] = useState(false)
  /** 服务端给的关闭原因（启动失败 / 被 Agent 关掉）：有就显示，别只报「未启动」让人猜 */
  const [closeReason, setCloseReason] = useState<string | null>(null)
  const [noSession, setNoSession] = useState(true)
  /**
   * 正在拉起浏览器：launch 一个 Chromium 要一两秒（冷启动更久），这期间既没有帧也
   * 没有 state，不区分就会一直顶着「浏览器未启动」，看着像点了没反应。
   */
  const [starting, setStarting] = useState(false)
  const [address, setAddress] = useState('')

  useEffect(() => {
    const autostart = autostartRef.current
    autostartRef.current = false
    setFrame(null)
    setState(null)
    setClosed(false)
    setCloseReason(null)
    setNoSession(true)
    setStarting(autostart)
    buttonsMaskRef.current = 0

    const socket = openBrowserSocket(conversationId, { autostart })
    socketRef.current = socket

    const offMessage = socket.onMessage((data) => {
      if (typeof data !== 'string') return
      let event: BrowserEvent
      try {
        event = JSON.parse(data) as BrowserEvent
      } catch {
        return
      }
      if (event.type === 'frame') {
        setFrame(event as BrowserFrame)
        setNoSession(false)
        setStarting(false)
      } else if (event.type === 'state') {
        const s = event as BrowserSessionState
        setState(s)
        setAddress(s.url)
        setNoSession(false)
        setStarting(false)
      } else if (event.type === 'closed') {
        setClosed(true)
        setStarting(false)
        setCloseReason(event.reason || null)
      }
    })
    const offClose = socket.onClose((reason) => {
      // 连接被服务端带原因关掉（如会话不存在）：当成「浏览器未启动」显示
      setClosed(true)
      setStarting(false)
      /**
       * 保留先到的 `closed` 事件里的原因：服务端发完 `closed` 就 `ws.close()`（不带 reason），
       * 宿主会给这种「无原因关闭」补一句通用的「连接已断开」—— 直接用会把它盖掉
       * 「浏览器偏好已改 / 内置浏览器未安装」这类真正有用的信息。
       */
      if (reason) setCloseReason((prev) => prev ?? reason)
    })

    return () => {
      offMessage()
      offClose()
      socket.close()
      socketRef.current = null
    }
  }, [conversationId, gen])

  /** 发一条**控制**消息（导航 / 前进后退 / 刷新 / 视口切换） */
  const send = useCallback((msg: BrowserClientMessage) => {
    socketRef.current?.send(JSON.stringify(msg))
  }, [])

  /**
   * 空态那颗「启动浏览器」：**重连一次**，让新连接带上 `autostart` 由服务端拉起。
   *
   * 为什么不直接在当前连接上补一条 `ensure`：两种空态分不清连接还能不能用 ——
   * `closed` 那条是服务端已经 `ws.close()` 掉的，而刚挂载时连接可能还在 CONNECTING，
   * `WorkbenchSocket.send` 在未就绪时是**静默丢弃**（见 `createWorkbenchSocket`），点了
   * 就是「什么都没发生」。重连在两种情况下都成立，代价只是一次本地 WS 重开。
   */
  const startBrowser = useCallback(() => {
    autostartRef.current = true
    setGen((n) => n + 1)
  }, [])

  /**
   * 启动兜底：转了 20 秒还没画面 / 状态就退回空态（还能再点一次），别让人对着
   * 「正在启动浏览器…」无限等。真起不来时服务端会先发一条带原因的 `closed`，
   * 这条只兜「一条消息都没回」的情况。
   */
  useEffect(() => {
    if (!starting) return
    const timer = setTimeout(() => setStarting(false), 20_000)
    return () => clearTimeout(timer)
  }, [starting])

  /**
   * 发一条**输入**事件（鼠标 / 滚轮 / 键盘）。
   *
   * ⚠️ 必须包成 `{ type:'input', event }` —— 契约的 `BrowserClientMessage` 就是这么定的。
   * 直接把 `{ kind:'mouse', type:'mousePressed', … }` 原样发出去的话，服务端
   * `browser-ws` 的 `switch (message.type)` 一个 case 都匹配不上，输入被**静默丢掉**：
   * 表现就是「画面能看，但点不动、也输不进去」（导航 / 前进后退却正常 —— 那几条本来就是
   * 顶层带 `type` 的控制消息）。
   */
  const sendInput = useCallback((event: BrowserInputEvent) => {
    const msg: BrowserClientMessage = { type: 'input', event }
    socketRef.current?.send(JSON.stringify(msg))
  }, [])

  /** 把屏幕坐标映射到帧内坐标（画面用 object-contain 缩放，要按实际留白和缩放还原） */
  const toFrameCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const img = imgRef.current
      const f = frame
      if (!img || !f) return null
      const rect = img.getBoundingClientRect()
      const scale = Math.min(rect.width / f.width, rect.height / f.height)
      const offsetX = (rect.width - f.width * scale) / 2
      const offsetY = (rect.height - f.height * scale) / 2
      const x = (clientX - rect.left - offsetX) / scale
      const y = (clientY - rect.top - offsetY) / scale
      return {
        x: Math.max(0, Math.min(f.width, x)),
        y: Math.max(0, Math.min(f.height, y))
      }
    },
    [frame]
  )

  const onMouseDown = (e: React.MouseEvent) => {
    const p = toFrameCoords(e.clientX, e.clientY)
    if (!p) return
    const button = toButton(e.button)
    if (e.button === 0) buttonsMaskRef.current |= 1
    else if (e.button === 1) buttonsMaskRef.current |= 2
    else if (e.button === 2) buttonsMaskRef.current |= 4
    sendInput({ kind: 'mouse', type: 'mousePressed', x: p.x, y: p.y, button, modifiers: modifiersOf(e.nativeEvent) })
  }
  const onMouseUp = (e: React.MouseEvent) => {
    const p = toFrameCoords(e.clientX, e.clientY)
    if (!p) return
    const button = toButton(e.button)
    if (e.button === 0) buttonsMaskRef.current &= ~1
    else if (e.button === 1) buttonsMaskRef.current &= ~2
    else if (e.button === 2) buttonsMaskRef.current &= ~4
    sendInput({ kind: 'mouse', type: 'mouseReleased', x: p.x, y: p.y, button, modifiers: modifiersOf(e.nativeEvent) })
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const p = toFrameCoords(e.clientX, e.clientY)
    if (!p) return
    sendInput({ kind: 'mouse', type: 'mouseMoved', x: p.x, y: p.y, button: 'left', modifiers: modifiersOf(e.nativeEvent) })
  }
  const onWheel = (e: React.WheelEvent) => {
    const p = toFrameCoords(e.clientX, e.clientY)
    if (!p) return
    sendInput({ kind: 'wheel', x: p.x, y: p.y, deltaX: 0, deltaY: e.deltaY, modifiers: modifiersOf(e.nativeEvent) })
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const text = e.key.length === 1 ? e.key : undefined
    sendInput({
      kind: 'key',
      type: 'keyDown',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.nativeEvent.keyCode,
      modifiers: modifiersOf(e.nativeEvent),
      ...(text ? { text } : {})
    })
  }
  const onKeyUp = (e: React.KeyboardEvent) => {
    sendInput({
      kind: 'key',
      type: 'keyUp',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.nativeEvent.keyCode,
      modifiers: modifiersOf(e.nativeEvent)
    })
  }

  const submitAddress = () => {
    const url = address.trim()
    if (!url) return
    send({ type: 'navigate', url })
  }

  if (closed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <Globe className="size-8 opacity-40" />
        <div>浏览器未启动</div>
        <div className="text-xs">
          {closeReason ?? '点下面的按钮启动浏览器，或在地址栏输入网址'}
        </div>
        <StartButton onClick={startBrowser} />
      </div>
    )
  }

  if (noSession) {
    /* 正在拉起（用户刚点了「启动浏览器」）：给个转圈，否则那两秒像点了没反应 */
    if (starting) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
          <Loader2 className="size-6 animate-spin opacity-40" />
          <div>正在启动浏览器…</div>
          <div className="text-xs">首次启动要一两秒，稍等</div>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <Globe className="size-8 opacity-40" />
        <div>浏览器未启动</div>
        <div className="text-xs">
          点下面的按钮手动启动；也可以让 AI 调 browser_navigate 直接打开网址
        </div>
        <StartButton onClick={startBrowser} />
      </div>
    )
  }

  const viewportMode: BrowserViewportMode = state?.viewportMode ?? 'desktop'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：地址栏 + 前进后退刷新 + 视口切换 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-7" disabled={!state?.canGoBack} onClick={() => send({ type: 'back' })} aria-label="后退">
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" disabled={!state?.canGoForward} onClick={() => send({ type: 'forward' })} aria-label="前进">
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => send({ type: 'reload' })} aria-label="刷新">
          <RotateCw className="size-4" />
        </Button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress()
          }}
          placeholder="输入网址，回车打开"
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex shrink-0 items-center rounded-md border p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-6', viewportMode === 'desktop' && 'bg-accent')}
            onClick={() => send({ type: 'setViewportMode', mode: 'desktop' })}
            aria-label="PC 视口"
            title="PC 视口"
          >
            <Monitor className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-6', viewportMode === 'mobile' && 'bg-accent')}
            onClick={() => send({ type: 'setViewportMode', mode: 'mobile' })}
            aria-label="手机视口"
            title="手机视口"
          >
            <Smartphone className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 画面区：捕获鼠标 / 滚轮 / 键盘，转发到真实页面 */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={frame.data}
            alt="浏览器画面"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            等待浏览器画面…
          </div>
        )}
        {state?.loading && (
          <div className="absolute right-2 top-2 rounded bg-background/80 px-2 py-0.5 text-[0.625rem] text-muted-foreground">
            加载中…
          </div>
        )}
      </div>
    </div>
  )
}
