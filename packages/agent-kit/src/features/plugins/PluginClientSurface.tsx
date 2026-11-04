'use client'

/**
 * 插件**前端半**的一屏（`renderMode: 'client'` 的面）。
 *
 * 与 `PluginSurfaceBody`（服务端 blocks）并列的两条渲染路径之一，由 `PluginSurfaceBody`
 * 顶层的无 hook 分流决定走哪条。
 *
 * ## 为什么单独一个组件、还要一层 ErrorBoundary
 *
 * 这些界面是**别人的代码**（插件自带的 bundle），在浏览器里和主界面同一个 React 树里跑。
 * 它抛一个错 / 引用一个不存在的 hook，React 会把整棵树卸载 —— 用户看到的是白屏。
 * 所以：每次 `render` 外面包一层 boundary，崩了只显示这一屏的错误 + 重试按钮。
 *
 * ## 顶栏
 *
 * client 面**不渲染宿主顶栏**：这块屏幕全归插件，它自己画头、自己放按钮。
 * 宿主只保留「刷新 / 重试」这种插件不该管的东西（出错时才出现）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { openPluginTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { Button } from '@fizz/ui/button'
import { Spinner } from '@fizz/ui/spinner'
import {
  loadPluginClient,
  unloadPluginClient,
  type PluginClientModule,
  type PluginClientRenderContext
} from '@fizz/agent-kit/features/plugins/plugin-client'

type SurfaceParams = Record<string, string | number | boolean>

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 插件界面的错误边界。
 *
 * `key` 由调用方带上（`pluginId:clientRev:surfaceId`）—— 换插件 / 换版本 / 换面时
 * 整个 boundary 重建，否则 React 会记住上一次的 `hasError`，界面永远停在错误页。
 */
class PluginSurfaceBoundary extends React.Component<
  {
    children: React.ReactNode
    /** 标题 / 重试按钮的文案：class 组件调不了 hook，由调用方用 `tr()` 传进来 */
    title: string
    retryLabel: string
    onError: (error: Error) => void
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // 交给调用方落一行日志：插件崩了要能说清是哪一屏
    this.props.onError(error)
  }

  render(): React.ReactNode {
    const error = this.state.error
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="size-6 text-destructive" />
        <p className="text-sm text-foreground">{this.props.title}</p>
        <p className="max-w-md break-words text-xs text-muted-foreground">{messageOf(error)}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => this.setState({ error: null })}
          className="gap-1.5"
        >
          <RotateCw className="size-3.5" />
          {this.props.retryLabel}
        </Button>
      </div>
    )
  }
}

export function PluginClientSurface({
  app,
  pluginId,
  kind,
  id,
  params,
  clientRev,
  className
}: {
  app: AgentApp
  pluginId: string
  kind: 'sider' | 'view'
  id: string
  params?: SurfaceParams
  /** 界面清单带来的版本指纹（缺省时每次挂载都重新拉，安全但没有缓存收益） */
  clientRev?: string
  className?: string
}) {
  const [module, setModule] = useState<PluginClientModule | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const workspaceId = app.activeWorkspaceId ?? undefined
  const tr = useT()

  /*
   * `app.api` **每次渲染都是新对象**（`agentAppFrom` 里 `getApi()` 现造），绝不能进
   * effect 的依赖数组 —— 流式输出期间每来一个 token 就重渲染，effect 每帧重跑，
   * 等于每个 token 拉一次 bundle 源码。这里只依赖「连上了没有」这个布尔值，
   * 真正要用的 api 从 ref 现取。
   */
  const api = app.api
  const apiRef = useRef(api)
  apiRef.current = api
  const connected = Boolean(api)

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    setError(null)
    setModule(null)
    void loadPluginClient({
      pluginId,
      rev: clientRev ?? String(attempt),
      fetchCode: async () => {
        const current = apiRef.current
        if (!current) throw new Error(tr('还没连上服务端'))
        // 项目级插件只在项目插件根里：不带 workspaceId 会 404
        return await current.loadPluginClient(pluginId, workspaceId)
      }
    })
      .then((loaded) => {
        if (!cancelled) setModule(loaded)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err))
      })
    return () => {
      cancelled = true
    }
  }, [connected, pluginId, workspaceId, clientRev, attempt])

  /** 插件调服务端半的方法：`ctx.rpc('list')` */
  const rpc = useCallback(
    async <T,>(method: string, payload?: unknown): Promise<T> => {
      const current = apiRef.current
      if (!current) throw new Error(tr('还没连上服务端'))
      const result = await current.pluginRpc({
        pluginId,
        method,
        ...(payload === undefined ? {} : { payload }),
        ...(workspaceId ? { workspaceId } : {})
      })
      if (!result.ok) {
        throw new Error(result.error || tr('插件方法「{method}」调用失败', { method }))
      }
      return result.data as T
    },
    [pluginId, workspaceId, tr]
  )

  const notify = useMemo(
    () => ({
      success: (message: string) => toast.success(message),
      error: (message: string) => toast.error(message),
      info: (message: string) => toast.info(message),
      warning: (message: string) => toast.warning(message)
    }),
    []
  )

  /**
   * 插件请求开标签页。与服务端 blocks 那条路的 `openView` 结果**走同一个入口**
   * （`openPluginTab`）：同一个面 + 同一份 params 只聚焦已有标签，不重复开。
   * 文案缺省值也保持一致，免得两条路的标签名一个叫「插件」一个叫「插件界面」。
   */
  const openView = useCallback(
    (req: Parameters<PluginClientRenderContext['openView']>[0]) => {
      openPluginTab({
        pluginId,
        surfaceId: req.surfaceId,
        ...(req.params ? { params: req.params } : {}),
        label: req.label?.trim() || tr('插件'),
        title: req.title?.trim() || req.label?.trim() || tr('插件界面')
      })
    },
    [pluginId, tr]
  )

  const context = useMemo<PluginClientRenderContext>(
    () => ({
      pluginId,
      surfaceId: id,
      kind,
      ...(params ? { params } : {}),
      openView,
      rpc,
      notify
    }),
    [pluginId, id, kind, params, openView, rpc, notify]
  )

  const retry = useCallback(() => {
    // 重试 = 丢掉这个插件的模块缓存再加载一次：多半是作者刚改完 bundle
    unloadPluginClient(pluginId)
    setAttempt((value) => value + 1)
  }, [pluginId])

  if (error) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-6', className)}>
        <AlertTriangle className="size-6 text-destructive" />
        <p className="text-sm text-foreground">{tr('插件界面加载失败')}</p>
        <p className="max-w-md break-words text-xs text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={retry} className="gap-1.5">
          <RotateCw className="size-3.5" />
          {tr('重试')}
        </Button>
      </div>
    )
  }

  if (!module) {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className={cn('h-full min-h-0 overflow-hidden', className)}>
      <PluginSurfaceBoundary
        key={`${pluginId}:${clientRev ?? attempt}:${id}`}
        title={tr('插件界面崩了')}
        retryLabel={tr('重试')}
        onError={(err) => console.error(`[plugin ${pluginId}] ${kind}/${id} 渲染失败`, err)}
      >
        {module.render(id, context)}
      </PluginSurfaceBoundary>
    </div>
  )
}
