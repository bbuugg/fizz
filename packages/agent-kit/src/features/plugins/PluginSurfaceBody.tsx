"use client";

/**
 * 插件一屏内容的**取数 + 渲染**（侧栏与标签页共用同一份实现）。
 *
 * ## 内容不在前端算
 *
 * `render()` 跑在**服务端**（插件自己的闭包里，所以它拿得到 config / 凭据 / 连接），
 * 这里拿到的只是「块」。插件因此不需要写 React，也不会往界面注入代码 ——
 * 与 `ctx.ui.icon` 只收 data URI 是同一条规矩的两个面。
 *
 * ## 参数（`params`）
 *
 * 同一个面可以带不同参数开出**多屏**（一个连接一页、一台主机一页…）。参数由宿主
 * 记在标签的登记表里，这里只负责每次请求都把它带上：插件的 `render` / `onAction`
 * 拿到后自己区分实例。
 *
 * ## 动作怎么走
 *
 * 块里可点的项（按钮 / 列表项 / 输入框 / 表单）带 `actionId` → 打给服务端 → 插件的
 * `onAction` 跑完：
 * - 返回 `blocks` → **整面替换**（省一次往返）；
 * - 返回 `openView` → **请求宿主开一个标签页**（这里是「开标签」唯一的落地处：
 *   块里没有「开标签」这种语义，那是宿主的能力，插件只能请求）；
 * - 没说要替换 → 这里自己再拉一遍。
 *
 * 失败一律**toast 原话**：插件报的错通常就是用户要看到的那句（连不上 Redis / 端口被占用…）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type {
  PluginItemAction,
  PluginSurfaceActionResult,
  PluginSurfaceContent,
  PluginToast
} from '@fizz/contracts/agent-api'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { openPluginTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { ITEM_ICON, PluginBlocks } from '@fizz/agent-kit/features/plugins/PluginBlocks'
import { SidebarTopBar } from '@fizz/agent-kit/shared/components/SidebarTopBar'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { Button } from '@fizz/ui/button'
import { PluginDialog } from '@fizz/agent-kit/features/plugins/PluginDialog'
import { PluginClientSurface } from '@fizz/agent-kit/features/plugins/PluginClientSurface'

type SurfaceParams = Record<string, string | number | boolean>

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 插件 `toast(...)` 出来的提示 → sonner（kind 缺省 success；一条一条弹） */
function showToastAll(toasts?: PluginToast[]): void {
  for (const item of toasts ?? []) {
    if (item.kind === 'error') toast.error(item.message)
    else if (item.kind === 'info') toast.info(item.message)
    else if (item.kind === 'warning') toast.warning(item.message)
    else toast.success(item.message)
  }
}

export interface PluginSurfaceBodyProps {
  app: AgentApp
  pluginId: string
  kind: 'sider' | 'view'
  id: string
  /** 这一屏是哪个参数开的（如「哪个连接」）；没用参数的面不传 */
  params?: SurfaceParams
  className?: string
  /**
   * 谁来渲染这一屏（来自界面清单）：
   * - `'server'`（缺省）：下面这套「服务端出块、宿主按块画」；
   * - `'client'`：插件自带 bundle，直接渲染它的 React 组件（`PluginClientSurface`）。
   */
  renderMode?: 'server' | 'client'
  /** client 面的 bundle 版本指纹（变了就重新拉源码） */
  clientRev?: string
  /**
   * 顶栏：插件声明了 `headerActions` 时由调用方传进来。
   *
   * 传了就渲染 `SidebarTopBar`（左边面名、右边图标按钮）—— **它是这个组件现在唯一的
   * 使用者**（内置功能区侧栏的顶栏已全部删除，见 `SidebarTopBar` 文件头）；
   * **不传**就退回原来那行「重新读取」小按钮（其它插件行为不变）。
   *
   * client 面**不吃这个参数**：那块屏幕全归插件，它自己画头。
   */
  topbar?: { label: string; actions: PluginItemAction[] }
}

/**
 * 两条渲染路径的**分流点**。
 *
 * 注意这里是**没有 hook** 的一层：`renderMode` 从 server 切成 client 时（插件作者
 * 后来才加上前端半），React 会把子树整体换掉，而不是在同一个组件实例里换 hook 数量。
 * 直接在下面那个实现里 `if (renderMode === 'client') return …` 会踩 hooks 顺序错误。
 */
export function PluginSurfaceBody(props: PluginSurfaceBodyProps) {
  if (props.renderMode === 'client') {
    return (
      <PluginClientSurface
        app={props.app}
        pluginId={props.pluginId}
        kind={props.kind}
        id={props.id}
        {...(props.params ? { params: props.params } : {})}
        {...(props.clientRev ? { clientRev: props.clientRev } : {})}
        {...(props.className ? { className: props.className } : {})}
      />
    )
  }
  return <ServerPluginSurfaceBody {...props} />
}

function ServerPluginSurfaceBody({
  app,
  pluginId,
  kind,
  id,
  params,
  className,
  topbar
}: PluginSurfaceBodyProps) {
  const [content, setContent] = useState<PluginSurfaceContent | null>(null)
  /** 插件请求弹的对话框（动作结果里的 `openDialog`）；没有就是 null */
  const [dialog, setDialog] = useState<NonNullable<PluginSurfaceActionResult['openDialog']> | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  /** 动作在飞：按钮禁用，免得连点 */
  const t = useT()
  const [busy, setBusy] = useState(false)
  const workspaceId = app.activeWorkspaceId ?? undefined
  // 参数是对象，直接进依赖数组每次都是「变了」—— 用它的稳定序列化做依赖
  const paramsKey = params ? JSON.stringify(params) : ''

  /** 按插件的请求开一个标签页（面板只在对话视图渲染，不在那儿就先切过去） */
  const openInView = useCallback(
    (req: NonNullable<PluginSurfaceActionResult['openView']>): void => {
      openPluginTab({
        pluginId,
        surfaceId: req.surfaceId,
        ...(req.params ? { params: req.params } : {}),
        label: req.label?.trim() || t('插件'),
        title: req.title?.trim() || req.label?.trim() || t('插件界面')
      })
    },
    [pluginId, t]
  )

  const load = useCallback(async (): Promise<void> => {
    if (!app.api) return
    setLoading(true)
    try {
      const parsed = paramsKey ? (JSON.parse(paramsKey) as SurfaceParams) : undefined
      const content = await app.api.renderPluginSurface(pluginId, kind, id, workspaceId, parsed)
      showToastAll(content.toasts)
      setContent(content)
    } catch (err) {
      // 请求本身失败（网络 / 401）才走这里；插件 render 抛错是**结果里的 error 字段**
      setContent({ key: '', blocks: [], error: messageOf(err), renderedAt: Date.now() })
    } finally {
      setLoading(false)
    }
  }, [app.api, pluginId, kind, id, workspaceId, paramsKey])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 打一个动作给插件。**返回是否成功** —— 对话框靠它决定「能不能关」。
   */
  const runAction = useCallback(
    async (actionId: string, args?: SurfaceParams): Promise<boolean> => {
      if (!app.api) return false
      setBusy(true)
      let fine = true
      try {
        const parsed = paramsKey ? (JSON.parse(paramsKey) as SurfaceParams) : undefined
        const result = await app.api.runPluginSurfaceAction({
          pluginId,
          kind,
          id,
          actionId,
          ...(args ? { args } : {}),
          ...(parsed ? { params: parsed } : {}),
          ...(workspaceId ? { workspaceId } : {})
        })
        showToastAll(result.toasts)
        if (result.error) {
          toast.error(result.error)
          fine = false
        } else {
          if (result.message) toast.success(result.message)
          if (result.blocks) {
            setContent({ key: '', blocks: result.blocks, renderedAt: Date.now() })
          }
          if (result.openView) openInView(result.openView)
          if (result.openDialog) setDialog(result.openDialog)
          // 既没给新内容、也没让宿主开什么 → 自己再拉一遍，让界面反映插件刚改过的状态
          if (!result.blocks && !result.openView && !result.openDialog) await load()
        }
      } catch (err) {
        toast.error(messageOf(err))
        fine = false
      } finally {
        setBusy(false)
      }
      return fine
    },
    [app.api, pluginId, kind, id, workspaceId, paramsKey, load, openInView]
  )

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {topbar ? (
        /* 插件声明了顶栏：与 AI Agent 侧栏同一条（左边名字、右边图标按钮），
           原来那行「重新读取」由插件自己的「刷新」动作取代（同一个动作不摆两处） */
        <SidebarTopBar
          label={topbar.label}
          extra={
            <>
              {topbar.actions.map((action) => {
                const Icon = ITEM_ICON[action.icon]
                return (
                  <IconTip key={action.actionId} label={action.label}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-8! p-0! text-muted-foreground hover:text-foreground"
                      aria-label={action.label}
                      disabled={busy || !app.api}
                      onClick={() => void runAction(action.actionId, action.args)}
                    >
                      <Icon className="size-4.5" />
                    </Button>
                  </IconTip>
                )
              })}
            </>
          }
        />
      ) : (
        <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
          <button
            type="button"
            aria-label={t("重新读取这一面")}
            title={t("重新读取（插件的 render 会在服务端再跑一次）")}
            disabled={loading || busy || !app.api}
            onClick={() => void load()}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60"
          >
            <RotateCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {loading && !content ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t("读取中…")}</p>
        ) : content?.error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[0.6875rem] leading-4 break-words text-destructive">
            {content.error}
          </p>
        ) : (
          <PluginBlocks
            blocks={content?.blocks ?? []}
            onAction={(actionId, args) => void runAction(actionId, args)}
            busy={busy}
          />
        )}
      </div>

      {/* 插件请求的对话框（新增 / 编辑一条配置这类交互）；没有就 null */}
      {dialog && (
        <PluginDialog
          request={dialog}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(actionId, args) => runAction(actionId, args)}
        />
      )}
    </div>
  )
}
