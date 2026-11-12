/**
 * AI 助手面板。
 *
 * ## 两种挂载形态（工具集**互斥**，由 `scope` 决定）
 *
 * - **全局**（`scope = 'project'`）：挂在 app-shell 右侧停靠。只挂项目管理工具
 *   （建 / 删项目、worktree、定时任务…），**没有终端工具** —— 它没有绑定任何终端。
 * - **标签页内嵌**（`scope = 'terminal'`）：终端标签里挂一份，绑定那个终端。只挂那个
 *   终端的工具（执行命令 / 读输出 / 发按键），**没有项目工具** —— 一条绑定终端的会话里
 *   出现「建项目 / 删 worktree」没有语境。
 *
 * ## 会话是**共享的一份池子**，不是「一个面板一段」
 *
 * 两种形态读写的是同一份 `assistantConversations` + `assistantActiveId`（见
 * `slices/assistant.ts`）：在终端助手里聊的内容，打开项目助手照样看得到、能接着聊；
 * 顶栏那个下拉能在历史会话之间切换，也可以开一段新的。落盘在 localStorage
 * （`lib/assistant-history.ts`），重启后仍在同一段上。
 *
 * 挂载只 `ensureAssistantSession`（有当前会话就复用），卸载**不**清 —— 收起 / 展开、
 * 切标签都保持同一段对话。
 *
 * 其余（消息渲染 / 消息操作行 / 审批卡 / 模型 pill）两种形态完全一致。
 *
 * ## 消息可以编辑 / 删除（与主会话同款）
 *
 * 助手历史只有前端一份（服务端每轮收 `history`、自己不存），所以「编辑并重发」就是
 * 本地截断：把该条及其后的消息切掉，再用改后的文本发一轮（见 `resendAssistantMessage`）。
 * 别再把这里换成 ACP 那套只读的 `CopyOnlyActions` —— 那是「历史在 agent 侧」的约束，
 * 助手不成立。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  PanelRightClose,
  Plus,
  Sparkles,
  Terminal,
  Trash2
} from 'lucide-react'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { setAssistantPanelOpen } from '@fizz/agent-kit/shared/lib/assistant-panel'
import { assistantConversationTitle } from '@fizz/agent-kit/shared/lib/assistant-history'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import {
  loadAssistantTarget,
  saveAssistantTarget,
  type AssistantTarget
} from '@fizz/agent-kit/shared/lib/assistant-target'
import { ChatSurface } from '@fizz/agent-kit/features/chat/chat-surface'
import { ConfirmQueue } from '@fizz/agent-kit/features/chat/ConfirmCard'
import { PermissionPill } from '@fizz/agent-kit/features/chat/composer'
import { EditMessageBar } from '@fizz/agent-kit/features/chat/EditMessageBar'
import { MessageActionRow } from '@fizz/agent-kit/features/chat/message-parts'
import { ModelPicker } from '@fizz/agent-kit/features/chat/ModelPicker'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { textOf } from '@fizz/agent-kit/shared/lib/parts'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import { Button } from '@fizz/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup
} from '@fizz/ui/dropdown-menu'

/**
 * 切换器里那一行的时间戳：今天给 `HH:mm`、昨天给「昨天」、更早给 `M-D`。
 *
 * 只用来区分「哪段是哪段」（同一句话开头聊出来的两段会话标题会一样），不做精确到秒的
 * 还原 —— 所以不引日期库。
 */
function shortTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return '昨天'
  return `${d.getMonth() + 1}-${d.getDate()}`
}

export function AssistantPanel({
  className,
  /** 工具作用域：`project` = 只有项目工具；`terminal` = 只有该终端的工具 */
  scope,
  /** `scope === 'terminal'` 时：绑定的终端标签 key（取终端工具 + 工具默认目标） */
  boundTerminalTabKey,
  /** 内嵌形态：收起面板（全局形态不传，收起走顶栏那颗全局开关） */
  onClose
}: {
  className?: string
  scope: 'project' | 'terminal'
  boundTerminalTabKey?: string
  onClose?: () => void
}) {
  const embedded = scope === 'terminal'
  const conversations = useAgentStore((s) => s.assistantConversations)
  const activeId = useAgentStore((s) => s.assistantActiveId)
  const ensureAssistantSession = useAgentStore((s) => s.ensureAssistantSession)
  const newAssistantSession = useAgentStore((s) => s.newAssistantSession)
  const switchAssistantSession = useAgentStore((s) => s.switchAssistantSession)
  const deleteAssistantSession = useAgentStore((s) => s.deleteAssistantSession)
  const setAssistantDraft = useAgentStore((s) => s.setAssistantDraft)
  const sendAssistant = useAgentStore((s) => s.sendAssistant)
  const resendAssistantMessage = useAgentStore((s) => s.resendAssistantMessage)
  const deleteAssistantMessage = useAgentStore((s) => s.deleteAssistantMessage)
  const stopAssistant = useAgentStore((s) => s.stopAssistant)
  // 模型清单镜像(state-ws 快照,设置页增删模型后自动到)
  const modelConfigs = useAgentStore((s) => s.models)
  /**
   * 工具权限档：**直接用全局那一份**（主会话那颗 pill / 「设置 → 通用」改的就是它），
   * 助手面板不另存一个偏好 —— 「工具权限」在 Fizz 里是应用级概念，两处各记一份必然分叉。
   *
   * 生效范围随 scope 不同（见 `AssistantSendInput.permissionMode`）：终端助手三档全生效，
   * 项目助手只认 `readonly`（项目工具的审批是刻意写死的，不受档位放松）。
   */
  const permissionMode = useAgentStore((s) => s.permissionMode)
  const setPermissionMode = useAgentStore((s) => s.setPermissionMode)
  const setAssistantPermissionMode = useAgentStore((s) => s.setAssistantPermissionMode)
  /**
   * 切档：既存全局偏好（下一轮用），也把**这一轮正在跑的助手 run** 的活档改掉 ——
   * 工具闸每次调用现取，切完下一次工具调用立刻生效（与主会话同一套语义）。
   */
  const handlePermissionChange = (mode: typeof permissionMode): void => {
    setPermissionMode(mode)
    setAssistantPermissionMode(mode)
  }

  const session = activeId ? conversations[activeId] : undefined

  /**
   * 挂载 = **确保有当前会话**，不是「开新会话」；卸载也不清。
   *
   * ⚠️ 依赖只有这个函数：面板重渲染不该动对话。全局面板由 app-shell 按开关条件渲染、
   * 内嵌的由 TerminalTabView 按展开状态渲染 —— 所以「重新挂载」恰好就是用户眼里的
   * 「重新打开」，而这里要保证的正是「重开还在」。
   */
  useEffect(() => {
    ensureAssistantSession()
  }, [ensureAssistantSession])

  // 模型偏好:全局一份(跨助手会话),存 localStorage;清单里被删掉的配置视为未选
  const [target, setTarget] = useState<AssistantTarget | null>(() => loadAssistantTarget())
  useEffect(() => {
    saveAssistantTarget(target)
  }, [target])

  /**
   * 模型 pill 的清单：只留**至少带一个模型**的配置（一条都没有的选了也发不出去，
   * 下拉里干脆不出现）。空判定留给 `ModelPicker`，这边不再自己算 targetValue / 标签。
   */
  const modelOptions = useMemo(
    () => modelConfigs.filter((m) => m.models.length > 0),
    [modelConfigs]
  )
  /** 模型项右侧那个上下文窗口数字的兜底值（服务端没配就是 null → 走 ModelPicker 默认） */
  const defaultContextWindow = useAgentStore((s) => s.defaultContextWindow)
  const loadDefaultContextWindow = useAgentStore((s) => s.loadDefaultContextWindow)
  /**
   * 助手面板没有 `ContextRing`，没人替它拉兜底窗口 —— 模型下拉里的窗口数字会一直按
   * `DEFAULT_CONTEXT_WINDOW` 显示，与服务端 `FIZZ_CONTEXT_BUDGET` 对不上。这里补一次；
   * store 内部有缓存，主会话已经拉过就不会再发请求。
   */
  useEffect(() => {
    void loadDefaultContextWindow()
  }, [loadDefaultContextWindow])
  /** 模型下拉里的齿轮 → 「设置 → AI 模型」；与主会话那颗走同一条通路 */
  const { openSettingsTab } = useAppContext()

  /**
   * 切换器里的清单：按更新时间倒序。**空会话不列**（新建了还没说话的那些是噪音），
   * 只有当前这段例外 —— 它得在列表里带着勾，否则用户看不到「我在哪一段」。
   */
  const historyList = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.messages.length > 0 || c.sessionId === activeId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, activeId]
  )
  const activeTitle = session ? assistantConversationTitle(session.messages) : '助手'

  /**
   * 草稿存在现场里（不是本地 `useState`）：收起面板 = 卸载，`useState` 会跟着没，
   * 打了一半的话就白打了。`''` 兜底只是首次挂载那一瞬（`ensure` 还没跑完）。
   */
  const draft = session?.draft ?? ''
  const streaming = !!session?.streaming
  const hasMessages = (session?.messages.length ?? 0) > 0
  /** 「删除这段会话」的二次确认（与设置里删模型 / 删密钥同一个弹窗） */
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * 正在编辑重发的消息（null = 没在编辑）。与主会话同一套语义：原文灌进输入框、
   * 记下重发起点，发送时**先截掉该条及其后的全部消息**再发
   * （`resendAssistantMessage`，纯本地截断 —— 助手历史本来就只有前端一份）。
   *
   * 连 `sessionId` 一起记：消息 id 只在它那段会话里成立，切走之后拿它去截断
   * 就是往另一段里删东西。下面按会话切换清掉。
   */
  const [editing, setEditing] = useState<{
    id: string
    text: string
    sessionId: string
  } | null>(null)
  /** 输入框引用：点「编辑」把焦点还给输入框（与主会话一致） */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 换会话就退出编辑态（草稿刻意不动：用户可能已经改了几个字，清掉比留着更糟）
  const sessionId = session?.sessionId ?? null
  useEffect(() => {
    setEditing(null)
  }, [sessionId])

  /**
   * 只有「属于当前会话、且那条消息还在」的编辑态才算数：消息被删 / 被截断之后
   * 残留的 id 拿去重发只会扑空。派生而不是靠 effect 清，少一次渲染。
   */
  const activeEditing =
    editing &&
    session &&
    editing.sessionId === session.sessionId &&
    session.messages.some((m) => m.id === editing.id)
      ? editing
      : null

  /** 点消息上的「编辑并重发」：原文回填输入框 + 标记起点，聚焦让用户接着改 */
  const startEdit = (message: AgentChatMessage): void => {
    if (!session) return
    const text = textOf(message)
    if (!text) return
    setAssistantDraft(text)
    setEditing({ id: message.id, text, sessionId: session.sessionId })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /** 退出编辑态：清标记 + 清掉输入框里那份草稿（与主会话 `cancelEdit` 同款） */
  const cancelEdit = (): void => {
    setEditing(null)
    setAssistantDraft('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text || streaming) return
    const resendTarget = activeEditing
    if (resendTarget) {
      /**
       * 编辑重发：先摘编辑态再发（发出去的就是「改后的新消息」，输入框里不该还挂着条）。
       * 被拒（这一轮还在跑 / 那条没了）时把编辑态还回去 —— 那几条消息没被删，
       * 用户还停在「编辑它」的语境里（与 `ChatPanelInner` 的 `submit` 同一处理）。
       */
      setEditing(null)
      void resendAssistantMessage(
        resendTarget.id,
        text,
        scope,
        target ?? undefined,
        boundTerminalTabKey ?? null,
        permissionMode
      ).then(
        (ok) => {
          if (ok) setAssistantDraft('')
          else setEditing(resendTarget)
        },
        () => setEditing(resendTarget)
      )
      return
    }
    void sendAssistant(
      text,
      scope,
      target ?? undefined,
      boundTerminalTabKey ?? null,
      permissionMode
    )
    setAssistantDraft('')
  }

  const closePanel = (): void => {
    if (onClose) onClose()
    else setAssistantPanelOpen(false)
  }

  return (
    <div className={className}>
      {/* 顶栏：会话切换器（标题 + 历史会话 + 新建）+ 删除当前会话。
          全局形态（桌面停靠 / 手机浮层）的收起键统一在顶栏右上角的 AI 助手开关上 ——
          手机浮层只盖工作行、盖不到顶栏，那颗键随时点得到，面板里不再重复放一颗；
          终端内嵌形态没有那颗全局开关，才保留「收起助手面板」。 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {embedded ? (
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="切换助手会话"
              title={`${embedded ? '终端助手' : '项目助手'} · ${activeTitle}`}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent/60"
            >
              <span className="truncate">{activeTitle}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="max-h-80 min-w-64 overflow-y-auto">
            <DropdownMenuItem onSelect={() => newAssistantSession()}>
              <Plus className="size-3.5 shrink-0" />
              新建会话
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 text-xs font-normal text-muted-foreground">
                历史会话
              </DropdownMenuLabel>
              {historyList.map((item) => (
                <DropdownMenuItem
                  key={item.sessionId}
                  onSelect={() => switchAssistantSession(item.sessionId)}
                  // 正在跑的那段给个记号：切走之后它还在后台继续（帧仍落到自己那段上）
                  title={assistantConversationTitle(item.messages)}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {assistantConversationTitle(item.messages)}
                  </span>
                  {item.streaming && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">进行中</span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {shortTime(item.updatedAt)}
                  </span>
                  {item.sessionId === activeId && <Check className="size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 删除 = 把这段会话从本地存档里删掉（想开新的用切换器里的「新建会话」） */}
        <Button
          size="icon-sm"
          variant="ghost"
          title={hasMessages ? '删除这段会话' : '还没有对话内容'}
          aria-label="删除这段会话"
          disabled={!hasMessages}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
        {embedded && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="收起助手面板"
            aria-label="收起助手面板"
            onClick={closePanel}
          >
            <PanelRightClose className="size-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      <ConfirmDeleteDialog
        open={confirmDelete}
        title="删除这段会话？"
        // 说清「丢什么、怎么办」：助手历史只有本地一份，删了没有回收站；想留就新建一段
        description={
          // 用字符串表达式拼，而不是把中文散在 JSX 行间：换行会被折叠成一个空格，
          // 「删除后 无法恢复」里多出那个空格很扎眼
          <>
            {'这段对话会从本地存档里删除，助手历史只有本地一份，删除后'}
            <span className="font-medium text-foreground">无法恢复</span>
            {'。只想开一段新的，用标题栏下拉里的「新建会话」。'}
            {streaming && '正在生成的那一轮也会被停止。'}
          </>
        }
        confirmLabel="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          if (activeId) deleteAssistantSession(activeId)
        }}
      />

      <ChatSurface
        list={{
          messages: session?.messages ?? [],
          streaming,
          // 自己发送 / 开始新一轮时同帧落底（seq 在切片里 bump，流式追加不碰它）
          resetKey: `${session?.sessionId ?? ''}#${session?.scrollResetSeq ?? 0}`,
          contentClassName: 'mx-auto w-full px-4 py-4 max-w-3xl',
          error:
            session?.error && !streaming ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {session.error}
              </div>
            ) : undefined,
          emptyState: (
            <div className="flex flex-col items-center gap-2 text-center">
              {embedded ? (
                <Terminal className="size-8 opacity-40" />
              ) : (
                <Sparkles className="size-8 opacity-40" />
              )}
              <div className="text-sm font-medium">
                {embedded ? '让助手操作这个终端' : '让助手帮你管项目'}
              </div>
              <div className="max-w-64 text-xs text-muted-foreground">
                {embedded
                  ? '试试:「看看当前目录」「列出最近的日志文件」「跑一下测试」'
                  : '试试:「列出我的项目」「把 github.com/xxx/yyy 克隆到默认目录」「打开某个项目」'}
              </div>
            </div>
          ),
          /**
           * 操作行就是主会话那一颗（`MessageActionRow`）：助手历史只有前端一份
           * （`slices/assistant.ts`），编辑 / 删除都是纯本地操作。以前这里挂的是 ACP
           * 那套「历史在 agent 侧、改不了」的 `CopyOnlyActions`，把一条不成立的约束
           * 一起继承了过来 —— 结果同一个消息列表，主会话能改、助手不能。
           *
           * 不接「从此签出」：助手没有会话分叉的语义（`onFork` 不传即不渲染）。
           */
          renderActions: ({ message, index, total }) => {
            // 正在编辑的那条不挂：标识交给「输入框里的编辑条 + 这条的描边」，
            // 操作行再杵着只会多一个能点的入口（再点一次「编辑」没意义，
            // 「删除」正对着要重发的内容）
            if (activeEditing?.id === message.id) return null
            const text = textOf(message)
            return (
              <MessageActionRow
                message={message}
                deleteCount={total - index}
                // 只有工具调用、没有正文的那条不给编辑（灌进输入框只会是一段空草稿）
                onEdit={text ? () => startEdit(message) : undefined}
                onDelete={(mode) => deleteAssistantMessage(message.id, mode)}
              />
            )
          },
          /** 编辑中的那条加描边压暗 —— 与输入框里那条「编辑消息」是一对标识 */
          editingMessageId: activeEditing?.id ?? null
        }}
        composer={{
          value: draft,
          onChange: (text) => setAssistantDraft(text),
          onSubmit: submit,
          onCancel: () => stopAssistant(),
          streaming,
          // 占位文案只留「要它干什么」这半句：面板最窄 320px，带上
          // 「(Enter 发送,Shift+Enter 换行)」会折成两行 —— 而紧凑态空态高度被钉成一行，
          // 折行的那半截就被裁掉了。Enter 发送 / Shift+Enter 换行是 Composer 的固定行为
          // （见其文件头注释），面板里不再用占位文案复述。
          placeholder: embedded ? '让助手执行 / 读取这个终端…' : '让助手创建 / 打开 / 删除项目…',
          /**
           * 卡片内（`header` 槽）：编辑重发时那条「编辑消息」提示条 —— 与消息列表里
           * 该条的描边压暗是一对标识，写明「重发会删掉本条及其后的消息」。
           * 助手没有待发送队列 / 插话，这里只会有这一条。
           */
          header: activeEditing ? (
            <EditMessageBar text={activeEditing.text} onCancel={cancelEdit} />
          ) : undefined,
          /** 编辑时把焦点还给输入框（`startEdit` / `cancelEdit` 用） */
          textareaRef,
          variant: 'panel',
          // 窄面板：输入框初始收成一行高（内容变长仍会自己长高）
          compact: true,
          // 工具权限：与主会话同一颗 pill（`PermissionPill`，图标编码档位、档名进 tooltip）。
          // 助手面板是「一句话就让 agent 动手」的入口，没有这一档就等于默认裸跑 ——
          // 终端助手的 run_in_terminal / send_keys 会直接在你眼前那台终端里执行。
          // 只用图标（`CHAT_ICON_PILL`，32px）：面板本来就窄，一颗带文字的 pill 会把
          // 模型 pill 挤掉。
          leading: <PermissionPill value={permissionMode} onChange={handlePermissionChange} />,
          // 模型 pill：**就是主会话那一颗**（`ModelPicker`；`ModelSelect` 是它的会话版薄壳）。
          // 以前这里手写过一份平铺下拉，结果两边分叉成两个功能 —— 二级菜单、上下文窗口、
          // 设置齿轮、手机拍平、中英文案全少了一半。合并后这些只有一份实现。
          // 助手不接 ACP（`showAcp={false}`），下拉里只有「AI 模型」一组。
          trailing: (
            <ModelPicker
              models={modelOptions}
              acpAgents={[]}
              showAcp={false}
              value={
                target
                  ? { backend: 'builtin', configId: target.configId, modelId: target.modelId }
                  : null
              }
              onChange={(next) => {
                // showAcp={false} 时只可能回调 builtin；防御一下别把半截目标写进偏好
                if (next.backend !== 'builtin' || !next.configId || !next.modelId) return
                setTarget({ configId: next.configId, modelId: next.modelId })
              }}
              defaultContextWindow={defaultContextWindow ?? undefined}
              onOpenSettings={openSettingsTab}
              emptyTitle="未选时由服务端取第一份可用模型（下一轮生效）"
            />
          ),
          // 待答复的审批：与主会话同一张卡、同一个答复端点；**顶替输入卡片**（同主会话）
          cover: session && session.pendingConfirms.length > 0 ? (
            <ConfirmQueue
              confirms={session.pendingConfirms}
              onResolve={(id, approved, optionId) => {
                const api = useAgentStore.getState().getApi()
                void api?.resolveConfirm(id, approved, optionId)
              }}
            />
          ) : null
        }}
      />
    </div>
  )
}
