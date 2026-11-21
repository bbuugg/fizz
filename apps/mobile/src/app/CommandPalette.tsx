/**
 * 命令面板（Ctrl/Cmd + Shift + P）：Agent 应用的所有功能统一入口。
 *
 * 与根应用的 CommandPalette 同一定位，但用 shadcn 的 Command（cmdk）实现：
 * 搜索 / 键盘导航（↑↓ 选择、Enter 执行、Esc 关闭）由 cmdk 内置，
 * 这里只负责「命令从哪来」—— 工作区、会话、视图开关、设置 / 主题。
 * 底部固定一行键位提示（CommandFooter）把内置行为写出来给人看，文案随层级变。
 * 快捷键不在组件内监听：打开快捷键由宿主 AgentApp 统一分发（可配置）。
 *
 * ## 二级命令
 *
 * 命令可以是「目录」：选中后面板不关，整块内容切换成该命令的二级视图
 * （如「搜索会话」）。mode 记录当前层级；Esc 在二级先清词、清完退回根级，
 * 最后才轮到关面板（拦截挂在 CommandDialog 的 onEscapeKeyDown 上，Radix 层）。
 * 面板高度固定，二级切换不改变外观，只有功能与列表内容变化。
 */
import { CommandPaletteSearch } from '@/app/CommandPaletteSearch'
import { ScriptPaletteList } from '@fizz/agent-kit/features/scripts/ScriptPaletteList'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { formatShortcut } from '@fizz/agent-kit/shared/lib/shortcuts'
import { openTunnelTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import type { HostConfig } from '@fizz/contracts/types'
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '@fizz/ui/command'
import {
  ArrowLeft,
  ChevronRight,
  FileCode2,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  Network,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Sun
} from 'lucide-react'
import { useState } from 'react'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'

/** 二级命令视图：root = 根级命令列表；其余为某个命令展开的二级功能 */
type PaletteMode = 'root' | 'search-sessions' | 'hosts' | 'scripts'

export function CommandPalette({
  app,
  open,
  onOpenChange,
  onOpenConversation,
  shortcuts,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenHost
}: {
  app: AgentApp
  /** 受控开关：快捷键分发在宿主 */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 打开一个会话：走宿主统一入口（跨项目先切项目、切到对话视图、写 URL） */
  onOpenConversation: (conversationId: string, workspaceId?: string) => void
  /** 当前快捷键配置：给命令行展示组合键提示 */
  shortcuts: { action: string; accelerator: string }[]
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
  /**
   * 打开一台 SSH 主机：在主区域**新开一个内容标签**（一条到它的终端）。
   *
   * 落点与「主机」侧栏点一行完全一致 —— 两个入口走同一条路（`app/layout/tool-tabs.ts`），
   * 免得「命令面板开出来的终端」和「侧栏开出来的终端」两处行为慢慢分叉。
   * 主机配置在「主机」功能区里维护，这里只负责用。
   */
  onOpenHost: (host: HostConfig) => void
}) {
  /** 「打开隧道面板」要落在会渲染内容标签的视图上，与主机 / SFTP 入口同一条路 */

  /** 当前层级：根级命令列表 / 某个二级命令视图 */
  const [mode, setMode] = useState<PaletteMode>('root')
  /** 二级搜索词：状态放这层而不是二级视图里 —— Esc「先清词再返回」在这层拦截处理 */
  const [keyword, setKeyword] = useState('')
  /**
   * 根级输入框里**已经敲的词**。
   *
   * 只服务一件事：「搜索会话」那一行换成「在所有会话中搜索『xx』」，并把词带进二级视图。
   * 根级清单的过滤仍然交给 cmdk，这里不参与任何过滤逻辑 —— 所以它晚一拍更新也无所谓。
   */
  const [rootQuery, setRootQuery] = useState('')

  /** 面板每次打开都从根级开始；关掉时把二级现场清掉，下次进来是干净的命令列表 */
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setMode('root')
      setKeyword('')
      setRootQuery('')
    }
    onOpenChange(next)
  }

  /** 从二级退回根级命令列表（根级输入框会重新挂载成空的，`rootQuery` 要跟着清） */
  const backToRoot = (): void => {
    setKeyword('')
    setRootQuery('')
    setMode('root')
  }

  /** 找动作当前的快捷键展示文本（未绑定返回 undefined，不渲染提示） */
  const hint = (action: string): string | undefined => {
    const cfg = shortcuts.find((s) => s.action === action)
    return cfg?.accelerator ? formatShortcut(cfg.accelerator) : undefined
  }

  /**
   * 执行命令：统一收口「跑完就关面板」。
   *
   * ⚠️ 走 `handleOpenChange` 而不是直接 `onOpenChange`：后者不清二级现场，
   * 从搜索结果里点开一条会话之后 `mode` 会停在 `search-sessions`，下次打开面板
   * 直接进搜索页（看起来像「命令列表没了」）。
   */
  const run = (action: () => void): (() => void) => {
    return () => {
      handleOpenChange(false)
      action()
    }
  }

  const activeWorkspaceId = app.activeWorkspaceId

  /**
   * 底部键位提示：必须跟着层级走 —— 二级视图里 Esc 是「返回上一级」而不是「关闭面板」
   * （行为见 onEscapeKeyDown 的拦截），文案照抄根级会教错用户。
   */
  const footerHint =
    mode === 'root' ? '↑↓ 选择 · Enter 执行 · Esc 关闭' : '↑↓ 选择 · Enter 打开 · Esc 返回'

  /**
   * 各层级的标题 / 描述：Radix 的 Dialog 用这对字段做无障碍名，二级视图必须跟着换，
   * 否则读屏听到的还是「命令面板」。
   */
  const viewMeta =
    mode === 'root'
      ? { title: '命令面板', description: '搜索并执行命令' }
      : mode === 'hosts'
        ? { title: '主机', description: '选一台主机，在内容区域打开它的终端' }
        : mode === 'scripts'
          ? { title: '脚本', description: '选一个脚本，挑一台主机运行它' }
          : { title: '搜索会话', description: '按标题与消息内容搜索全部会话' }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={viewMeta.title}
      description={viewMeta.description}
      // 与桌面 / 网页端一致：不摆关闭按钮（Esc / 点外部即可关）
      showCloseButton={false}
      className="h-[min(480px,85dvh)] max-w-[480px]"
      commandProps={{
        // 二级搜索视图的命中来自服务端（含消息正文），不能再被 cmdk 按标题筛一遍
        ...(mode === 'search-sessions' ? { shouldFilter: false } : {}),
        onValueChange: setRootQuery
      }}
      onEscapeKeyDown={(event) => {
        if (mode === 'root') return
        // 二级模式下 Esc 不关面板：有关键词先清词，清完才退回根级。
        // preventDefault 挡住 Radix 的「Esc = 关闭」，行为在这里统一做（不依赖焦点在输入框上）。
        event.preventDefault()
        if (keyword.trim()) setKeyword('')
        else backToRoot()
      }}
    >
      {mode === 'root' ? (
        <>
          {/* autoFocus 兜两条路径：面板打开（与 Radix 的初始聚焦同目标）、从二级视图返回根级 */}
          <CommandInput placeholder="输入命令名称…" autoFocus />
          <CommandList className="min-h-0 max-h-none flex-1">
            <CommandEmpty>没有匹配的命令。</CommandEmpty>

            {/* 主机：带二级 —— 选中不直接连，先列出主机（根级只放一个入口，免得主机多了刷屏）。
                主机清单在「主机」功能区里维护（活动栏最左那个服务器图标），没有配置过就整组不出现
                （省得点进去是空的）。

                「运行脚本」也收在这一组：脚本只跑在主机上（运行对话框里就是挑一台主机），
                和主机清单放一起比单开一组「脚本」更顺 —— 所以不再有「脚本」分组，也不再放
                「管理脚本」那一行（那件事在主机侧栏顶部的「脚本」按钮上）。 */}
            {app.sshHosts.length > 0 && (
              <CommandGroup heading="主机">
                <CommandItem
                  keywords={['ssh', 'host', '主机', '远程', 'terminal', '终端']}
                  onSelect={() => {
                    setKeyword('')
                    setMode('hosts')
                  }}
                >
                  <Server />
                  <span>主机</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {app.sshHosts.length}
                  </span>
                  <ChevronRight />
                </CommandItem>
                {/* SSH 隧道：全局单例面板（隧道列表横跨多台主机，所以不按主机开二级）。
                    ⚠️ 监听端口开在**跑 server 的那台机器**上，不是本机浏览器这台。 */}
                <CommandItem
                  keywords={['tunnel', '隧道', '转发', 'forward', 'socks', '代理', 'port']}
                  onSelect={run(() => {
                    openTunnelTab()
                  })}
                >
                  <Network />
                  <span>SSH 隧道</span>
                  <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                    本地 / 远程转发 · SOCKS5
                  </span>
                </CommandItem>
                {/* 运行脚本：带二级 —— 根级只放入口（脚本一多，全铺在命令列表里就没法用了）。
                    二级里**选中一个脚本 = 运行它**，不是打开编辑：编辑在脚本清单那一页的
                    卡片上（`scripts:list`），命令面板只负责「马上跑一下」。
                    跑在哪：当前视图就是一条终端时**就地写进去**（不弹窗、不重连，见
                    `features/scripts/run-script-command.ts`），否则弹「运行脚本」对话框挑主机。
                    一个脚本都没有时不出这一行：点进去是空列表，等于一个死入口 */}
                {app.scripts.length > 0 && (
                  <CommandItem
                    keywords={['script', 'scripts', '脚本', '运行', 'run', '执行', '命令']}
                    onSelect={() => {
                      setKeyword('')
                      setMode('scripts')
                    }}
                  >
                    <FileCode2 />
                    <span>运行脚本</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {app.scripts.length}
                    </span>
                    <ChevronRight />
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {/*
              会话：**「搜索会话」恒可用** —— 它搜的是全部会话（标题 + 消息正文，跨项目），
              跟「当前有没有选中工作区」无关。原先整个组挂在 `activeWorkspaceId` 上，
              于是「新对话」不选项目之后这组整块消失，搜索入口看起来就像被删掉了。

              「新建会话 / 当前项目的会话列表」仍然只对活动工作区有意义，留在门里。
              归档会话不列在根级：那是搜索二级视图的事（归档是收起来，不是消失）。
            */}
            <CommandGroup heading="会话">
              <CommandItem
                // value 里带上已经敲的词：根级输入「部署」时这一行也能命中
                // （cmdk 按 value 过滤，等于「输入什么都能看到它」），点进去直接带着词搜
                value={`搜索会话 ${rootQuery}`}
                keywords={['search', 'find', '搜索', '查找', '查找会话', '全部', '全局']}
                onSelect={() => {
                  setKeyword(rootQuery)
                  setMode('search-sessions')
                }}
              >
                <Search />
                <span className="truncate">
                  {rootQuery.trim() ? `在所有会话中搜索「${rootQuery.trim()}」` : '搜索会话'}
                </span>
                <ChevronRight className="ml-auto" />
              </CommandItem>
              {activeWorkspaceId && (
                <>
                  <CommandItem
                    keywords={['new', 'conversation', '会话', '新建', '新消息']}
                    onSelect={run(() => void app.newConversation(activeWorkspaceId))}
                  >
                    <MessageSquarePlus />
                    <span>新建会话</span>
                    <CommandShortcut>{hint('new-conversation')}</CommandShortcut>
                  </CommandItem>
                  {app.conversations
                    .filter((c) => c.workspaceId === activeWorkspaceId && !c.archivedAt)
                    .map((conversation) => (
                      <CommandItem
                        key={conversation.id}
                        value={`会话 ${conversationTitle(conversation.title)}`}
                        keywords={['conversation', conversation.title]}
                        onSelect={run(() =>
                          onOpenConversation(conversation.id, conversation.workspaceId)
                        )}
                      >
                        <MessageSquare />
                        <span className="truncate">{conversationTitle(conversation.title)}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {conversation.messageCount}
                        </span>
                      </CommandItem>
                    ))}
                </>
              )}
            </CommandGroup>

            {/* 设置 / 主题：始终可用 */}
            <CommandGroup heading="设置">
              <CommandItem keywords={['settings', 'preference', '设置', '偏好']} onSelect={run(onOpenSettings)}>
                <Settings />
                <span>打开设置</span>
                <CommandShortcut>{hint('open-settings')}</CommandShortcut>
              </CommandItem>
              <CommandItem
                keywords={['theme', '主题', 'dark', 'light', '亮', '暗', '切换']}
                onSelect={run(onToggleTheme)}
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
                <span>切换主题（当前{theme === 'dark' ? '深色' : '浅色'}）</span>
                <CommandShortcut>{hint('toggle-theme')}</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </>
      ) : mode === 'hosts' ? (
        <>
          <CommandInput
            leading={
              <button
                type="button"
                aria-label="返回命令列表"
                onClick={backToRoot}
                className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
              </button>
            }
            placeholder="搜索主机…"
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/* 过滤交给 cmdk 本地做（主机清单就在内存里，不用打接口） */}
          <CommandList className="min-h-0 max-h-none flex-1">
            <CommandEmpty>没有匹配的主机。</CommandEmpty>
            <CommandGroup heading="主机">
              {app.sshHosts.map((host) => {
                const isLocal = host.kind === 'local'
                // 副标题：SSH = user@host:port；本机终端 = shell 名（+ 有参数 / 自动命令就带上）
                const subtitle = isLocal
                  ? [
                      host.shellName ?? '默认终端',
                      ...(host.args?.length ? [`${host.args.length} 个参数`] : [])
                    ].join(' · ')
                  : `${host.username}@${host.host}:${host.port}`
                return (
                  <CommandItem
                    key={host.id}
                    // value 参与 cmdk 的本地过滤：把能搜的字段都拼进来
                    value={`${host.name} ${subtitle}`}
                    keywords={
                      isLocal
                        ? ['terminal', '终端', '本机', host.name]
                        : ['ssh', host.name, host.host, host.username]
                    }
                    onSelect={run(() => onOpenHost(host))}
                  >
                    {isLocal ? <SquareTerminal /> : <Server />}
                    <span className="truncate">{host.name}</span>
                    <span className="ml-auto max-w-40 truncate font-mono text-xs text-muted-foreground">
                      {subtitle}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </>
      ) : mode === 'scripts' ? (
        <>
          <CommandInput
            leading={
              <button
                type="button"
                aria-label="返回命令列表"
                onClick={backToRoot}
                className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
              </button>
            }
            placeholder="搜索脚本…"
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/* 过滤交给 cmdk 本地做（脚本清单就在内存里，不用打接口）；
              分段与排序在 `ScriptPaletteList`（与清单页同一口径，桌面 / web 共用同一份） */}
          <CommandList className="min-h-0 max-h-none flex-1">
            <CommandEmpty>没有匹配的脚本。</CommandEmpty>
            <ScriptPaletteList app={app} run={run} />
          </CommandList>
        </>
      ) : (
        <CommandPaletteSearch
          api={app.api}
          keyword={keyword}
          workspaces={app.workspaces}
          onKeywordChange={setKeyword}
          onBack={backToRoot}
          onOpenHit={(hit) => run(() => onOpenConversation(hit.conversationId, hit.workspaceId))()}
        />
      )}

      {/* 底部键位提示：贴面板底、所有层级都在（cmdk 只提供键盘行为，这行是把它写出来给人看） */}
      <CommandFooter>{footerHint}</CommandFooter>
    </CommandDialog>
  )
}
