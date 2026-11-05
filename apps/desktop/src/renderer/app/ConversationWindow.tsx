/**
 * 会话浮窗（desktop `?window=conversation`）：**一条会话一个窗口**。
 *
 * 2026-11 改版：窗内**不再**「切换会话」也不再「新建会话」—— 入口下沉到会话详情区
 * （`ConversationTab` 顶栏那颗「在浮窗中打开」，走 `host.openConversationWindow`）。
 * 于是这里只认启动参数里那一条 `conversationId`：会话清单还没到就 loading，id 不在
 * 清单里就是「已不存在」，其余全部交给 `ChatPanel`。
 *
 * 窗口已开着、而用户又点了**另一条**会话的浮窗按钮时，主进程会带着新 id 重新 load 一次
 * 渲染端（见 `main/index.ts` 的 `openConversationWindow`）—— 所以这里不需要任何
 * 「跟着外部切换」的逻辑，`conversationId` 就是这一份文档的真源。
 *
 * Provider 组合是 `ChatPanel` 的真实依赖（缺一即崩或失效）：`AppProvider` 供数据层与
 * 面板现场、`ConfirmProvider` 供审批卡、`DndProvider` 供面板拖拽、`TooltipProvider` 供
 * 各组件的 tooltip —— 少一个就会抛错或点了没反应。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, Folder, MessageSquare, Pin, PinOff, X } from 'lucide-react'
import { Toaster } from '@fizz/ui/sonner'
import { TooltipProvider } from '@fizz/ui/tooltip'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@fizz/ui/empty'
import { Spinner } from '@fizz/ui/spinner'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { AppProvider } from '@fizz/agent-kit/shell/app-provider'
import { ConfirmProvider } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { ChatPanel } from '@fizz/agent-kit/features/chat/ChatPanel'
import { initConversationActivity } from '@fizz/agent-kit/shared/lib/conversation-activity'
import {
  useAgentAppView,
  useAttachRemoteRun,
  type AgentApp
} from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** react-dnd 单例槽必须传，且必须是 window（见 app-shell.tsx 的 DND_CONTEXT 注释） */
const DND_CONTEXT: unknown = typeof window === 'undefined' ? {} : window

const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent)

export function ConversationWindow({ conversationId }: { conversationId?: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TooltipProvider>
        <AppProvider>
          <ConfirmProvider>
            <DndProvider backend={HTML5Backend} context={DND_CONTEXT}>
              {/* `AppProvider` 自己就是 `AppContext.Provider`（见 shell/app-provider.tsx），
                  这里不用再套一层 —— 早先那份「浮窗自带 AppContext」的 shim 是多余的。 */}
              <FloatShell conversationId={conversationId} />
            </DndProvider>
          </ConfirmProvider>
        </AppProvider>
      </TooltipProvider>
    </div>
  )
}

function FloatShell({ conversationId }: { conversationId?: string }) {
  const { theme } = useAppContext()
  // 会话数据（消息 / 流式 / 队列）订这一条；没有 id 时传 null（内容区自己给空态）
  const app = useAgentAppView(conversationId ?? null)
  useAttachRemoteRun(conversationId ?? null)

  /**
   * 运行态事件绑定：**浮窗没有外壳**，`useNotifyWatcher()`（里面调
   * `initConversationActivity()`）挂在 `AppShell` 上，这个窗口没有它的份 —— 不在这里接一次，
   * 服务端广播的「在跑 / 等在确认」永远收不到。幂等，重复调无副作用。
   */
  useEffect(() => {
    initConversationActivity()
  }, [])

  /**
   * 会话态：把 store 活跃会话设成它（发送 / 审批 / 插话都按活跃会话走）。
   *
   * `main.tsx` 在 render 之前已经种过一次（首帧不能空），这里管的是**同一个窗口换了
   * 一条会话**的可能（理论上不会发生：换会话 = 重建窗口，见文件头）—— 留着是为了
   * 开发态 HMR / 未来加「同窗口换会话」时不会静默走错会话。
   */
  useEffect(() => {
    if (conversationId) void useAgentStore.getState().openConversation(conversationId)
  }, [conversationId])

  const conv = conversationId
    ? app.conversations.find((c) => c.id === conversationId)
    : undefined
  /**
   * 顶部中央的标题：会话所属**项目名**（与主窗口顶栏同一口径）；临时会话（不选项目
   * 直接聊时自动建的工作区）改显示会话自己的标题 —— 那种工作区名字恒为「临时会话」，
   * 顶上去等于没有信息。
   */
  const workspace = conv ? app.workspaces.find((w) => w.id === conv.workspaceId) : undefined
  const title = workspace?.scratch
    ? conv?.title?.trim() || '临时会话'
    : workspace?.name ?? conv?.title?.trim() ?? '会话'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toaster theme={theme} position="bottom-right" />
      <FloatTitleBar
        title={title}
        canOpenInMain={!!conversationId}
        onOpenInMain={() => {
          // 主进程把主窗口拉到前台、把 id 递过去；浮窗开着不管（用户可能还要对照着看）。
          void window.fizzWindow.openInMainWindow(conversationId)
        }}
      />
      {/* ⚠️ 这一层必须是 flex 列：`FloatContent` 的根用 `flex-1` 撑满，父级不是 flex 时
          `flex-1` 失效 → ChatPanel 拿不到受限高度（Review Focus #4）。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-2 bg-background">
        <FloatContent conversationId={conversationId} app={app} />
      </div>
    </div>
  )
}

/**
 * 浮窗标题栏：拖拽区 + 置顶（左）+ 会话标题（中）+ 在主窗口打开 / 关闭（右）。
 *
 * 这里**刻意只放窗口级动作**：「切换会话 / 新建会话」已移除（一条会话一个窗口，
 * 换会话就是去主窗口点另一条会话的浮窗按钮），所以别再往这条上挂业务入口。
 */
function FloatTitleBar({
  title,
  canOpenInMain,
  onOpenInMain
}: {
  title: string
  /** 有会话才可跳主窗口；没有会话 id 时没有「那一条」可打开 */
  canOpenInMain: boolean
  onOpenInMain: () => void
}) {
  const [pinned, setPinned] = useState(() => window.fizzWindow.loadAlwaysOnTop())

  return (
    <header className="app-drag flex h-9 shrink-0 items-center gap-1 bg-background px-2">
      {IS_MAC && <div className="w-[76px] shrink-0" />}
      <div className="app-no-drag flex items-center">
        <FloatButton
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => {
            const next = !pinned
            setPinned(next)
            void window.fizzWindow.setAlwaysOnTop(next)
          }}
        >
          {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
        </FloatButton>
      </div>
      <span
        className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground font-bold"
        title={title}
      >
        {title}
      </span>
      <div className="app-no-drag flex items-center">
        {/*
          在主窗口打开：浮窗适合「随手问一句 + 一直摆着」，要正经看长回答 / 开终端时
          还是主窗口。点完不关浮窗：用户常常是想两边对照着看。
        */}
        <FloatButton
          title={canOpenInMain ? '在主窗口打开' : '在主窗口打开（没有会话）'}
          disabled={!canOpenInMain}
          onClick={onOpenInMain}
        >
          <ExternalLink className="size-3.5" />
        </FloatButton>
        <FloatButton title="关闭" destructive onClick={() => void window.fizzWindow.close()}>
          <X className="size-3.5" />
        </FloatButton>
      </div>
    </header>
  )
}

function FloatButton({
  title,
  disabled,
  destructive,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded transition-colors',
        destructive
          ? 'text-muted-foreground hover:bg-destructive hover:text-white'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  )
}

/** 内容区：loading / missing / 这一条会话 */
function FloatContent({
  conversationId,
  app
}: {
  conversationId?: string
  app: AgentApp
}) {
  if (!app.conversationsLoaded)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>正在加载…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  if (!conversationId)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Folder />
          </EmptyMedia>
          <EmptyTitle>没有指定会话</EmptyTitle>
          <EmptyDescription>浮窗只显示一条会话：请在会话右上角点「在浮窗中打开」。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  // 清单里没有它：被删了 / 在别的机器上删的 / 归档后又清掉了
  if (!app.conversations.some((c) => c.id === conversationId))
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquare />
          </EmptyMedia>
          <EmptyTitle>这个会话已不存在</EmptyTitle>
          <EmptyDescription>它可能已经被删除。请回主窗口重新选一条会话。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  // ⚠️ 必须给 `ChatPanel` 一个**弹性列**父容器：`ChatSurface` / `MessageList` 的根都是
  // `flex min-h-0 flex-1 flex-col`，靠父级 flex 分配高度。若父级是普通 block（只写
  // `flex-1` 而不带 `flex`），`flex-1` 不生效 → 面板按内容撑高、输入框被顶到视口外、
  // 消息区没有受限高度可滚（用户实测）。与 `ConversationTab` 同一口径。
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatPanel app={app} panelKey={conversationId} />
    </div>
  )
}
