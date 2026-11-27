"use client";

/**
 * 手机版主区域：**单标签面板**。
 *
 * 本工程（`apps/mobile`）在 `main.tsx` 里调了 `panel-store` 的 `setSingleTabMode(true)`，
 * 打开新会话 = 把当前标签换成它。所以这里没有标签条、标签列表、拖拽与分屏 ——
 * 换会话走侧栏抽屉，工具标签同样只是替换当前那一个。
 *
 * ## 状态从哪来
 *
 * 布局与分组状态全在 `panel-store.ts`（模块级 + `useSyncExternalStore`），本文件只**读**它。
 *
 * ## 布局：所有组铺满整块、只显示焦点组
 *
 * `MobilePaneStack` 把布局树里的每个组都叠在 `absolute inset-0` 上，非焦点组
 * `invisible`。单标签模式下布局通常只有一个组，保留叠放只为了两个边界：
 * ① 单标签替换到位之前的那一帧；② 老数据里残留的多组。用 `invisible` 而不是
 * `hidden` 是为了保持车身尺寸 —— 内容层靠 `getBoundingClientRect()` 量落位。
 *
 * ## 内容一律常挂载
 *
 * 非活动标签用 `hidden` 藏起来而**不卸载** —— 终端的 xterm 实例 / scrollback、文件树的
 * 展开状态、编辑器里未保存的内容都只在组件内存里，卸载即灭（`TerminalPanel` 的 cleanup
 * 还会 kill 掉那条 PTY）。这与 `SidePanel` 是同一条约束。
 *
 * ## 标签 key 是身份，不是地址
 *
 * 每颗标签的 key 终生不变（`panel-tabs.ts` 的铁律）。对话标签指向哪条会话记在
 * `panel-store` 的指向表里：草稿发出第一条消息，只是那颗标签的指向变了 —— key、内容实例、
 * 面板现场都不动。所以这里**没有「替换标签 / 交接现场」的步骤**，只有「当前会话变了 →
 * 确保它有一颗标签」这一条对齐（`alignConversationTab`，与 web / desktop 共用同一个函数）。
 *
 * **零标签时本文件直接补一张草稿标签**（见 `PanelView` 里那个 effect）—— 三端同一套做法：
 * 没有标签就落在「开始新对话」页。
 *
 * 工具标签（终端 / 接口 / 笔记…）不对应任何会话 —— 点 / 关它们都**不该**动
 * `activeConversationId`。判定在 `panel-tabs.ts`（纯函数）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import {
  findShortcutByEvent,
  isShortcutRecording,
  useShortcuts
} from '@fizz/agent-kit/shared/lib/shortcuts'
import { ConversationTab } from '@fizz/agent-kit/features/chat/ConversationTab'
import { ContainerTabGate } from '@fizz/agent-kit/features/projects/ContainerStartupView'
import { TerminalPanel } from '@fizz/agent-kit/features/terminal/TerminalPanel'
import { TerminalTabView } from '@fizz/agent-kit/features/terminal/TerminalTabView'
import { ApiPage } from '@fizz/agent-kit/features/api/ApiPage'
import { WsPage } from '@fizz/agent-kit/features/api/WsPage'
import { ScriptsPanel } from '@fizz/agent-kit/features/scripts/ScriptsPanel'
import { SftpPanel } from '@fizz/agent-kit/features/sftp/SftpPanel'
import { TunnelPanel } from '@fizz/agent-kit/features/tunnels/TunnelPanel'
import { TriggersPanel } from '@fizz/agent-kit/features/tasks/TriggersPanel'
import { LocalFileTabContent } from '@fizz/agent-kit/features/local-file/LocalFileTabContent'
import { FileManagerPanel } from '@fizz/agent-kit/features/file-manager/FileManagerPanel'
import { SysmonPanel } from '@fizz/agent-kit/features/system-tasks/SysmonPanel'
import { NoteTabContent } from '@fizz/agent-kit/features/notes/NoteTabContent'
import { PluginTabContent } from '@fizz/agent-kit/features/plugins/PluginTabContent'
import { NEW_API_REQUEST_ID, NEW_WS_REQUEST_ID } from '@fizz/agent-kit/features/api/api-client'
import {
  apiRequestIdOfTabKey,
  isApiTabKey,
  isConversationTabKey,
  isFilesTabKey,
  isLocalFileTabKey,
  isNoteTabKey,
  isPluginTabKey,
  isScriptsTabKey,
  isSftpTabKey,
  isSysmonTabKey,
  isTriggersTabKey,
  isTunnelTabKey,
  sftpHostIdOfTabKey
} from '@fizz/agent-kit/shared/lib/panel-tabs'
import { getToolTab, pruneToolTabs } from '@fizz/agent-kit/shared/lib/tool-tabs'
import {
  pruneTabReloads,
  subscribeTabReloads,
  tabReloadsVersion,
  tabReloadGen
} from '@/app/layout/tab-reload'
import {
  panelBodies,
  panelBodiesVersion,
  registerPanelBody,
  subscribePanelBodies
} from '@/app/layout/panel-bodies'
import { useGroupActions } from '@/app/layout/use-panel-actions'
import { collectGroupIds, type PaneNode } from '@fizz/agent-kit/shared/lib/pane-layout'
import type { PanelState } from '@fizz/agent-kit/shared/lib/panel-groups'
import type { SshHostConfig } from '@fizz/contracts/types'
import {
  activeTabKey,
  alignConversationTab,
  allTabKeys,
  closeTabs,
  conversationOfTab,
  openDraftTab,
  openTabKeys,
  staleConversationTabs,
  tabOwners,
  usePanelState
} from '@fizz/agent-kit/shared/lib/panel-store'
import { consumeDraftConversation } from '@fizz/agent-kit/shared/lib/draft-tab-handoff'

// ---------------------------------------------------------------------------
// 一个面板组
// ---------------------------------------------------------------------------

function PanelGroupView({ groupId }: { groupId: string }) {
  const { focusGroup } = useGroupActions()

  /**
   * 车身元素登记给内容层量落位（见 `panel-bodies.ts`）。
   *
   * ⚠️ 必须用 `useCallback` 保持 ref 回调引用稳定：裸箭头函数每次渲染都是新引用，
   * React 会先以 `null` 注销旧 ref、再登记新 ref，内容层被白触发一轮重挂。
   */
  const bodySetRef = useCallback(
    (node: HTMLDivElement | null) => {
      registerPanelBody(groupId, node)
    },
    [groupId]
  )

  return (
    <div
      // 点车身 / 空态 → 把这组设为焦点。单标签下通常只有一组，保留它是为了
      // 内容层的事件（按 React 树冒泡）也能同步焦点组。
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
      onPointerDownCapture={() => focusGroup(groupId)}
    >
      {/*
        车身：**只留一个洞**。标签内容不在这里渲染 —— 它由 `PanelContentLayer` 在
        `PanelView` 根部渲染一次，再按这个 div 的矩形摆过来（见 `panel-bodies.ts`）。
        组里自己渲染内容的话，内容换组就会换 React 父节点、实例被卸载重挂，
        终端的 xterm 与 PTY 一起没。

        ⚠️ 这里没有「没有打开的标签」那句空态：零标签时 `PanelView` 会直接补一张
        草稿标签，这个车身只在那一帧之前是空的（桌面 / web 的**空组**仍保留那句，
        那边分屏后可能有一格是空的）。
      */}
      <div
        ref={bodySetRef}
        // 量矩形用（内容层按它给标签落位）；验证脚本也靠它定位组的车身
        data-panel-body={groupId}
        className="relative min-h-0 flex-1"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 一个标签的内容
// ---------------------------------------------------------------------------

/**
 * SFTP 文件管理标签的内容：按 key 里的 hostId 去主机清单里取配置。
 *
 * 取不到（主机被删）时给一句明确的话，而不是渲染一个空壳页面 —— 与终端标签
 * 「数据已失效」同一套处理。主机配置只读（`SshHostConfig` 里没有明文凭据），
 * 真正的连接凭据在服务端解密，这一路只用到 `username@host:port` 与 id。
 */
function SftpTabContent({ hostId }: { hostId: string }): ReactNode {
  const { app } = useAppContext()
  const host = app.sshHosts.find(
    (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
  )
  if (!host) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这台主机已不存在，关闭标签后重新打开即可。
      </div>
    )
  }
  return <SftpPanel host={host} />
}

/**
 * 接口请求标签的内容：按 `protocol` 分发到 HTTP 编辑页（`ApiPage`）或 WebSocket 调试页
 * （`WsPage`）。草稿（哨兵 `NEW_WS_REQUEST_ID`）还没落盘、不在清单里，直接判定走 WS 页；
 * 已保存条目读它的 `protocol`（undefined = http，兼容历史数据）。
 */
function ApiTabContent({ requestId }: { requestId: string }): ReactNode {
  const { app } = useAppContext()
  const request = app.apiRequests.find((r) => r.id === requestId) ?? null
  if (requestId === NEW_WS_REQUEST_ID || request?.protocol === 'ws') {
    return <WsPage requestId={requestId} />
  }
  return <ApiPage requestId={requestId} />
}

/**
 * 终端标签的内容：登记表元数据 → 一条终端。
 *
 * ⚠️ **主区域的终端标签恒是「宿主本机」终端，不做任何容器判定。**
 * 以前这里会拿 `tool.workspaceId` 去 `containerProjects` 快照里查，命中容器型项目就把
 * `containerWorkspaceId` 交给 `TerminalPanel`（服务端换成 `docker exec`）—— 于是「主机与
 * 终端」里配的那条**本机终端**，只要当前项目是容器型，就变成了容器内 shell（用户报过）。
 * 「主机与终端」是**独立功能**，它开出来的东西与任何会话 / 项目都无关；容器终端只存在于
 * **会话自己的侧栏面板**里，那条路由 `openTerminalTabOf` 显式带 `containerWorkspaceId`
 * （见 `features/chat/ConversationTab.tsx`），不靠这里推断。
 */
function TerminalTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  const tool = getToolTab(tabKey)
  if (!tool) {
    /*
     * 登记表里没有它 —— 理论上不该发生（条目与标签同生共死）。真出现了就明说，
     * 别渲染一片空白让人以为是终端挂了。
     */
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这个标签的数据已失效，关闭后重新打开即可。
      </div>
    )
  }
  return (
    <TerminalTabView tabKey={tabKey}>
      <TerminalPanel
        // 本机终端的工作目录（主机终端不用它，走 `sshHostId`）
        cwd={tool.cwd}
        // 不是正被看着的那个就别抢输入焦点（收起 / 切走的标签仍常挂载）
        visible={active}
        shellId={tool.shellId ?? null}
        // 命令历史 / 预测的作用域：SSH 主机终端一份（全局）、宿主本机终端一份（全局，
        // 不挂项目，见 `localHistory`）。**这里不传 workspaceId** —— 主区域的终端与项目无关。
        localHistory={tool.kind === 'local'}
        sshHostId={tool.sshHostId}
        // 本机终端的额外启动参数 / 启动后自动命令（主机终端不适用）
        args={tool.kind === 'local' ? tool.args : undefined}
        autoCommand={tool.kind === 'local' ? tool.autoCommand : undefined}
        // 运行脚本时终端就绪后写入一次（SSH 与本机终端都适用）
        scriptInput={tool.scriptInput}
        // 主区域的工具标签带 tabKey → 终端按它登记关闭守卫（进程还活着时关标签要确认），
        // 也按它登记到终端登记表（供内嵌 AI 助手操作这个终端）。
        tabKey={tabKey}
      />
    </TerminalTabView>
  )
}

/**
 * 按标签 key 的类型分发内容：对话标签 → `ConversationTab`；工具标签 → 一条终端。
 *
 * ⚠️ 这个分发点**只有一处**（`PanelContentLayer` 里按标签平铺时调它）。标签内容绝不能在
 * 递归的布局骨架上、或在组里再渲染一份 —— 换组时那会换掉它的父节点，React 卸载重挂，
 * 终端 xterm 重建、PTY 被 kill、未保存内容全丢（见 `docs/lessons/ui.md` §59）。
 */
function PanelTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  if (isConversationTabKey(tabKey)) {
    // 指向哪条会话问标签 store（草稿 = null）；key 只是不透明的身份，解析不出会话 id
    return (
      <ConversationTab tabKey={tabKey} conversationId={conversationOfTab(tabKey) ?? null} />
    )
  }

  // 接口请求标签：草稿是哨兵 requestId，按 protocol 分发到 HTTP 页 / WebSocket 页。
  // 非活动标签由内容层 `hidden` 藏而不卸 —— 编辑到一半的方法 / 地址 / 响应都留在内存里。
  if (isApiTabKey(tabKey)) {
    return <ApiTabContent requestId={apiRequestIdOfTabKey(tabKey) ?? NEW_API_REQUEST_ID} />
  }

  // SFTP 文件管理标签：一台主机 = 一条（key 里带 hostId）。主机配置在
  // `useAppContext` 的清单里现取 —— 主机被删则渲染一句「数据已失效」，不炸。
  if (isSftpTabKey(tabKey)) {
    return <SftpTabContent hostId={sftpHostIdOfTabKey(tabKey) ?? ''} />
  }

  // 隧道标签：全局单例面板（`tunnel:list`）。它自己从 store 读 `sshTunnels` / `tunnelRuntimes`
  // 并订阅 WS 推送，不需要在这里传数据；「从主机右键进来」的预选主机在登记表里（`getToolTab`）。
  if (isTunnelTabKey(tabKey)) {
    return <TunnelPanel tabKey={tabKey} />
  }

  // 定时任务标签：全局单例管理面板（`triggers:list`）。数据走 `useAppContext().triggers`。
  // 手机是单标签，打开它就是替换当前视图；面板内部 `lg:` 以下退化成上下两块。
  if (isTriggersTabKey(tabKey)) {
    return <TriggersPanel />
  }

  // 脚本管理面板：全局单例（`scripts:list`）。清单走 `useAppContext().app.scripts`
  // （与脚本编辑页 / 侧栏同一份），这里不需要传任何东西。
  if (isScriptsTabKey(tabKey)) {
    return <ScriptsPanel />
  }

  // 插件界面标签：内容由**服务端**的 render() 产出（插件不写 React，见 PluginSurfaceBody）。
  // 归属（哪个插件 / 哪个面）在 `tool-tabs` 的登记表里，key 只是不透明的 `plugin:<n>`。
  if (isPluginTabKey(tabKey)) {
    return <PluginTabContent tabKey={tabKey} />
  }

  // 笔记标签：归属（哪个根 + 哪篇）在 `tool-tabs` 的登记表里，key 只是不透明的 `note:<n>`。
  // `active` 必须传下去 —— 所有标签都常挂载，`Ctrl/Cmd+S` 只有**正被看着的那篇**该响应。
  if (isNoteTabKey(tabKey)) {
    return <NoteTabContent tabKey={tabKey} active={active} />
  }

  // 本地文件标签：用本应用打开的一篇**本机** Markdown（绝对路径，读写走主进程 fs）。
  // 与上面的笔记标签是两条独立通路，见 `features/local-file/LocalFileTabContent.tsx` 的对照表。
  if (isLocalFileTabKey(tabKey)) {
    return <LocalFileTabContent tabKey={tabKey} active={active} />
  }

  // 文件管理标签：全局单例（`files:list`），浏览**服务端那台机器**的整盘。
  //
  // ⚠️ 手机端**没有**入口（状态栏那颗按钮只在桌面 / Web 的壳里，见 `shell/app-shell.tsx`），
  // 这条分支纯粹是防呆：`isFilesTabKey` 已经算进 `isToolTabKey`（见 `panel-tabs.ts`），
  // 所以 `files:list` 不会被当成对话标签；但下面的兜底是**终端**，这里不接一手的话，
  // 将来真在手机上开出这条标签就会渲染出一条莫名其妙的终端。
  if (isFilesTabKey(tabKey)) {
    return <FileManagerPanel />
  }

  // 系统监控 / 任务管理器标签：全局单例（`sysmon:list`）。
  //
  // 入口在抽屉左下角（`layout/Sidebar.tsx`，与设置同一行）：桌面那颗在底部状态栏
  // （`SysmonButton`），手机壳没有那条栏。进程表在窄屏上会隐藏几列，见 `SysmonPanel`
  // 的 `sm:` / `md:` 分支 —— 这一页本来就能用，只是以前没有入口。
  if (isSysmonTabKey(tabKey)) {
    return <SysmonPanel />
  }

  // 剩下的就是终端标签（`host:<id>` / `local:<n>`）：元数据在登记表里，而「这个工作区
  // 是不是容器型项目」要读 state ws 的快照 —— 读快照得挂 hook，故内容拆到独立组件里。
  return <TerminalTabContent tabKey={tabKey} active={active} />
}

// ---------------------------------------------------------------------------
// 内容层：全部标签在 PanelView 根部渲染，再按各组车身矩形摆过去
// ---------------------------------------------------------------------------

/** 一个标签内容在屏幕上的落位（相对内容层左上角；单位 px，就是量出来的值） */
interface TabSlot {
  left: number
  top: number
  width: number
  height: number
}

/** 两组落位是否逐项相同（相同就保持原引用，免得白白多渲染一轮） */
function sameSlots(a: Record<string, TabSlot>, b: Record<string, TabSlot>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!x) return false
    if (x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
      return false
    }
  }
  return true
}

/**
 * 标签**内容层**：主区域所有标签的内容在这里（`PanelView` 根部）平铺渲染一次，
 * 每个标签绝对定位到它所属组的车身矩形上。
 *
 * ## 为什么不在组里渲染
 *
 * 内容原来由 `PanelGroupView` 渲染，标签一旦换组，父节点就从「A 组」变成「B 组」，
 * React 卸载重挂 —— `TerminalPanel` 的 cleanup 会把 PTY kill 掉。所以内容必须
 * **始终待在同一个父节点下**，位置只靠坐标变化来表达：全部挂在 `PanelView` 根部，
 * 组的坐标由 `panel-bodies.ts` 登记的车身元素量出来。标签换组 = 换一组坐标。
 *
 * ## 为什么不是 `createPortal(内容, 车身)`
 *
 * React 19 的 `updatePortal` 里有一句「容器变了就 `createFiberFromPortal` 建新 fiber」
 * 的判定 —— 换组时容器**正是要变**，于是 portal 版会照样重挂，比现在更隐蔽。
 *
 * ## 三条必须守住的细节
 *
 * 1. **落位是量出来的，不是算出来的。** 直接读车身的 `getBoundingClientRect()`，
 *    相对内容层原点换算。
 * 2. **落位按「标签」缓存，量不到新组的车身时沿用上一次的位置。** 若这时因为
 *    「查不到落位」就不渲染这个标签，React 会把它的内容卸载掉，正好又踩回要修的 bug。
 * 3. **点内容区要能把这组设为焦点。** 内容层在 DOM 上落在车身里，但 React 树上是
 *    `PanelView` 的子节点 —— 事件按 **React 树**冒泡，不经过组的根节点，所以这里补一份。
 *
 * 容器型项目的「容器状态」卡片包在标签内容上（`ContainerTabGate`），不套在面板外面：
 * 门一旦套在 `PanelView` 外，容器一停就整块面板连标签条一起换成卡片（用户报过）。
 */
function PanelContentLayer({ state }: { state: PanelState }): ReactNode {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const { focusGroup } = useGroupActions()
  const version = useSyncExternalStore(
    subscribePanelBodies,
    panelBodiesVersion,
    panelBodiesVersion
  )
  /**
   * `标签 key → 落位`（不是按组存：换组时那条缓存正是要跨过去的，见上面第 2 条）。
   * 标签 key 是终生不变的身份，草稿变成会话时缓存命中一直是它，不需要任何「迁移」。
   */
  const [slots, setSlots] = useState<Record<string, TabSlot>>({})

  /** `measure` 要保持引用稳定（它是下面 effect 的依赖），又要读到最新的分组状态 —— 走 ref */
  const stateRef = useRef(state)
  stateRef.current = state

  /** 量一遍所有已登记的车身，换算成相对内容层的坐标，再落到每个标签头上 */
  const measure = useCallback((): void => {
    const layer = layerRef.current
    if (!layer) return
    const base = layer.getBoundingClientRect()
    const bodies = panelBodies()
    setSlots((prev) => {
      const next: Record<string, TabSlot> = {}
      for (const [tabKey, owner] of tabOwners(stateRef.current)) {
        const rect = bodies.get(owner.groupId)?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          next[tabKey] = {
            left: rect.left - base.left,
            top: rect.top - base.top,
            width: rect.width,
            height: rect.height
          }
        } else if (prev[tabKey]) {
          // 车身这一拍还没量到（刚挂出来 / 被折叠成 0 尺寸）：沿用上一次的落位（第 2 条）
          next[tabKey] = prev[tabKey]
        }
      }
      return sameSlots(prev, next) ? prev : next
    })
  }, [])

  /*
   * ⚠️ 每次提交后都重量一遍（无依赖）。会改布局的东西太多 —— 开关侧栏、字体加载完成、
   * 窗口缩放…与其把触发源枚举全，不如「渲染完就量」：矩形没变时 `setSlots` 返回原引用，
   * React 直接 bail out，不会多出一轮渲染。
   */
  useLayoutEffect(measure)

  /*
   * 车身集合变了（组新增 / 移除 / 换了 DOM 元素）→ 重挂 ResizeObserver 并立刻重量。
   * 「侧栏拖宽」这类**不经过 React 渲染**的尺寸变化，只有 ResizeObserver 接得住。
   */
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure())
    for (const el of panelBodies().values()) observer.observe(el)
    const onWindowResize = (): void => measure()
    window.addEventListener('resize', onWindowResize)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [measure, version])

  /**
   * 标签「刷新」代号变更的信号（`tab-reload.ts`）。代号本身按标签在下面 map 里读 ——
   * 不能在这里给每个标签挂一个 hook（map 里调 hook 不合法）。
   */
  useSyncExternalStore(subscribeTabReloads, tabReloadsVersion, tabReloadsVersion)

  const owners = tabOwners(state)

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-0">
      {allTabKeys(state).map((tabKey) => {
        const owner = owners.get(tabKey)
        const slot = slots[tabKey]
        // 从没量到过落位（刚开出来的新标签，首帧）：先不挂内容，免得 xterm 按 0×0 去 fit
        if (!owner || !slot) return null
        return (
          <div
            key={`${tabKey}#${tabReloadGen(tabKey)}`}
            /*
             * ⚠️ 这里是标签内容的宿主。层级恒定 —— 换组只改下面这组坐标，React 对账看到的是
             * 同一个节点，实例复用、不重挂；只有用户点了那颗「刷新」才通过末尾的刷新代号
             * 强制卸载重挂（见 `tab-reload.ts`）。
             *
             * key 直接用**标签 key**：它是终生不变的身份（`panel-tabs.ts` 的铁律），草稿
             * 标签发出第一条消息只是换了个指向，key 不变 ⇒ `ConversationTab` 不重挂，
             * 右侧面板里的终端 PTY、文件树现场都原样留着。与 web / desktop 同一套。
             */
            style={{ left: slot.left, top: slot.top, width: slot.width, height: slot.height }}
            className={cn(
              'pointer-events-auto absolute overflow-hidden',
              // 非活动标签 `hidden` 而**不卸载**：xterm 实例 / scrollback / 未保存内容只在内存里
              !owner.active && 'hidden'
            )}
            onPointerDownCapture={() => focusGroup(owner.groupId)}
          >
            {/*
              ⚠️ 内容宿主**必须是 flex 列**：`ConversationTab` 的根用 `flex-1`，
              只有父级是 flex 容器时它才有「确定的高度」可言。宿主若只是个块级
              `h-full`，`flex-1` 会被忽略、子级高度退化成 `auto` → 一路撑到内容高度，
              里面那些 `overflow-y-auto` 的滚动容器**永远不会触发滚动**。
            */}
            <div className="flex h-full flex-col">
              {/*
                ⚠️ 容器门（`ContainerTabGate`）必须在**这里**（每个标签内容各包一层），
                不能套在整个 `PanelView` 外面。门只拦「属于那个容器项目」的标签，见它的文件头。
              */}
              <ContainerTabGate tabKey={tabKey}>
                <PanelTabContent tabKey={tabKey} active={owner.active} />
              </ContainerTabGate>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 布局：所有组铺满整块、只显示焦点组
// ---------------------------------------------------------------------------

/**
 * 手机上的布局树：**所有组铺满整块、只显示焦点组**。
 *
 * 单标签模式（`setSingleTabMode`）下布局通常只有一组，保留这层叠放是为了两个边界：
 * ① 单标签替换到位之前的那一帧；② 老数据里残留的多组。非焦点组的内容若被卸载，
 * 终端 PTY / xterm 滚动缓冲 / 未保存的编辑会跟着没（与 `PanelContentLayer` 的常挂载
 * 约束同一条）。用 `invisible` 而不是 `hidden` 也是为了保持布局尺寸 —— 内容层靠
 * `getBoundingClientRect()` 量车身，尺寸为 0 就量不到落位、切过去时要等一帧。
 */
function MobilePaneStack({ node }: { node: PaneNode }) {
  const state = usePanelState()
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {collectGroupIds(node).map((groupId) => (
        <div
          key={groupId}
          className={cn(
            'absolute inset-0 flex min-h-0 min-w-0',
            groupId !== state.activeGroupId && 'invisible'
          )}
        >
          <PanelGroupView groupId={groupId} />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 根
// ---------------------------------------------------------------------------

export function PanelView() {
  const state = usePanelState()
  const { app } = useAppContext()
  const { closeAndSync } = useGroupActions()

  const activeConversationId = app.activeConversationId

  /**
   * 零标签 → 直接开一张「新对话」草稿标签。
   *
   * 「没有标签」不是一个可展示的状态：主区域总得能开始干活 —— 落在「开始新对话」页
   * （没有项目时也是这一页，加项目就在输入框下面那行，见 `ChatPanel` / `WorkspaceSelect`）。
   * 桌面 / web 的 `PanelView` 是同一套做法。
   *
   * `useLayoutEffect`：在浏览器绘制前就补上，不先闪一帧空白。
   *
   * ⚠️ 补的是**草稿标签**，不是给 `activeConversationId` 找会话：启动恢复仍是 `useAgentApp`
   * 的事，恢复到位后下面那个 effect 让这颗草稿指向恢复出来的会话。
   */
  useLayoutEffect(() => {
    if (openTabKeys().length === 0) openDraftTab()
  }, [state])

  /**
   * `app` 是 `agentAppFrom()` 每次渲染现造的、context 的 value 也是现造的 —— 把这类
   * 「每次渲染都换引用」的东西收进 ref，让下面那个兜底 effect 只由「会话清单变了」触发，
   * 而不是每次无关重渲染都重跑。
   */
  const actionsRef = useRef({ app })
  actionsRef.current = { app }

  /**
   * 「选中**具体会话** → 焦点标签」：侧栏选中一条会话 / 启动恢复时同步标签。
   * `null` 不代表「自动打开新对话」：它也意味着刚关完所有标签。冷启动和刷新时若
   * 因为会话尚未恢复就给这个 `null` 自动找一条会话，用户关光的会话会凭空长回来。
   * **显式**新建仍由侧栏动作开草稿标签；零标签的情况另有一支（见上面那句
   * `useLayoutEffect`）。
   *
   * 怎么对齐只有一条规则（`alignConversationTab`，三端共用、有单测）：
   * - 会话已经有标签 → 不动；
    * - 它是**在草稿页发消息**建出来的 → 只有发起创建的那颗草稿标签可接下它；若该标签
    *   已关闭，就不能误绑到后来创建的新草稿（见 `draft-tab-handoff.ts`）；
   * - 草稿正被看着（启动恢复；单标签模式下草稿在就一定是它）→ 同样由草稿接下；
   * - 其余 → 新开一颗（单标签模式下 = 替换当前视图）。
   */
  useEffect(() => {
    const key = activeConversationId
    if (!key) return
    alignConversationTab(key, { draftHandoff: consumeDraftConversation(key) })
  }, [activeConversationId])

  /**
   * 「会话被**删除 / 归档** → 它的标签跟着消失」：与桌面 / web 的
   * `packages/agent-kit/src/shell/layout/PanelView.tsx` 同一条（那边有完整论证，
   * 这里只留结论，别两边写出不同的判据）。
   *
   * - 指向清单里没有 / 已归档（`archivedAt`）会话的标签 → 裸关（`closeTabs`，不过守卫）；
   * - `conversationsLoaded` 之前不判（空清单会把所有对话标签误判成「已消失」）；
   * - 关掉的正是当前会话 → 对齐到剩下的活动标签，否则退回空态（手机是单标签模式，
   *   空出来之后上面那条兜底会补一张草稿）。
   */
  useEffect(() => {
    if (!app.conversationsLoaded) return
    const alive = new Set(
      app.conversations.filter((c) => !c.archivedAt).map((c) => c.id)
    )
    const stale = staleConversationTabs(alive)
    if (stale.length) closeTabs(stale)

    const current = actionsRef.current.app.activeConversationId
    if (!current || alive.has(current)) return
    const next = activeTabKey()
    const nextConversation = next ? conversationOfTab(next) : undefined
    if (nextConversation) {
      actionsRef.current.app.openConversation(nextConversation)
      return
    }
    actionsRef.current.app.openConversation(null, { keepScroll: nextConversation === null })
  }, [app.conversations, app.conversationsLoaded])

  /**
   * 面板级快捷键「关闭当前标签」（默认 Ctrl / ⌘ + W，可在「设置 → 快捷键」里改）。
   *
   * ## 为什么挂在 `PanelView` 上，而不是 app-shell 的全局分发器
   *
   * 关标签是**面板自己**的事（要读焦点组的活动标签、还要把「当前会话」对齐过去），而
   * app-shell 拿不到这些。`shortcuts.ts` 的 `PANEL_SCOPED_SHORTCUT_ACTIONS` 正是为这种
   * 动作准备的：全局分发器遇到它**直接放行、不拦截**，由面板自己挂的 window 监听处理。
   *
   * ## 挂在 window 而不是面板根节点上
   *
   * 不要求标签条先聚焦 —— 焦点在内容区（会话正文 / 终端）里也该关得掉当前标签。
   * 副作用是要自己多判两件事：
   * - 输入法组合中 / 长按重复不触发（与全局分发同一套判断）；
   * - 设置页正在**录制**快捷键时让路，否则在设置里录 `Ctrl+W` 会顺手把标签关掉
   *   （`isShortcutRecording`，app-shell 通过 `setShortcutRecording` 广播过来）。
   */
  const shortcuts = useShortcuts()
  const closeRef = useRef(closeAndSync)
  closeRef.current = closeAndSync
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.repeat) return
      if (isShortcutRecording()) return
      const hit = findShortcutByEvent(shortcuts, e)
      if (!hit || hit.action !== 'close-tab') return
      e.preventDefault()
      e.stopPropagation()
      // 面板空着时没有「当前标签」可关 —— 什么也不做，也不吞按键
      const key = activeTabKey()
      if (key) closeRef.current([key])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shortcuts])

  /**
   * 回收工具标签的登记条目（`tool-tabs.ts`）：标签被关掉 / 被 `alignToTabs` 摘掉之后，
   * 那条元数据（工作目录、shell…）就该跟着没了。集中在这里做，是因为「关标签」的路径
   * 不止一条 —— 每条都记得顺手清一次迟早会漏。
   */
  useEffect(() => {
    pruneToolTabs(allTabKeys(state))
    // 同一次回收里带上「刷新代号」：已关闭标签的代号留着也只是几个 map 条目，但重开同名
    // 标签（`local:1` / `api:<requestId>` 都可能复用 key）会莫名继承上一次的刷新状态
    pruneTabReloads(allTabKeys(state))
  }, [state])

  /**
   * 标签被关光 → **当前会话**退回空态（主区域由上面那个 effect 补一张草稿标签，
   * 所以这里不再产出「空态页面」，只负责选中态与落盘意图）。
   *
   * 关掉最后一个标签时 `panel-store` 会保留一个空组占位（布局树不能是 `null`），
   * 而「当前会话」还停在那条已经不存在的会话上。这里把它退回空态并持久化
   * `blankIntent`，刷新后不恢复旧会话。
   *
   * ⚠️ `hadTabsRef` 是必需的：挂载首帧的面板状态本来就是空的（`openTab` 的写入要到
   * 下一帧才可见），若不加这道闸，首次挂载会被误判成「标签被关光了」而立刻把当前
   * 会话清掉。只有「**曾经有过标签**、现在没了」才算真的关光。
   */
  const hadTabsRef = useRef(false)
  useEffect(() => {
    const { app: a } = actionsRef.current
    if (allTabKeys(state).length > 0) {
      hadTabsRef.current = true
      return
    }
    if (!hadTabsRef.current) return
    if (activeConversationId === null) return
    a.openConversation(null)
  }, [state, activeConversationId])

  return (
    /*
     * `relative` 是内容层的定位基准：内容层 `absolute inset-0` 要正好盖住整个面板区，
     * 而每个标签的落位坐标是相对它的原点算的。
     */
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-2">
      {/* 布局骨架：只画组外壳（空态），车身留成洞 */}
      <MobilePaneStack node={state.layout} />
      {/* 内容层：全部标签在根部渲染一次，再摆到各自组的车身上（见组件注释） */}
      <PanelContentLayer state={state} />
    </div>
  )
}
