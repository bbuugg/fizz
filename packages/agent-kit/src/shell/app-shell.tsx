"use client";

/**
 * 应用外壳：侧栏 + 主区域框架 + 全局弹窗（设置 / 命令面板 / 快捷功能管理 / 三个「新建」）。
 *
 * 只做**界面外壳**，不含数据层 —— 那些在 `useAppContext()` 里。主区域渲染
 * `{children}`（主区域：多标签面板）。快捷键分发也在这里：它触发的东西一半是外壳
 * 自己的（设置 / 面板 / 主题），一半是面板现场（Provider），所以放在两层中间。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { getAgentHost } from "@fizz/agent-client/host";
import { useAppContext } from "@fizz/agent-kit/shared/hooks/use-app-context";
import { usePersistedNumber } from "@fizz/agent-kit/shared/hooks/use-persisted-number";
import { useIsMobile } from "@fizz/agent-kit/shared/hooks/useIsMobile";
import { useNotifyWatcher } from "@fizz/agent-kit/shared/hooks/use-notify-watcher";
import { ensureNativeNotifyReady } from "@fizz/agent-kit/shared/lib/notify";
import { useScreenAwake } from "@fizz/agent-kit/shared/hooks/use-screen-awake";
import { useErrorToast } from "@fizz/agent-kit/shared/hooks/use-error-toast";
import { useKeyboardInset } from "@fizz/agent-kit/shared/hooks/useKeyboardInset";
import {
  setSidebarCollapsed,
  useSidebarCollapsed,
} from "@fizz/agent-kit/shared/lib/sidebar-collapsed";
import { useAssistantPanelOpen } from "@fizz/agent-kit/shared/lib/assistant-panel";
import { AssistantPanel } from "@fizz/agent-kit/features/projects/AssistantPanel";
import { APP_EVENTS } from "@fizz/agent-kit/shared/lib/app-events";
import {
  findShortcutByEvent,
  isShortcutRecording,
  PANEL_SCOPED_SHORTCUT_ACTIONS,
  setShortcuts,
  useShortcuts,
  type AgentShortcutAction,
} from "@fizz/agent-kit/shared/lib/shortcuts";
import { setPendingDraft } from "@fizz/agent-kit/shared/lib/pending-draft";
import type { ProjectUiAction } from "@fizz/agent-kit/shared/lib/tool-actions";
import { Sidebar } from "@fizz/agent-kit/shell/layout/Sidebar";
import { ActivityBar } from "@fizz/agent-kit/shell/layout/ActivityBar";
import { useMobileSidebarOpen } from "@fizz/agent-kit/shared/lib/mobile-sidebar";
import { WebTitleBar } from "@fizz/agent-kit/shell/layout/WebTitleBar";
import {
  openHostTab,
  openLocalTerminalTab,
  openSettingsTab,
} from "@fizz/agent-kit/shared/lib/tool-tabs";
import {
  useDirtyTabCountSync,
  useExternalFileOpen,
} from "@fizz/agent-kit/shell/layout/use-external-file-open";
import { openTab } from "@fizz/agent-kit/shared/lib/panel-store";
import { NEW_TAB_KEY } from "@fizz/agent-kit/shared/lib/panel-tabs";
import { useActiveActivity } from "@fizz/agent-kit/shell/activities";
import type { NewInWorkspaceKind } from "@fizz/agent-kit/shared/lib/new-in-workspace";
import { StatusBar } from "@fizz/agent-kit/shell/layout/StatusBar";
import { StatusBarNodes } from "@fizz/agent-kit/shell/layout/status-bar-nodes";
import { LogsButton } from "@fizz/agent-kit/shell/layout/LogsButton";
import { FilesButton } from "@fizz/agent-kit/shell/layout/FilesButton";
import { SysmonButton } from "@fizz/agent-kit/shell/layout/SysmonButton";
import { AppUpdateBadge } from "@fizz/agent-kit/shell/layout/AppUpdateBadge";
import { AppUpdateNotifier } from "@fizz/agent-kit/shell/AppUpdateNotifier";
import { SystemMonitorBadge } from "@fizz/agent-kit/shared/components/SystemMonitorBadge";
import { BackgroundTasksBadge } from "@fizz/agent-kit/shared/components/BackgroundTasksBadge";
import { TransferBadge } from "@fizz/agent-kit/shared/components/TransferBadge";
import { CommandPalette } from "@fizz/agent-kit/shell/CommandPalette";
import { ScriptRunHost } from "@fizz/agent-kit/features/scripts/RunScriptDialog";
import { ImportConversationDialog } from "@fizz/agent-kit/features/projects/ImportConversationDialog";
import { ManageWorktreeDialog } from "@fizz/agent-kit/features/projects/ManageWorktreeDialog";
import { NewWorktreeDialog } from "@fizz/agent-kit/features/projects/NewWorktreeDialog";
import { QuickActionsDialog } from "@fizz/agent-kit/features/projects/QuickActionsDialog";
import { PluginsDialog } from "@fizz/agent-kit/features/projects/PluginsDialog";
import { ResizeHandle } from "@fizz/agent-kit/shared/components/ResizeHandle";
import { TooltipProvider } from "@fizz/ui/tooltip";
import { ConfirmProvider } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

/**
 * react-dnd 的**单例槽**（`DndProvider` 里那个模块级 `refCount` + `INSTANCE_SYM`）。
 *
 * ## 为什么不能省这个参数（这里踩过一个非常隐蔽的坑）
 *
 * 不传 `context` 时 `DndProvider` 用**全局对象**（浏览器下就是 `window`）当槽，并且
 * `isGlobalInstance` 为真 —— 它会在 effect 里 `++refCount`，清理时 `--refCount`，
 * **归零就把槽清掉**。而 StrictMode 的「跑一遍 → 清理 → 再跑」正好把 refCount 打到 0，
 * 槽被清空。
 *
 * 槽空了之后，**任何一次 `DndProvider` 的重渲染都会再造一个 `DragDropManager` +
 * 一个 `HTML5BackendImpl`**（`createSingletonDndContext` 只在 render 期跑）。旧后端的
 * 全局 `drag*` 监听还留在 DOM 上、旧后端上的拖拽目标还注册着，而新组件全部挂到新后端 ——
 * 于是出现「拖拽能起来、`dragenter` 也能冒泡到落区节点，但 `hover` / `canDrop` / `drop`
 * 永远不触发」这种极难定位的现象（`dragenter` 把 targetId 推进了旧后端的数组，顶层
 * `handleTopDragEnter` 读的却是新后端的空数组）。
 *
 * 传一个**自定义 context** 后 `isGlobalInstance` 为 false：槽由我们自己持有、永不被清，
 * 且首次 render 建好后一直复用 —— 整个应用只有一个 manager / 一个后端。
 *
 * ⚠️ 这个 context **必须是 `window` 本身**，不能随手给个 `{}`：HTML5 后端把它当
 * `OptionsReader.globalContext` 用 —— `rootElement` 直接取它（顶层 `drag*` 监听挂在这上面）、
 * `document` 取它的 `.document`。给空对象的话 `rootElement` 没有 `addEventListener`，
 * `setup()` 里的 SSR 护栏会直接 return —— 顶层 `handleTopDragEnter/DragOver/Drop` 一个都不注册，
 * 落区同样彻底失效（而且没有任何报错）。
 */
const DND_CONTEXT: unknown = typeof window === "undefined" ? {} : window;

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    app,
    theme,
    toggleTheme,
    openConversation,
    newTarget,
    openNewDialog,
    closeNewDialog,
    activePanel,
    toggleSideTab,
    showSideTab,
    toggleTerminalPanel,
    canTerminal,
    hasDirectory,
    hasWorkspace,
    quickSnapshot,
    saveQuickConfig,
    refreshQuickConfig,
    quickManageOpen,
    setQuickManageOpen,
  } = useAppContext();

  /** 打开主区域标签前先站到会渲染面板的那块视图上（面板只在对话视图渲染） */

  /**
   * `app` 的最新一份，给「只需要读它几个字段」的长期订阅用。
   *
   * 为什么需要：`useAgentApp()` **每次渲染都新建一个对象**（`agentAppFrom` 里
   * `return { … }`，没有 memo），而流式期间每个 token 都会让 `AppProvider` 重渲染 ——
   * 任何把 `app` 写进 effect 依赖的地方都会每帧重跑。读字段的订阅（如下面那个
   * `uiAction` 监听）改成读 ref：功能一模一样，但不再每帧摘挂一次监听器。
   *
   * 同一套做法在 `GitPanel` / `ServerDirPicker` 里已经用过（那边注释写了「直接进依赖
   * 会死循环 / 每帧重拉」）。⚠️ 只在**事件回调、订阅体**里这样用；
   * 依赖里该放 `app` 的 `useCallback` / `useMemo` 照旧放 —— 那是为了拿到新值。
   */
  const appRef = useRef(app);
  appRef.current = app;

  /** 对话结束 / 等你确认时的系统通知（挂在外壳，覆盖整个应用） */
  useNotifyWatcher();

  /**
   * 安卓壳：启动时补一次系统通知授权。
   *
   * 安卓 13+ 的 `POST_NOTIFICATIONS` 是**运行时权限**，不要就永远收不到后台提醒 ——
   * 而通知的意义恰恰是「用户不在看这个页面」，等他进设置页手动点就太晚了。
   * 只在原生壳里跑（web 的授权必须由真实手势触发，见 `notify.ts` 的说明），
   * 且整个会话只问一次；已经授权 / 已拒绝都不会再打扰。
   */
  useEffect(() => {
    void ensureNativeNotifyReady();
  }, []);

  /**
   * 项目管理工具的 UI 动作(见 lib/tool-actions.ts):AI 助手 / 普通会话里
   * 说「打开 xx」「给 yy 建个会话」,工具结果一到,这里全局接住。
   * - `open-workspace`:切工作区 + 落到空态对话页 + 切到对话视图;
   * - `conversation-created`:打开刚建好的那个会话(选中 + 切视图两件事一起做,
   *   与侧栏点会话行同一条路);列表刷新不用管 —— state-ws 推 conversations 快照,自动;
   *   带 `prompt` 时先记下待预填草稿 —— 打开动作会让新会话的 ChatPanel 挂上来,
   *   那边挂好后主动来取 (lib/pending-draft.ts)。⚠️ 顺序不能反:必须先记再打开;
   * - `project-created` 不处理:项目清单本来就自动刷新,抢把工作区切走反而突兀;
   * - `browser-active`:Agent 调了 `browser_*` → 自动把浏览器画面面板挂出来。三道闸:
   *   ① 只在「正看的这个会话」里动作(后台会话用浏览器不该抢当前会话的面板);
   *   ② 已挂出过就不动(Agent 一轮里会连着 snapshot / click,逐个弹会反复抢焦点);
   *   ③ 这个会话**真的开了内置浏览器**(会话开关 + 运行时已装)。
   */
  useEffect(() => {
    const onUiAction = (e: Event): void => {
      const detail = (e as CustomEvent<ProjectUiAction>).detail;
      /** 每次事件都用**当时**的那份 app（ref 读最新），而不是闭包里那份 */
      const current = appRef.current;
      if (detail?.action === "open-workspace") {
        current.selectWorkspace(detail.workspaceId, false);
        current.openConversation(null);
        // 这是用户/工具明确打开工作区，不是冷启动的空态：此时才创建新对话占位标签。
        openTab(NEW_TAB_KEY);
        return;
      }
      if (detail?.action === "conversation-created") {
        if (detail.prompt)
          setPendingDraft(detail.conversationId, detail.prompt);
        openConversation(detail.conversationId, detail.workspaceId);
        return;
      }
      if (detail?.action === "browser-active") {
        if (detail.conversationId !== current.activeConversationId) return;
        if (activePanel?.browserMounted) return;
        /**
         * 第三道闸的由来:动作只凭**工具名**判(`browser_*`),而外部 playwright-mcp 的
         * 工具名与内置这套完全相同(`browser_navigate` / `browser_click` …)。
         * 于是「会话没开内置浏览器、只是选了 playwright MCP」时,模型一调工具就把内置
         * 浏览器面板弹出来 —— 画面永远是空的,因为页面跑在 MCP 自己那个浏览器里。
         * 所以这里按「这个会话实际能不能挂内置 browser_*」复核一遍。
         *
         * ⚠️ 残留:开关开着、同时又挂了带同名工具的外部 MCP(内置已让位给 MCP,见
         *    apps/server/src/server/chat-turn.ts)时,仍会为 MCP 的调用弹一次空面板 ——
         *    让位发生在服务端装配时,客户端没有这份信息。要彻底精确得让 `start` 帧
         *    带上「本轮挂了内置浏览器」标志,收益不值当。
         */
        const conversation = current.conversations.find((c) => c.id === detail.conversationId);
        if (!current.browserInstalled || !conversation?.browserSettings?.enabled) return;
        showSideTab("browser");
      }
    };
    window.addEventListener(APP_EVENTS.uiAction, onUiAction);
    return () => window.removeEventListener(APP_EVENTS.uiAction, onUiAction);
    /*
     * `app` 不在依赖里（读它几个字段而已，不是它的**引用**需要我们重新订阅）：
     * `useAgentApp()` 每次渲染都新建一个对象，而流式期间每个 token 都会让 Provider
     * 重渲染 —— 把 `app` 放进依赖，这个 effect 就每帧摘一次、挂一次 window 监听
     * （功能不变，纯属白干）。用 ref 读到最新那份即可。
     *
     * 真正需要重订阅的是 `activePanel` / `openConversation` / `showSideTab`（它们变了
     * 回调要闭到新值）；`app` 换成 ref 后它们仍是原样参与依赖。
     */
  }, [appRef, activePanel, openConversation, showSideTab]);

  /**
   * 屏幕常亮：手机上等一轮 Agent 跑完不用守着不让手机息屏。
   *
   * 和通知一样挂在外壳上、只挂一次：常亮是整屏的事，所有标签页
   * 都是「放着跑一会儿」。偏好（默认开）在「设置 → 通用」里。
   */
  useScreenAwake();

  /** 「导入会话」的目标项目：项目「更多」菜单触发，弹窗挂在顶层（与三个新建弹窗同层） */
  const [importWorkspaceId, setImportWorkspaceId] = useState<string | null>(
    null,
  );

  /** 「项目插件」弹窗要看的项目（null = 关着）；插件按项目独立查看 / 启停 */
  const [pluginsWorkspaceId, setPluginsWorkspaceId] = useState<string | null>(
    null,
  );

  /**
   * 多智能体协作：**点一下直接建会话**，不再弹窗选模型 / 配班子。
   *
   * 默认班子见 `defaultCollabSettings()`；主模型沿用上次发送用的内置模型，没有就留空
   * 让用户在建好的会话里选（与空白页同一条规矩）。建好后打开它 —— 与原来
   * 「新建会话」弹窗的落点一致。
   */
  const startCollabConversation = useCallback(
    (workspaceId: string): void => {
      void app.newCollabConversation(workspaceId).then((id) => {
        if (id) openConversation(id, workspaceId);
      });
    },
    [app, openConversation],
  );

  /**
   * 落到「创建新任务」页（**不建会话**）：切到目标项目 + 清空当前会话 + 开占位标签 + 切视图。
   *
   * 会话本身等第一句发送时才由 `runRound` 里的 `newConversation` 创建。这样「新对话」
   * 与项目行「新建会话」都只是打开一个页面，不会留下一串没人用过的空会话。
   */
  const startDraftConversation = useCallback(
    (workspaceId: string | null): void => {
      app.selectWorkspace(workspaceId, false);
      app.openConversation(null);
      openTab(NEW_TAB_KEY);
    },
    [app],
  );
  const importWorkspace = importWorkspaceId
    ? (app.workspaces.find((w) => w.id === importWorkspaceId) ?? null)
    : null;

  const [paletteOpen, setPaletteOpen] = useState(false);

  // ---- 可配置快捷键：配置在共享存储里（设置页写、这里分发），分发监听也在这里 ----
  const shortcuts = useShortcuts();
  /*
    「设置页录制中」不再是一个 ref：设置是主区域里的标签，`SettingsTabContent` 与
    这里的全局分发是两棵子树，靠 ref 传不过去。录制态由 `setShortcutRecording()`
    广播到模块级状态，所有监听器统一读 `isShortcutRecording()` —— 一个布尔值只有
    一份，才不会出现「在设置里录 Ctrl+W，结果把设置标签关掉了」。
  */
  /** 「按住说话」的按下状态：记下是哪颗物理键按下的，松手时只认那颗键，
   *  不依赖 keyup 重新匹配组合（松开瞬间修饰键状态可能已变，重匹配会漏发 voiceStop，
   *  导致麦克风卡在开启、后续再按被 Composer 的 listening 守卫拦掉）。 */
  const voiceHeldRef = useRef<string | null>(null);
  /** 语音输入快捷键（按住说话）当前是否可用 —— desktop 宿主缺语音服务，收掉（见下面 onKey） */
  const voiceShortcutAvailable = getAgentHost().capabilities.voice;

  /** 弹窗要用的项目对象（被删掉时回落成 null，弹窗里会显示「当前项目」并禁用提交） */
  const newWorkspace = newTarget
    ? (app.workspaces.find((w) => w.id === newTarget.workspaceId) ?? null)
    : null;

  // ---- 侧边栏折叠：desktop 标题栏最左边的开关读写同一份状态 ----
  const sidebarCollapsed = useSidebarCollapsed();
  /**
   * 当前功能区：侧边栏显示什么由它决定（活动栏点击切换 / 折叠）。
   * `sidebarVisible` 已经把「这个功能区没有侧边栏」也算进去了 —— 外壳只认它。
   */
  const { sidebarVisible } = useActiveActivity();
  /** AI 助手面板开关(全局,记 localStorage;见 lib/assistant-panel.ts) */
  const assistantOpen = useAssistantPanelOpen();
  // 手机形态下侧栏是**覆盖抽屉**，没有「收起」这回事：折叠态只在非手机形态生效。
  // 开合状态在 Provider（对话工具条的汉堡按钮也要开它）
  const isMobile = useIsMobile();
  const sidebarHidden = !sidebarVisible && !isMobile;
  // 手机上竖条（活动栏）**和侧栏抽屉同进同出**，而它们**只有一份状态**：抽屉开关
  // （`app/layout/mobile-sidebar.ts`，抽屉开着 → 竖条占位，收着 → 两个都没）。
  // 竖条在不在是**派生**出来的，不是另一个开关 —— 两份状态必然不同步。
  // 桌面 / web 不看这份状态：那儿横向不紧张，竖条与侧栏各自常驻。
  const mobileSidebarOpen = useMobileSidebarOpen();
  const railHidden = isMobile && !mobileSidebarOpen;
  /**
   * 助手面板是否**右侧停靠**（手机形态是整屏浮层，不占工作行宽度）。
   * 主区与助手之间的间隙怎么分，看下面 `main` / `aside` 的注释。
   */
  const assistantDocked = assistantOpen && !isMobile;
  /** desktop 宿主自带原生标题栏（另一棵树），web 这边自己画一条 `WebTitleBar` */
  const isDesktopHost = getAgentHost().capabilities.nativeTitleBar;
  /*
   * 只量键盘 → `<html>` 上的 `--kb-inset`（信息量，给需要自己抬一下的浮层用）。
   * ⚠️ 它**不再决定应用高度**：高度链是 `html, body, #root { height: 100% }`，
   * 键盘让位靠 `index.html` 的 `interactive-widget=resizes-content`。
   * 原因见 `useKeyboardInset.ts` 文件头（JS 写 px 会让聚焦瞬间整页高度抖一下）。
   */
  useKeyboardInset();

  /**
   * 折叠动画：只在「收起 / 展开」切换期间把过渡打开（拖拽宽度时不能挂过渡，
   * 否则面板拖在光标后面发飘）。判定必须在渲染期间做（React 官方写法），
   * 否则过渡类比宽度变化晚一帧，动画不会发生。
   */
  const [prevCollapsed, setPrevCollapsed] = useState(sidebarCollapsed);
  const [collapseAnimating, setCollapseAnimating] = useState(false);
  if (prevCollapsed !== sidebarCollapsed) {
    setPrevCollapsed(sidebarCollapsed);
    setCollapseAnimating(true);
  }

  /** 可拖拽的 sidebar 宽度（跨会话记住）；抽屉宽度归对话标签管 */
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber(
    "fizz.agent.sidebarWidth",
    220,
  );

  /** 可拖拽的 AI 助手面板宽度（跨会话记住） */
  const [assistantWidth, setAssistantWidth] = usePersistedNumber(
    "fizz.agent.assistantWidth",
    384,
  );

  /**
   * 全局错误 → 右上角 toast（不自动隐藏）。
   * 挂在外壳而不是各个视图：这些错误（连不上服务端、clone 失败…）在哪个视图都可能发生，
   * 以前是会话面板里一条贴顶的红条，切到别的视图就没了。
   */
  useErrorToast(app.error, app.clearError);

  /**
   * 「用本应用打开本机 Markdown」这条链路的两端。
   *
   * 挂在外壳（不是某个功能区）：一头是**系统事件**（双击 `.md` 关联 / 菜单的 `Ctrl+O`），
   * 发生在哪个活动栏分区上都该生效；另一头是**脏标签计数**，要报到主进程去做退出拦截，
   * 是应用级的。两个在 web 上都是空操作（宿主不实现那几个方法），所以不需要平台判断。
   */
  useExternalFileOpen();
  useDirtyTabCountSync();

  /**
   * 打开设置：**主区域的一条标签**，所有宽度、所有端都一样。
   *
   * 不要去按 `isMobile()` 分叉成「窄屏弹窗」—— 标签条在窄屏**照样在**（`PanelGroupView`
   * 没有手机分支，标签多了横向滚），分叉只会让同一个入口在窄屏开弹窗、标签栏里却还留着
   * 一条 `settings:list`，同一份设置出现两种外壳。窄屏的「两级菜单」形态由
   * `SettingsShell` 自己的 `settingsNavForm()` 决定，与外壳无关。
   *
   * 桌面端原先走宿主 `openSettingsWindow` 开独立 BrowserWindow —— 那是另一个渲染进程 =
   * 另一份模块级 store 单例，设置里改完主窗口不知道（插件图标 / 系统监控开关 / 子任务
   * 偏好都踩过）。
   *
   * 普通入口不指定分组：`openSettingsTab()` 不带参时保留上次看的那一页。
   */
  const openSettings = (): void => {
    openSettingsTab();
  };

  const runShortcutAction = (action: AgentShortcutAction): void => {
    switch (action) {
      case "open-command-palette":
        setPaletteOpen(true);
        break;
      case "open-settings":
        openSettings();
        break;
      case "toggle-sidebar":
        // desktop 标题栏最左那颗按钮与这个快捷键共用（另见 app-events 的 titleAction）。
        // `setSidebarCollapsed` 写的是模块状态，两棵 React 树都会跟着重渲染。
        setSidebarCollapsed(!sidebarCollapsed);
        break;
      case "toggle-terminal":
        // 与顶栏终端主按钮同一套语义：正看着某条终端就收起面板，否则回到最后一条 / 新开一条
        if (canTerminal) toggleTerminalPanel();
        else toast.error("终端不可用：请先在左侧选中有目录的工作区");
        break;
      case "toggle-files":
        if (hasDirectory) toggleSideTab("files");
        else toast.error("文件面板不可用：请先选中有目录的工作区");
        break;
      case "toggle-git":
        if (hasDirectory) toggleSideTab("git");
        else toast.error("源代码管理不可用：请先选中有目录的工作区");
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "new-conversation":
        // 与侧栏「新对话」同一条路：落到「创建新任务」页，**不建会话**
        // （会话类型在模型下拉里选，第一句发送时才建）
        startDraftConversation(hasWorkspace ? app.activeWorkspaceId! : null);
        break;
    }
  };

  /**
   * 动作分发的稳定引用：标题栏事件监听与快捷键监听都通过它取最新实现 ——
   * 两个监听器只挂一次（不随 `runShortcutAction` 的重建而重挂），却总能调到带最新
   * 闭包的那份（titlebar 的「新建会话」要用到最新的工作区 / 会话状态）。
   */
  const runShortcutRef = useRef(runShortcutAction);
  runShortcutRef.current = runShortcutAction;

  /**
   * 自定义标题栏（desktop 宿主，另一棵 React 树）的功能按钮：按钮按下时广播一个
   * `AgentShortcutAction`（见 app-events 的 titleAction），这里接住、丢给同一套
   * `runShortcutAction` —— 标题栏按钮与快捷键共用一个动作分发，行为天然一致
   * （「打开设置」弹窗、「切换主题」都只有一份实现）。
   *
   * `detail` 是字符串（跨树传动作名，见 app-events 的说明）；不是已知动作时 switch
   * 自然什么都不做，这里无需额外校验。
   */
  useEffect(() => {
    const onTitleAction = (e: Event): void => {
      const action = (e as CustomEvent<string>).detail;
      if (typeof action === "string")
        runShortcutRef.current(action as AgentShortcutAction);
    };
    window.addEventListener(APP_EVENTS.titleAction, onTitleAction);
    return () =>
      window.removeEventListener(APP_EVENTS.titleAction, onTitleAction);
  }, []);

  // 应用内快捷键分发：捕获阶段拦下（优先于输入框 / xterm 自己的按键处理）。
  // 输入法组合中 / 长按重复 / 设置页录制中都不参与匹配。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.repeat || isShortcutRecording()) return;
      const hit = findShortcutByEvent(shortcuts, e);
      if (!hit) return;
      // 面板级动作（推送）：全局分发不碰它 —— 不拦截、不执行，留给面板自己在可见时挂的
      // window 监听（见 shortcuts.ts 的 PANEL_SCOPED_SHORTCUT_ACTIONS）。这里若照常
      // preventDefault + stopPropagation，会在捕获阶段先把按键吃掉，面板永远收不到。
      if (PANEL_SCOPED_SHORTCUT_ACTIONS.has(hit.action)) return;
      // 语音输入是「按住说话」：keydown 开启、keyup 取消，单独处理、不进通用分发
      // （松手停麦后再聚焦输入框，逻辑在 Composer 里）。
      if (hit.action === "voice-input") {
        // 桌面端（Electron 渲染进程）没有 Chromium 语音识别依赖的语音服务，这个动作
        // 暂时不可用 —— Composer 与 ShortcutsTab 同款按平台判断。这里**不拦截也不广播**，
        // 让这组按键照常交给浏览器：拦截了会「吞掉按键又什么都不做」。
        if (!voiceShortcutAvailable) return;
        e.preventDefault();
        e.stopPropagation();
        voiceHeldRef.current = e.code;
        window.dispatchEvent(new CustomEvent(APP_EVENTS.voiceStart));
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      runShortcutRef.current(hit.action);
    };
    // keyup：当初按下那颗键（或任意一个修饰键）松开就取消（voiceHeldRef 记的是按下时的 code），
    // 不重新匹配组合键 —— 避免松开瞬间修饰键状态变化、或 Alt 组合下主键 keyup 被浏览器吞掉
    // 导致 voiceStop 漏发、麦克风卡死、后续再按被 Composer 的 listening 守卫拦掉。
    // 是否真的停麦由 Composer 依据自身状态决定（避免误关按钮开启的麦、或在未收音时乱聚焦）。
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isShortcutRecording()) return;
      if (!voiceHeldRef.current) return;
      const isMainKey = e.code === voiceHeldRef.current;
      const isModifier = /^(?:Alt|Control|Meta|Shift)(?:Left|Right)?$/.test(
        e.code,
      );
      if (!isMainKey && !isModifier) return;
      voiceHeldRef.current = null;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent(APP_EVENTS.voiceStop));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
    // shortcuts 变化要重新挂监听（分发器读的是闭包里的清单）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts]);

  /**
   * （曾经的「窗口聚焦全量刷列表」已移除：这些清单全部接在状态 WS 的推送上，
   * 服务端任何变更实时到达，跨客户端改动不需要靠 focus 兜底 —— 每次 focus
   * 拉 7 个列表接口看起来就像在轮询。手动刷新入口在侧栏（Sidebar 的刷新钮）。）
   */

  /**
   * 未登录：什么都不渲染，等 `AppGate` 的 `ConnectGate` 接上。
   *
   * ⚠️ 这里**不再有任何跳转**。以前是「踢回独立 `/login` 路由」，但 `/login` 在这个
   * SPA 里从来就没有视图（Next 版才有那个页面），那句 `router.replace('/login')` 唯一
   * 的实际效果是把地址栏改成 `/login`、然后再被 `AppRoutes` 的兜底改回 `/chat`。
   * 真正的门禁一直是 `AppGate` 里那句 `host.showConnectionGate && !app.connection`
   * （`app/App.tsx`），这里只负责别把外壳闪出来。
   */
  if (!app.connection) return null;

  return (
    <TooltipProvider>
      {/* 命令式确认弹窗（`useConfirm()`）：标签关闭守卫等需要「弹框问一句再答复」的地方用。
          挂在这里 —— web / desktop 共用同一个外壳，不必各处再挂一个 Provider。 */}
      <ConfirmProvider>
        {/*
        **唯一**的 react-dnd 后端：活动栏重排、主区域标签拖拽、对话面板的队列 / 插话排序
        共用同一个 DragDropManager，靠 item type 隔离不同语义。
        ⚠️ 参考实现（dogi）在这里分了两套系统（活动栏原生 HTML5 + 标签页 react-dnd），
        原生 `draggable` 与 HTML5 后端的全局 `drag*` 监听会互相干扰 —— 所以统一走一套。
        ⚠️ `context={DND_CONTEXT}` **必须传**（见 `DND_CONTEXT` 的注释）：不传的话
        StrictMode 会把 react-dnd 的单例槽清空，之后重渲染就会偷偷再造一个后端。
        也正因为 manager 由这个根 provider 提供，**别处不要再挂 `DndProvider`** ——
        嵌套的 provider 在槽为空时会各自造一个后端（这正是之前拖拽落区失效的根因）。
      */}
        <DndProvider backend={HTML5Backend} context={DND_CONTEXT}>
          {/*
          ⚠️ 外壳根画**一次** `bg-sidebar`，它是整个应用画布那层唯一的底色（web 的顶栏、
          侧栏、底部状态栏、区域之间的留白都靠它）。配了背景媒体时 `--sidebar` 是半透明
          遮罩（默认 alpha 0.72），**每多一层就再压掉一截图**：两层 = 0.92，图基本看不见。

          所以宿主（`apps/desktop` / `apps/web` 的 `main.tsx`）**不要再在外面包一层
          `bg-sidebar`** —— 那层会先把整窗蒙一遍，侧栏再叠上这里这一层，症状就是
          「同一个主题 web 正常、desktop 侧栏像多了一层蒙版」（踩过）。
          真要加底色，加在**没有**被这里覆盖的区域（例如 desktop 自绘标题栏，它在
          `ClientRoot` 之外，自己带 `bg-sidebar`）。

          工作区画布由内容容器自己画 `bg-background`（`VIEW_FRAME`），不是这里。
          改这里之前先看 `themes.css` 里「主题背景」那段。
        */}
          {/* 高度链：`html/body/#root { height: 100% }`（见 src/index.css），整条由 CSS 决定 ——
            键盘弹起时布局视口跟着缩（`index.html` 的 `interactive-widget=resizes-content`），
            `100%` 自动贴到键盘上沿，输入框不会被盖住。这里**没有** JS 写 `--app-height`
            的那一步（为什么，见上面 `useKeyboardInset` 的注释）。 */}
          {/*
        外层竖向两段：**工作行**（活动栏 / 侧栏 / 主区 / 助手）在上，**底部状态栏**在下。
        状态栏要整宽，所以必须放在工作行之外单独占一行（见 StatusBar.tsx）。
      */}
          <div className="flex h-full flex-col overflow-hidden bg-sidebar text-foreground">
            {/*
          窗口级顶栏：**只有 web 宿主有**（desktop 那边是另一棵 React 树里的自绘标题栏，
          带原生窗口控制，见 `apps/desktop/src/renderer/TitleBar.tsx`）。这里补的是
          「品牌 + 手机上侧栏的唯一入口」，见 `WebTitleBar` 的文件头。
        */}
            {!isDesktopHost && <WebTitleBar />}
            {/* 工作行：`min-h-0 flex-1` 才让里面的侧栏 / 主区各自滚动，不被内容撑高。
            `relative` 是给手机端助手的浮层做定位基准：它只盖工作行，不盖顶栏
            （`absolute inset-0` 而不是 `fixed`，见下面助手那段）。 */}
            <div className="relative flex min-h-0 flex-1">
              {/*
          活动栏：最左的竖条图标（类 VS Code），点击切换功能区、拖拽重排。
          它**常驻**、不随侧边栏折叠消失 —— 否则收起侧边栏后就再没有入口切回别的功能区。
          菜单 / 展开侧栏已搬到**底部状态栏**（见 StatusBar.tsx），这里不再有底缘那一组。

          手机形态下随侧栏抽屉**同进同出**（`railHidden` 由抽屉开关派生）—— 收起来是
          **完全不渲染**（不是收成 0 宽留空），展开时是占位的常驻竖条。
        */}
              {!railHidden && <ActivityBar />}
              {/*
          侧边栏外壳：折叠动画 = 外层容器宽度过渡 + overflow-hidden 裁掉内部。
          外层一直挂着、不随折叠卸载：① 动画才有得播；② 行内状态收起后再展开还在。

          ⚠️ 折叠态就是**收成 0 宽**（连同内部的展开按钮一起消失）。这里踩过一轮：
          早先收成 0 + invisible，界面上确实没有任何入口能把它拉回来，于是改成收成
          36px 的窄条、里面放一个「展开侧栏」。窄条是**治标**的 —— 它让「折叠」永远
          折不干净（侧栏区域始终占着一条、还和展开态自己的按钮错位重影）。
          真正的解法是把展开入口挪到**常驻**的地方：**活动栏那颗「当前功能区」的图标**
          （桌面 = 折叠 / 展开侧栏，手机 = 开关抽屉），web 收起后底部状态栏还会补一颗
          「展开侧栏」（见 StatusBar 的 `showExpand`）。入口不依赖侧栏，
          侧栏就能老老实实收成 0。
        */}
              <div
                style={{ width: isMobile || sidebarHidden ? 0 : sidebarWidth }}
                onTransitionEnd={(e) => {
                  // 只认外壳自己那条：行内的 hover 变色 / 箭头旋转也会冒泡到这里
                  if (e.target !== e.currentTarget) return;
                  setCollapseAnimating(false);
                }}
                className={cn(
                  "relative shrink-0 overflow-hidden",
                  collapseAnimating &&
                    "transition-[width] duration-200 ease-out",
                )}
              >
                {/*
            侧栏本体：折叠时置 `invisible + opacity-0`（收起来的侧栏不该还能被 Tab 选中）。
            ⚠️ 两个属性都要挂过渡，但分工不同：
            - **opacity 是主角**：渐隐由合成器逐帧按 alpha 合成，动画结束时内容已经是
              alpha 0 —— 即使纹理没被主动失效，画出来的也是全透明。只靠 visibility 的
              话（旧实现），过渡期间按规范一直按 visible 绘制、结束瞬间才翻成 hidden，
              而那时宽度动画刚停、这块区域没有任何重绘，**旧纹理会以残影留在屏幕上**
              （左下角「菜单」按钮出现两颗、错位 2px，直到别的原因触发重绘才消失，实测踩过）。
            - visibility 管「过渡期间内容照旧可见 + 折叠后移出 Tab 焦点」：过渡中始终按
              visible 渲染，收起过程不会「内容先没、宽度后收」。
          */}
                <div
                  className={cn(
                    "h-full transition-[opacity,visibility] duration-200",
                    sidebarHidden
                      ? "invisible opacity-0"
                      : "visible opacity-100",
                  )}
                >
                  <Sidebar
                    onOpenChatView={() => {
                      // 项目行点击 / 新项目是**显式**开始新对话：创建占位标签并切视图。
                      // ⚠️ 零标签时 PanelView 自己也会补一张草稿标签（见那边的 useLayoutEffect），
                      // 但用户此刻通常停在别的标签上，所以要显式 openTab 把它摆到前台。
                      openTab(NEW_TAB_KEY);
                    }}
                    onNewInWorkspace={(
                      kind: NewInWorkspaceKind,
                      workspaceId: string,
                    ) => {
                      // 会话不再弹窗：普通会话落到该项目的「创建新任务」页（类型在模型
                      // 下拉里选，第一句发送时才建会话）；多智能体协作直接建（默认班子）；
                      // worktree 走各自的弹窗。
                      if (kind === "conversation")
                        startDraftConversation(workspaceId);
                      else if (kind === "collab")
                        startCollabConversation(workspaceId);
                      else openNewDialog(kind, workspaceId);
                    }}
                    onImportInWorkspace={setImportWorkspaceId}
                    onManagePlugins={setPluginsWorkspaceId}
                    width={sidebarWidth}
                  />
                </div>
              </div>
              {/* 侧栏右缘拖拽条：必须放在折叠外壳**外面**（外壳 overflow-hidden 会把它裁掉） */}
              {!isMobile && !sidebarHidden && (
                <ResizeHandle
                  width={sidebarWidth}
                  min={200}
                  max={480}
                  onResize={setSidebarWidth}
                />
              )}
              {/* 工作区「浮岛」：与 sidebar / 窗口边缘留出距离，圆角 + 底色区分。
            里面是主区域（`AppRoutes` → 多标签面板）。 */}
              {/*
          两端现在**都有**顶栏（desktop 自绘 / web 的 `WebTitleBar`），内容紧贴在它下面 ——
          上内边距去掉，只留四边的浮岛留白。

          ⚠️ 左内边距**只在手机形态给**：手机左边那根竖条常驻（不再支持藏起来），内容
          贴上去才不至于左右不对称；桌面 / web 的左边永远贴着竖条或侧栏，它们自带底色，
          视觉上就是那道留白。
        */}
              {/*
          右内边距 = 与助手面板之间那条间隙的**主区一侧**：助手停靠时各让 4px
          （`pr-1` + aside 的 `pl-1`），合起来 8px，拖拽线正好落在正中 —— 早先两边
          各给 8px（`pr-2` + `px-2`），中间空出 16px，看着像两块面板分家了。
          助手没停靠时这 8px 只是窗口右缘留白，与 aside 的 `pr-2` 同宽。
        */}
              <main
                className={cn(
                  "flex min-w-0 flex-1 flex-col",
                  assistantDocked ? "pr-1" : "pr-2",
                  isMobile && "pl-2",
                )}
              >
                {children}
              </main>

              {/*
          AI 助手：**全局**面板 —— 与当前标签无关。开关记在
          localStorage（lib/assistant-panel.ts），重开保持，入口在顶栏右上角。
          对话本身也持久化（store 里一份 + 本地存档一份，收起 / 刷新都接着聊；
          清空走面板右上角的「清除对话」），见 AssistantPanel 文件头。

          - **桌面 / 宽屏**：右侧停靠（带左缘拖拽条改宽度）。面板 + 侧栏 + 对话三栏并排。
          - **手机**：三栏挤不下，改为**浮层**盖住工作行 —— 之前手机上整块不渲染，
            顶栏那颗助手键就点了没反应（死键）；浮层形态下它才真正可用。
            ⚠️ 用 `absolute`（基准是工作行），**不要** `fixed`：`fixed inset-0` 会把顶栏
            一起盖掉，品牌、侧栏开关、助手开关全都看不见，界面上像「整块换了」。
            浮层盖不到顶栏，开 / 收都交给顶栏那颗开关；面板内**不再**另放收起键
            （全局形态只有这一个入口，见 AssistantPanel 的顶栏注释）。
        */}
              {assistantOpen &&
                (isMobile ? (
                  <div className="absolute inset-0 z-50 flex flex-col bg-surface-1">
                    <AssistantPanel
                      className="flex min-h-0 flex-1 flex-col overflow-hidden"
                      scope="project"
                    />
                  </div>
                ) : (
                  <>
                    {/* 助手面板左缘拖拽条：放在 aside 外面（否则会被面板 overflow 裁掉）；
                  面板在拖拽条右侧，向左拖才是增大宽度 → invert */}
                    <ResizeHandle
                      invert
                      width={assistantWidth}
                      min={320}
                      max={640}
                      onResize={setAssistantWidth}
                      onDoubleClick={() => setAssistantWidth(384)}
                    />
                    {/*
                左 4px = 与 main 的 `pr-1` 合成 8px 间隙（拖拽线居中）；右 8px = 窗口右缘
                留白，与助手收起时 main 的 `pr-2` 同宽。两处一起改才对称，别只调一边。
              */}
                    <aside
                      className="hidden shrink-0 flex-col pl-1 pr-2 md:flex"
                      style={{ width: assistantWidth }}
                    >
                      <AssistantPanel
                        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-surface-1"
                        scope="project"
                      />
                    </aside>
                  </>
                ))}
            </div>

            {/*
          应用内更新提示（desktop 打包版专属）：只在「有新版本待下载 / 已下载待重启」时
          弹一条常驻 toast，别的档位自己 dismiss。web 宿主没有 appUpdate，整块空转。
        */}
            <AppUpdateNotifier />

            {/* Full-width status bar: global controls/local monitor, focused-tab status, then AI toggle. */}
            <StatusBar
              app={app}
              onOpenSettings={openSettings}
              onOpenCommandPalette={() => setPaletteOpen(true)}
              /*
            系统监控条由设置 →「系统监控」的开关控制：关掉时整条不渲染（组件卸载 =
            轮询随之停；服务端的采样器已在保存设置时停掉）。`null` = 偏好还没拉到 →
            按默认（开）显示，免得首帧闪一下。
          */
              left={
                app.systemMonitorSettings?.enabled === false ? null : (
                  <SystemMonitorBadge api={app.api} />
                )
              }
              right={<StatusBarNodes app={app} />}
              /*
                右端 `actions` 槽：**后台任务** + **SFTP 传输**两个清单入口 + **更新指示条**
                （有事才出现的信息位）+ **应用日志**入口（最右那颗，右下角一眼可及）。
                AI 助手已上移到顶栏右上角（见 AiAssistantButton）。
                更新指示条点它只打开设置（不直接下载，理由见 AppUpdateBadge 文件头）。
                两颗清单徽标放最左（紧贴 spacer）：它们比「有新版本」更常用，点开都是一张
                清单；靠右那颗留给一眼可及的日志入口。
              */
              actions={
                <>
                  {/* 耗时活儿「转到后台」之后唯一的常驻可见处（无任务时自己隐掉） */}
                  <BackgroundTasksBadge app={app} />
                  {/* SFTP 上传 / 下载：原来是右下角一张常驻浮层，改成同款徽标（无传输时自己隐掉） */}
                  <TransferBadge />
                  <AppUpdateBadge onOpenSettings={openSettings} />
                  <SysmonButton />
                  <FilesButton />
                  <LogsButton />
                </>
              }
            />

            {/*
              设置**不再有弹窗形态**：它是主区域的一条标签（`settings:list`，见
              `openSettings`）。原先这里挂的 `SettingsDialog` 是「桌面端没有独立设置
              窗口时」的兜底，导致窄屏一个弹窗、标签栏里还留着一条设置 —— 两种外壳。
            */}
            {/* 快捷功能管理弹窗（落在当前工作区的 .fizz/workspace.json；入口是顶栏 ⚡ 下拉最底部） */}
            <QuickActionsDialog
              workspaceId={app.activeWorkspaceId ?? ""}
              snapshot={quickSnapshot}
              onSave={saveQuickConfig}
              onRefresh={refreshQuickConfig}
              open={quickManageOpen && !!app.activeWorkspaceId}
              onClose={() => setQuickManageOpen(false)}
            />
            {/* 命令面板：打开快捷键由上面的分发处理 */}
            <CommandPalette
              app={app}
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              onOpenConversation={openConversation}
              shortcuts={shortcuts}
              theme={theme}
              onToggleTheme={toggleTheme}
              onOpenSettings={openSettings}
              onOpenHost={(host) => {
                // 与「主机」侧栏点一行同一条路：SSH 主机 → 开主机终端标签（可多开）；
                // 本机终端配置 → 按它存下的 shell / 参数开一条宿主本机终端标签。
                // 都不进右侧面板，只是主区域的内容标签，并确保用户站在会渲染面板的视图上。
                // ⚠️ 本机终端与当前项目无关：目录来自这条配置自己的 cwd（留空 = 主目录），
                // 别把 activeWorkspace 传进去。
                if (host.kind === "local") {
                  openLocalTerminalTab({
                    cwd: host.cwd ?? "",
                    shellId: host.shellId ?? null,
                    shellName: host.shellName,
                    label: host.name,
                    args: host.args,
                    autoCommand: host.autoCommand,
                  });
                } else {
                  openHostTab(host);
                }
              }}
            />

            {/*
              「运行脚本」对话框：**全 App 只有一个实例**，挂在外壳顶层。
              入口有脚本清单的卡片和命令面板的脚本二级视图，两处都只发
              `openRunScriptDialog()` 请求（见 `shared/lib/script-run.ts`），
              各自渲染一份会在「关一个、开另一个」的时序里把 body 的 pointer-events 收错。
            */}
            <ScriptRunHost app={app} />

            {/* 项目插件：从项目「更多」菜单打开，看 / 启停**这个项目**的插件 */}
            <PluginsDialog
              app={app}
              workspaceId={pluginsWorkspaceId}
              open={!!pluginsWorkspaceId}
              onClose={() => setPluginsWorkspaceId(null)}
            />
            <ImportConversationDialog
              app={app}
              workspace={importWorkspace}
              open={!!importWorkspaceId}
              onOpenChange={(open) => !open && setImportWorkspaceId(null)}
              onImported={(ids) => {
                // 多选导入：逐条建好，落点开**最后一条**新建的（列表里最新的一条）
                const last = ids[ids.length - 1];
                if (last)
                  openConversation(last, importWorkspaceId ?? undefined);
                setImportWorkspaceId(null);
              }}
            />
            {/*
              ⚠️ 这里**不再挂 `TriggerDialog`**：定时任务的新建统一走主区域的
              `triggers:list` 面板（`TriggersPanel`，项目在表单里选）。项目行菜单里
              那一项已删，`NewInWorkspaceKind` 里的 `"trigger"` 也一并去掉了。
            */}
            {/* 新建 worktree：源项目就是 newWorkspace；建好后选中新项目并落到它的对话初始页 */}
            <NewWorktreeDialog
              app={app}
              workspace={newWorkspace}
              open={newTarget?.kind === "worktree"}
              onOpenChange={(open) => !open && closeNewDialog()}
              onCreated={(created) => {
                closeNewDialog();
                // 新工作区建好后落到它的「创建新任务」页（不建空会话）
                startDraftConversation(created.id);
              }}
            />
            {/* 管理工作区：扫描项目 `.worktree/` 下既有的 worktree，导入与移除都在这一个弹窗里 */}
            <ManageWorktreeDialog
              app={app}
              workspace={newWorkspace}
              open={newTarget?.kind === "worktree-load"}
              onOpenChange={(open) => !open && closeNewDialog()}
              onLoaded={(created) => {
                closeNewDialog();
                // 导入的 worktree 同样落到「创建新任务」页
                startDraftConversation(created.id);
              }}
            />
          </div>
        </DndProvider>
      </ConfirmProvider>
    </TooltipProvider>
  );
}
