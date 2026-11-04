/**
 * 浏览器引擎：一个会话 = 一个 headless Chromium（Playwright 起），画面走 CDP screencast
 * 推给订阅者（后端 WS 处理器，再经 desktop 内部 WS / web server WS 到渲染端面板）。
 *
 * 与 dogi 的差异只在于事件出口：dogi 是「注册一个 IPC broadcaster」，这里换成
 * **同进程内的订阅中心（hub）**——后端 WS handler 按 sessionId 订阅，引擎把帧 / 状态
 * 直接推给它，再由它转成 WS 帧。这样 desktop 与 web 共用同一份引擎与同一套传输
 * （各自只是把 hub 的事件接到自己的 WS 上），不需要为两者各写一套 IPC 通道。
 *
 * 本模块刻意与 Electron / 具体宿主解耦（依赖经 `setBrowserProfilesRoot` /
 * `setBrowserChannelResolver` 注入），可被纯 Node 验证脚本直接跑。
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page
} from 'playwright'
import type {
  BrowserChannel,
  BrowserFrame,
  BrowserSessionClosed,
  BrowserSessionState,
  BrowserViewportMode
} from '@fizz/contracts'
import {
  DEFAULT_BROWSER_VIEWPORT,
  MOBILE_PLATFORM,
  browserUserAgent,
  browserViewportPreset,
  type BrowserViewportPreset
} from '@fizz/contracts'
import { nextButtonsMask, toCdpCommand } from './input'
import { launchAttempts, type LaunchAttempt } from './resolver'
import { ensureChromiumReady } from '../playwright-browsers'
import { pageErrorMessage } from '../headless'

/** screencast 帧节流：最多 ~30fps，避免把 CPU 都喂给编码（静止页面也会持续推帧） */
const MIN_FRAME_INTERVAL = 33

// ---------------------------------------------------------------------------
// 订阅中心（hub）：sessionId → 订阅者集合
// ---------------------------------------------------------------------------

/** 推给渲染端的事件（自带 sessionId，便于路由） */
export type BrowserEvent = BrowserFrame | BrowserSessionState | BrowserSessionClosed

type BrowserSubscriber = (event: BrowserEvent) => void

const subscribers = new Map<string, Set<BrowserSubscriber>>()

/**
 * 订阅某会话的画面 / 状态事件。返回退订函数。
 * 后端 WS handler 用它在浏览器 WS 连上时订阅、断开时退订。
 */
export function subscribeBrowser(sessionId: string, cb: BrowserSubscriber): () => void {
  let set = subscribers.get(sessionId)
  if (!set) {
    set = new Set()
    subscribers.set(sessionId, set)
  }
  set.add(cb)
  return () => {
    const s = subscribers.get(sessionId)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) subscribers.delete(sessionId)
  }
}

function emitBrowserFrame(frame: BrowserFrame): void {
  subscribers.get(frame.sessionId)?.forEach((cb) => cb(frame))
}
function emitBrowserState(state: BrowserSessionState): void {
  subscribers.get(state.sessionId)?.forEach((cb) => cb(state))
}
function emitBrowserClosed(payload: { sessionId: string; reason: string }): void {
  subscribers.get(payload.sessionId)?.forEach((cb) => cb({ type: 'closed', ...payload }))
}

// ---------------------------------------------------------------------------
// 配置注入（与宿主解耦）
// ---------------------------------------------------------------------------

/**
 * 持久化 profile 的根目录。没注入时回退为**临时上下文**（会话一关登录态即失，不落盘）。
 */
let profilesRoot: string | null = null
let channelResolver: () => BrowserChannel = () => 'auto'

export function setBrowserProfilesRoot(dir: string): void {
  profilesRoot = dir
}

export function setBrowserChannelResolver(fn: () => BrowserChannel): void {
  channelResolver = fn
}

export function resolveBrowserChannel(): BrowserChannel {
  return channelResolver()
}

/** 一次性配置（后端启动时调用）：根目录 + 浏览器来源偏好 */
export function configureBrowser(opts: {
  profilesRoot: string
  channel?: () => BrowserChannel
}): void {
  setBrowserProfilesRoot(opts.profilesRoot)
  if (opts.channel) setBrowserChannelResolver(opts.channel)
}

/**
 * 正在拉起中的会话：`sessionId → start()` 的 promise。
 *
 * 面板（WS 连上自动启动）与 Agent 工具可能**同时**来 ensure，而 `BrowserSession.start`
 * 的守卫是 `if (this.browser) return`，浏览器启动完之前它还没被赋值 —— 两次并发会各
 * launch 一个 Chromium，后起的覆盖前一个，白烧一份内存与端口。这里按 id 去重。
 */
const startingSessions = new Map<string, Promise<BrowserSession>>()

/**
 * 确保某会话的浏览器已拉起：**面板**与 **Agent 工具集**共用同一份会话。
 * 已存在且存活则原样返回；失效先关掉重建；不存在则新建并 `start`
 * （channel 走 `resolveBrowserChannel`，与 `buildBrowserToolSet` 的 `ensureSession` 一致）。
 *
 * 谁触发：面板发来的 `ensure`（用户点了「启动浏览器」）或第一条控制消息、面板重连时带的
 * `autostart=1`（`closed` 之后点「启动浏览器」那条路）、以及 Agent 的 `browser_*`。
 *
 * ⚠️ 自动启动那条**只能由用户显式动作带**：`BrowserPane` 不再「打开面板就拉起浏览器」，
 * 连接一律不带 `autostart`，只有用户点那颗按钮才发 `ensure`（2026-11 用户要求）。
 * 别再把「面板正被看着」当成「要用它」。
 */
export async function ensureBrowserSession(
  sessionId: string,
  mode: BrowserViewportMode = DEFAULT_BROWSER_VIEWPORT
): Promise<BrowserSession> {
  let session = browserSessions.get(sessionId)
  if (session && !session.isAlive()) {
    await browserSessions.close(sessionId, '会话已失效，重建').catch(() => {})
    session = undefined
  }
  if (!session) session = browserSessions.create(sessionId, createBrowserSessionHandlers())
  if (!session.isAlive()) {
    const inflight = startingSessions.get(sessionId)
    if (inflight) return inflight
    const target = session
    const launching = target.start(resolveBrowserChannel(), mode).then(
      () => {
        startingSessions.delete(sessionId)
        return target
      },
      (err: unknown) => {
        startingSessions.delete(sessionId)
        throw err
      }
    )
    startingSessions.set(sessionId, launching)
    return launching
  }
  return session
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface BrowserSessionHandlers {
  onFrame: (frame: BrowserFrame) => void
  onState: (state: BrowserSessionState) => void
  onClosed: (sessionId: string, reason: string) => void
}

/** 默认 handlers：把事件推到 hub */
export function createBrowserSessionHandlers(): BrowserSessionHandlers {
  return {
    onFrame: (frame) => emitBrowserFrame(frame),
    onState: (state) => emitBrowserState(state),
    onClosed: (sessionId, reason) => emitBrowserClosed({ sessionId, reason })
  }
}

export class BrowserSession {
  readonly id: string

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null

  private readonly handlers: BrowserSessionHandlers
  private buttonsMask = 0
  private channelLabel: string | null = null
  private title = ''
  private loading = false
  private canGoBack = false
  private canGoForward = false
  private viewportMode: BrowserViewportMode = DEFAULT_BROWSER_VIEWPORT
  /** 页面视口（CSS px）：来自预设，**不跟随面板尺寸** */
  private viewport = { width: 1280, height: 800 }
  private lastFrameAt = 0
  private screencasting = false
  private closed = false
  private contextBound = false
  private boundPages = new WeakSet<Page>()
  private desktopUserAgent = ''
  /** 最近一帧画面：重挂载（切标签页回来）时静止页面等不到新帧，补这帧立刻出图 */
  private lastFrame: BrowserFrame | null = null
  /** 最近一次状态：同上，重挂载时补状态（URL / 可前进后退 / 加载中等） */
  private lastState: BrowserSessionState | null = null

  constructor(id: string, handlers: BrowserSessionHandlers) {
    this.id = id
    this.handlers = handlers
  }

  async start(channel: BrowserChannel, mode: BrowserViewportMode = DEFAULT_BROWSER_VIEWPORT): Promise<void> {
    if (this.browser) return

    const preset = browserViewportPreset(mode)
    this.viewportMode = preset.mode
    this.applyViewport(preset)

    const failures: string[] = []

    for (const attempt of launchAttempts(channel)) {
      try {
        await this.launch(attempt, preset)
        return
      } catch (err) {
        failures.push(`${attempt.label}: ${errText(err)}`)
        this.reset()
      }
    }

    /*
     * 自带 headless shell 没下载时，`launchAttempts` 的 auto 候选会把它剔除 ——
     * 但那不是「不可用」，是「还没装」。走到这里说明系统浏览器也没试成，此时在线装
     * 一份 headless shell（与 web_fetch / screenshot 同源）再试一次，别让「没装 =
     * 永远用不了」。显式 bundled 偏好也会走到这里（它本就该触发下载）。
     */
    if (channel === 'bundled' || channel === 'auto') {
      try {
        await ensureChromiumReady()
        await this.launch({ label: 'Chromium', options: {} }, preset)
        return
      } catch (err) {
        failures.push(`Chromium: ${errText(err)}`)
        this.reset()
      }
    }

    throw new Error(`没有可用的浏览器。${failures.join('；')}`)
  }

  /** 一次启动尝试：成功即把本会话的 browser/context/page 装配好并开播；失败抛错由调用方收尾 */
  private async launch(attempt: LaunchAttempt, preset: BrowserViewportPreset): Promise<void> {
    this.channelLabel = attempt.label
    const contextOptions = {
      viewport: this.viewport,
      deviceScaleFactor: preset.dpr,
      ignoreHTTPSErrors: true
    }
    const profileDir = profileDirOf(this.id)
    if (profileDir) {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        ...attempt.options,
        ...contextOptions
      })
      this.browser = this.context.browser()
    } else {
      this.browser = await chromium.launch({ headless: true, ...attempt.options })
      this.context = await this.browser.newContext(contextOptions)
    }
    const existing = this.context.pages()
    this.page = existing[0] ?? (await this.context.newPage())
    for (const extra of existing.slice(1)) void extra.close().catch(() => {})
    this.bindPage(this.page)
    this.desktopUserAgent = await this.readUserAgent()
    this.lastFrame = null
    await this.startScreencast()
    await this.applyPageEmulation()
    this.bindSessionListeners()
    this.pushState()
  }

  /** 一次尝试失败后的收尾：清空本次尝试装配的句柄（`closed` / `contextBound` 不动） */
  private reset(): void {
    this.browser = null
    this.context = null
    this.page = null
  }

  async close(reason = '用户关闭'): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stopScreencast().catch(() => {})
    await this.browser?.close().catch(() => {})
    this.browser = null
    this.context = null
    this.page = null
    this.cdp = null
    this.lastFrame = null
    this.lastState = null
    this.handlers.onClosed(this.id, reason)
  }

  isAlive(): boolean {
    return !this.closed && Boolean(this.page) && !this.page!.isClosed()
  }

  /** 把最新一帧再推一次（面板重挂载时补画面） */
  replayLastFrame(): void {
    if (this.closed || !this.lastFrame) return
    this.handlers.onFrame(this.lastFrame)
  }

  /** 把最近一次状态再推一次（面板重挂载时补状态，配合 `replayLastFrame`） */
  replayLastState(): void {
    if (this.closed || !this.lastState) return
    this.handlers.onState(this.lastState)
  }

  getPage(): Page {
    if (!this.page) throw new Error('浏览器尚未启动')
    return this.page
  }

  private bindSessionListeners(): void {
    if (this.contextBound) return
    this.contextBound = true
    this.context?.on('page', (p) => void this.adoptPage(p))
    this.browser?.on('disconnected', () => {
      if (!this.closed) void this.close('浏览器进程已退出')
    })
  }

  private async adoptPage(p: Page): Promise<void> {
    if (this.closed || p === this.page) return
    await this.stopScreencast().catch(() => {})
    this.cdp = null
    this.lastFrame = null
    this.lastFrameAt = 0

    this.page = p
    this.bindPage(p)
    await this.startScreencast()
    await this.applyPageEmulation()
    await this.refreshNavigation()
  }

  private bindPage(page: Page): void {
    if (this.boundPages.has(page)) return
    this.boundPages.add(page)

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('load', () => {
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('domcontentloaded', () => {
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('close', () => {
      if (this.closed || page !== this.page) return
      void page.opener().then((opener) => {
        if (opener && !opener.isClosed()) return this.adoptPage(opener)
        return this.close('页面已关闭')
      })
    })
  }

  private async applyPageEmulation(): Promise<void> {
    if (!this.page) return
    const preset = browserViewportPreset(this.viewportMode)
    await this.page.setViewportSize(this.viewport).catch(() => {})
    await this.applyDeviceScaleFactor(preset.dpr)
    await this.applyUserAgent(preset.mode)
  }

  private async refreshNavigation(): Promise<void> {
    if (!this.page || !this.cdp) return
    try {
      const history = await this.cdp.send('Page.getNavigationHistory')
      this.canGoBack = history.currentIndex > 0
      this.canGoForward = history.currentIndex < history.entries.length - 1
    } catch {
      // screencast 未启动时没有 CDP 会话，忽略即可
    }
    this.title = await this.page.title().catch(() => '')
    this.pushState()
  }

  private pushState(): void {
    if (this.closed) return
    this.lastState = this.state()
    this.handlers.onState(this.lastState)
  }

  state(): BrowserSessionState {
    return {
      type: 'state',
      sessionId: this.id,
      url: this.page?.url() ?? '',
      title: this.title,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      viewport: { ...this.viewport },
      viewportMode: this.viewportMode,
      channel: this.channelLabel
    }
  }

  private async startScreencast(): Promise<void> {
    if (!this.page || !this.context) return
    await this.stopScreencast().catch(() => {})
    if (!this.cdp) {
      try {
        this.cdp = await this.context.newCDPSession(this.page)
      } catch {
        return
      }
    }

    this.cdp.on('Page.screencastFrame', (ev) => {
      void this.cdp?.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})

      const meta = ev.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined
      const frame: BrowserFrame = {
        type: 'frame',
        sessionId: this.id,
        // ⚠️ CDP 给的是**裸 base64**，必须补 `data:` 前缀：契约要求 `data` 可直接喂
        // `<img src>`。少了前缀，渲染端会把它当成**相对 URL** 去请求
        // `http://<dev-server>/<整屏 base64>` —— 请求行远超 Node 的 16KB maxHeaderSize，
        // dev server 直接回 **431 Request Header Fields Too Large**（实测踩过）。
        data: `data:image/jpeg;base64,${ev.data}`,
        width: meta?.deviceWidth ?? this.viewport.width,
        height: meta?.deviceHeight ?? this.viewport.height
      }
      this.lastFrame = frame

      const now = Date.now()
      if (now - this.lastFrameAt < MIN_FRAME_INTERVAL) return
      this.lastFrameAt = now
      this.handlers.onFrame(frame)
    })

    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1
      })
      this.screencasting = true
    } catch {
      // 画面流起不来不影响会话存活；工具侧的导航 / 快照仍可用
    }
  }

  private async stopScreencast(): Promise<void> {
    if (!this.screencasting || !this.cdp) return
    this.screencasting = false
    await this.cdp.send('Page.stopScreencast').catch(() => {})
  }

  private applyViewport(preset: BrowserViewportPreset): void {
    this.viewport = { width: preset.width, height: preset.height }
  }

  async setViewportMode(mode: BrowserViewportMode): Promise<void> {
    if (this.viewportMode === mode) return
    const preset = browserViewportPreset(mode)
    this.viewportMode = preset.mode
    this.applyViewport(preset)

    if (this.page) {
      await this.applyPageEmulation()
      await this.startScreencast()
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    this.pushState()
  }

  private async applyDeviceScaleFactor(dpr: number): Promise<void> {
    if (!this.cdp) return
    await this.cdp
      .send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: dpr,
        mobile: false
      })
      .catch(() => {})
  }

  private async applyUserAgent(mode: BrowserViewportMode): Promise<void> {
    if (!this.cdp) return
    await this.cdp
      .send('Emulation.setUserAgentOverride', {
        userAgent: browserUserAgent(mode, this.desktopUserAgent),
        ...(mode === 'mobile' ? { platform: MOBILE_PLATFORM } : {})
      })
      .catch(() => {})
  }

  private async readUserAgent(): Promise<string> {
    const ua = await this.page?.evaluate(() => navigator.userAgent).catch(() => '')
    return (ua ?? '').replace(/HeadlessChrome/g, 'Chrome')
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('浏览器尚未启动')
    const target = normalizeUrl(url)
    this.loading = true
    this.pushState()
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      // 导航失败不算会话失败
    } finally {
      this.loading = false
      await this.refreshNavigation()
    }
  }

  async goBack(): Promise<void> {
    await this.page?.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  async goForward(): Promise<void> {
    await this.page?.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  async reload(): Promise<void> {
    await this.page?.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  async dispatchInput(input: import('@fizz/contracts').BrowserInputEvent): Promise<void> {
    if (!this.cdp) return
    if (input.kind === 'mouse') {
      this.buttonsMask = nextButtonsMask(this.buttonsMask, input.type, input.button)
    }
    const command = toCdpCommand(input, this.buttonsMask)
    if (!command) return
    await this.cdp.send(command.method as never, command.params as never).catch(() => {})
  }
}

/** 用户可能只敲了域名 —— 补 http://（cURL 导入同款处理） */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return `https://${trimmed}`
}

function errText(err: unknown): string {
  // 只回第一行（Call log 太啰嗦），但要先剥掉 playwright 附带的终端样式
  return pageErrorMessage(err).split('\n')[0]
}

// ---------------------------------------------------------------------------
// 会话池
// ---------------------------------------------------------------------------

function profileDirOf(sessionId: string): string | null {
  if (!profilesRoot) return null
  return join(profilesRoot, sessionId.replace(/[^a-zA-Z0-9._-]/g, '-'))
}

export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>()

  get(id: string): BrowserSession | undefined {
    return this.sessions.get(id)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  create(id: string, handlers: BrowserSessionHandlers): BrowserSession {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const session = new BrowserSession(id, handlers)
    this.sessions.set(id, session)
    return session
  }

  async close(id: string, reason?: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.close(reason)
  }

  /** 关闭会话并**删除**它的持久化 profile（登录态一并清除）；只在该会话被删除时调用 */
  async purge(id: string): Promise<void> {
    await this.close(id, '会话已删除').catch(() => {})
    const dir = profileDirOf(id)
    if (!dir) return
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  /** 应用退出时调用：不留孤儿浏览器进程 */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.close('应用退出').catch(() => {})))
  }
}

export const browserSessions = new BrowserSessionManager()
