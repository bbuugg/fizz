'use client'

/**
 * 插件**前端半**的运行时：拉源码 → 执行 → 拿到 `render`，并把宿主的模块表递进去。
 *
 * ## bundle 契约
 *
 * 插件的 `client.entry`（预构建的单文件 JS）顶层只做一件事：
 *
 * ```js
 * window.__FIZZ_PLUGIN__('redis', (host) => {
 *   const { React, ui, icons } = host
 *   return {
 *     render(surfaceId, ctx) {
 *       return React.createElement(ui.Button, { onClick: () => ctx.rpc('flush') }, 'Flush')
 *     }
 *   }
 * })
 * ```
 *
 * - 顶层**同步**注册（异步注册一律视为失败：宿主只等这一次 `new Function` 执行完）；
 * - `render` 每次渲染都会被调用，必须返回 ReactNode。它是**纯渲染**：宿主在自己的渲染
 *   函数里同步调它，所以**不能在 `render` 里调 hooks** —— hook 顺序会随面 / 版本切换而变。
 *   要状态就 `return React.createElement(YourSurface, ctx)`，hooks 写在那个组件里；
 * - `ctx.rpc(method, payload)` 是它拿数据的**唯一**通道（见 `packages/plugin/src/services/rpc.ts`）；
 * - `ctx.openView({ surfaceId, params })` 是它**开新标签**的唯一手段（侧栏 → 详情页）。
 *
 * ## 为什么是 `new Function` 而不是 `<script src>`
 *
 * desktop 的渲染进程没有 HTTP 端口（渲染端 ↔ 服务端只有 IPC 桥），`<script src>` 发不出去；
 * `<script>` 也带不了 `authorization` 头，开了鉴权就等于所有插件 UI 全白。
 * 三端共用一条 JSON 通道，所以只能把源码取回来自己执行。仓库里**没有任何 CSP**，不会被拦。
 *
 * ## React 单例
 *
 * 模块表里的 `React` 就是宿主那一份。插件 bundle 若自带一份 React，hooks 会在
 * 「自己那份 dispatcher 是 null」上直接炸 —— 这是刻意的：报错比「安静地画不出来」好查。
 */

import * as React from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X
} from 'lucide-react'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@fizz/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { Progress } from '@fizz/ui/progress'
import { ScrollArea } from '@fizz/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { Separator } from '@fizz/ui/separator'
import { Skeleton } from '@fizz/ui/skeleton'
import { Spinner } from '@fizz/ui/spinner'
import { Switch } from '@fizz/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@fizz/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import { Textarea } from '@fizz/ui/textarea'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 插件常用图标（bundle 也可以自己打包 lucide，这里只是省事） */
const PLUGIN_ICONS = {
  AlertTriangle,
  Check,
  ChevronDown,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings: Settings2,
  Square,
  Trash2,
  X
}

/** 传给插件 bundle 的模块表（**唯一**依赖来源，插件不该自带这些） */
export interface PluginClientHost {
  /** 宿主那份 React（含全部 hooks） */
  React: typeof React
  /** `React.createElement` 的别名，写起来短一点 */
  h: typeof React.createElement
  ui: {
    Badge: typeof Badge
    Button: typeof Button
    Card: typeof Card
    CardContent: typeof CardContent
    CardHeader: typeof CardHeader
    CardTitle: typeof CardTitle
    /**
     * 弹窗全套（radix + 宿主样式，Portal 到 `document.body`）。
     *
     * 为什么必须由宿主给：自绘遮罩会漏掉 focus trap / `Esc` / 滚动锁，
     * 而这些在一个 200px 宽的侧栏里出问题时最难查。
     */
    Dialog: typeof Dialog
    DialogClose: typeof DialogClose
    DialogContent: typeof DialogContent
    DialogDescription: typeof DialogDescription
    DialogFooter: typeof DialogFooter
    DialogHeader: typeof DialogHeader
    DialogTitle: typeof DialogTitle
    Input: typeof Input
    Label: typeof Label
    Progress: typeof Progress
    ScrollArea: typeof ScrollArea
    Select: typeof Select
    SelectContent: typeof SelectContent
    SelectItem: typeof SelectItem
    SelectTrigger: typeof SelectTrigger
    SelectValue: typeof SelectValue
    Separator: typeof Separator
    Skeleton: typeof Skeleton
    Spinner: typeof Spinner
    Switch: typeof Switch
    Table: typeof Table
    TableBody: typeof TableBody
    TableCell: typeof TableCell
    TableHead: typeof TableHead
    TableHeader: typeof TableHeader
    TableRow: typeof TableRow
    Tabs: typeof Tabs
    TabsContent: typeof TabsContent
    TabsList: typeof TabsList
    TabsTrigger: typeof TabsTrigger
    Textarea: typeof Textarea
  }
  icons: typeof PLUGIN_ICONS
  lib: { cn: typeof cn }
  /**
   * 往文档里塞一段 CSS（自动去重、按插件打标记）。
   *
   * 为什么由宿主管：插件被卸载 / 换了 bundle 之后，它注入的规则必须能被**精准摘掉**。
   * 让插件自己 `document.head.appendChild` 的话，那些规则会一直留着，
   * 换一个插件（或换了版本）就串味。
   */
  injectStyle: (css: string) => void
}

/** 一次 `render` 的上下文 */
export interface PluginClientRenderContext {
  pluginId: string
  /** manifest 里那句 `client.surfaces[].id` */
  surfaceId: string
  kind: 'sider' | 'view'
  /** 这一面被打开时的参数（「一个连接一页」这种） */
  params?: Record<string, string | number | boolean>
  /**
   * 请宿主在主视图区**开一个标签页**（同一个面 + 不同 `params` = 另一页）。
   *
   * 标签是宿主的东西（key 分配、拖拽分屏、关闭保护都归它），插件只能请求 ——
   * 与服务端 blocks 那条路的 `openView` 动作结果是同一件事，只是这里直接是函数调用。
   * 侧栏「点一条连接 → 开出它的详情页」就靠它。
   */
  openView: (req: {
    /** 要打开哪个面（`client.surfaces[].id`；也可以是服务端 `ctx.ui.view` 的 id） */
    surfaceId: string
    params?: Record<string, string | number | boolean>
    /** 标签上的短名字（缺省「插件」） */
    label?: string
    /** 悬浮标题（缺省同 `label`） */
    title?: string
  }) => void
  /** 调插件服务端半注册的方法；失败会抛错（消息是插件写的那句） */
  rpc: <T = unknown>(method: string, payload?: unknown) => Promise<T>
  notify: {
    success: (message: string) => void
    error: (message: string) => void
    info: (message: string) => void
    warning: (message: string) => void
  }
}

export interface PluginClientModule {
  render: (surfaceId: string, ctx: PluginClientRenderContext) => React.ReactNode
  /** 插件被卸载 / 换版本时调（清定时器、关连接用） */
  dispose?: () => void
}

type PluginClientFactory = (host: PluginClientHost) => PluginClientModule | void

declare global {
  interface Window {
    /** 插件 bundle 的注册入口（只在加载的那一瞬存在） */
    __FIZZ_PLUGIN__?: (pluginId: string, factory: PluginClientFactory) => void
  }
}

const STYLE_ATTR = 'data-fizz-plugin'

/** 把一段 CSS 挂上文档（同插件只留一段，便于热重载反复调用） */
function injectStyleFor(pluginId: string, css: string): void {
  if (typeof document === 'undefined' || !css) return
  const selector = `style[${STYLE_ATTR}="${CSS.escape(pluginId)}"]`
  const existing = document.querySelector<HTMLStyleElement>(selector)
  if (existing) {
    // 每次 render 都追加的话，改十次就有十份重复规则
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTR, pluginId)
  style.textContent = css
  document.head.appendChild(style)
}

/** 摘掉某个插件注入的样式（卸载 / 版本切换时调） */
export function clearPluginStyles(pluginId: string): void {
  if (typeof document === 'undefined') return
  for (const node of document.querySelectorAll(
    `style[${STYLE_ATTR}="${CSS.escape(pluginId)}"]`
  )) {
    node.remove()
  }
}

function buildHost(pluginId: string): PluginClientHost {
  return {
    React,
    h: React.createElement,
    ui: {
      Badge,
      Button,
      Card,
      CardContent,
      CardHeader,
      CardTitle,
      Dialog,
      DialogClose,
      DialogContent,
      DialogDescription,
      DialogFooter,
      DialogHeader,
      DialogTitle,
      Input,
      Label,
      Progress,
      ScrollArea,
      Select,
      SelectContent,
      SelectItem,
      SelectTrigger,
      SelectValue,
      Separator,
      Skeleton,
      Spinner,
      Switch,
      Table,
      TableBody,
      TableCell,
      TableHead,
      TableHeader,
      TableRow,
      Tabs,
      TabsContent,
      TabsList,
      TabsTrigger,
      Textarea
    },
    icons: PLUGIN_ICONS,
    lib: { cn },
    injectStyle: (css) => injectStyleFor(pluginId, css)
  }
}

/**
 * 执行一段 bundle 源码，取出它注册的模块。
 *
 * 注册是**同步**的：`new Function(code)()` 这一行里插件必须调完 `__FIZZ_PLUGIN__`。
 * 这样宿主不需要「等一个可能永远不来的回调」，也不会出现「脚本报错但界面一直转圈」。
 */
function evaluateBundle(pluginId: string, code: string): PluginClientModule {
  const previous = window.__FIZZ_PLUGIN__
  let factory: PluginClientFactory | undefined
  window.__FIZZ_PLUGIN__ = (id, incoming) => {
    // 只认自己那一条：bundle 里写错 id 是最常见的低级错误，直接报出来
    if (id === pluginId) factory = incoming
  }
  try {
    // eslint-disable-next-line no-new-func -- 见文件头「为什么是 new Function」
    new Function(code)()
  } finally {
    window.__FIZZ_PLUGIN__ = previous
  }
  if (!factory) {
    throw new Error(
      `插件「${pluginId}」的前端 bundle 没有调用 window.__FIZZ_PLUGIN__('${pluginId}', factory)` +
        '（注册必须在顶层同步执行；动态 import 里注册的那种，宿主等不到）'
    )
  }
  const mod = factory(buildHost(pluginId))
  if (!mod || typeof mod.render !== 'function') {
    throw new Error(`插件「${pluginId}」的前端 bundle 没有返回 { render(surfaceId, ctx) }`)
  }
  return mod
}

/** 已加载的 bundle：`pluginId` → 版本号 + 模块（版本变了就换） */
const loaded = new Map<string, { rev: string; module: PluginClientModule }>()
/** 正在加载的（同一个面并发渲染时只跑一次） */
const inflight = new Map<string, Promise<PluginClientModule>>()

/**
 * 加载（或复用）一个插件的前端 bundle。
 *
 * `rev` 来自界面清单（服务端按 bundle 的 mtime+size 算）。变了就重新拉、重新执行，
 * 并把旧模块的 `dispose` 与它注入的样式一并清掉 —— 作者改 `client.js` 之后用户刷一下
 * 就能看到，不必重启（服务端半本来就是每轮热加载的，前端半不热更会非常割裂）。
 */
export async function loadPluginClient(opts: {
  pluginId: string
  rev: string
  /** 取源码（走 `app.api.loadPluginClient`） */
  fetchCode: () => Promise<{ code: string; rev: string }>
}): Promise<PluginClientModule> {
  const { pluginId, rev } = opts
  const cached = loaded.get(pluginId)
  if (cached && cached.rev === rev) return cached.module

  const running = inflight.get(pluginId)
  if (running) return await running

  const task = (async () => {
    const { code } = await opts.fetchCode()
    const previous = loaded.get(pluginId)
    if (previous) {
      // 换版本之前先收拾旧世界：定时器、连接、注入的 CSS
      try {
        previous.module.dispose?.()
      } catch {
        /* 插件的 dispose 自己炸了不该连累新版本加载 */
      }
      clearPluginStyles(pluginId)
    }
    const module = evaluateBundle(pluginId, code)
    loaded.set(pluginId, { rev, module })
    return module
  })()

  inflight.set(pluginId, task)
  try {
    return await task
  } finally {
    inflight.delete(pluginId)
  }
}

/** 卸载一个插件的前端半（插件被删 / 停用时调） */
export function unloadPluginClient(pluginId: string): void {
  const entry = loaded.get(pluginId)
  if (entry) {
    try {
      entry.module.dispose?.()
    } catch {
      /* 卸载阶段的异常不往外抛 */
    }
    loaded.delete(pluginId)
  }
  clearPluginStyles(pluginId)
}

/**
 * 只保留 `keep` 里这些插件的模块，其余就地卸载。
 *
 * 由界面清单的 store 在每次刷新后调用：插件被停用 / 删掉 / 改回纯服务端之后，
 * 它注册的定时器、事件监听、注入的 CSS 必须立刻释放 —— 否则用户「卸了插件还看到
 * 它在后台每分钟请求一次」，只能靠重启应用解决。
 */
export function retainPluginClients(keep: Set<string>): void {
  for (const pluginId of [...loaded.keys()]) {
    if (!keep.has(pluginId)) unloadPluginClient(pluginId)
  }
}

/** 当前已加载的插件 id（排障 / 测试用） */
export function loadedPluginClients(): string[] {
  return [...loaded.keys()].sort()
}
