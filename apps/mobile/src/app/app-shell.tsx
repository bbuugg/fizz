"use client";

/**
 * 应用外壳：侧栏抽屉 + 手机顶栏 + 主区域 + 全局弹窗（设置 / 命令面板 / 快捷功能管理 / 三个「新建」）。
 *
 * 本工程是**手机壳**（`apps/mobile`），这里按手机形态**写死**，不跟随窗口宽度：
 * 顶栏恒为 `MobileAppBar`、侧栏恒为覆盖抽屉（设置入口在抽屉左下角）、AI 助手恒为
 * 整屏浮层。共享组件（`packages/agent-kit`）自己的形态判断不归这里管 —— 在真机上
 * 它们同样落在手机分支。
 *
 * 只做**界面外壳**，不含数据层 —— 那些在 `useAppContext()` 里。主区域渲染
 * `{children}`（主区域：多标签面板）。快捷键分发也在这里：它触发的东西一半是外壳
 * 自己的（设置 / 面板 / 主题），一半是面板现场（Provider），所以放在两层中间。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getAgentHost } from "@fizz/agent-client/host";
import { useAppContext } from "@fizz/agent-kit/shared/hooks/use-app-context";
import {
  setMobileSidebarOpen,
  useMobileSidebarOpen,
} from "@fizz/agent-kit/shared/lib/mobile-sidebar";
import { useNotifyWatcher } from "@fizz/agent-kit/shared/hooks/use-notify-watcher";
import { ensureNativeNotifyReady } from "@fizz/agent-kit/shared/lib/notify";
import { useScreenAwake } from "@fizz/agent-kit/shared/hooks/use-screen-awake";
import { useErrorToast } from "@fizz/agent-kit/shared/hooks/use-error-toast";
import { APP_EVENTS } from "@fizz/agent-kit/shared/lib/app-events";
import {
  findShortcutByEvent,
  PANEL_SCOPED_SHORTCUT_ACTIONS,
  setShortcutRecording,
  setShortcuts,
  useShortcuts,
  type AgentShortcutAction,
} from "@fizz/agent-kit/shared/lib/shortcuts";
import { setPendingDraft } from "@fizz/agent-kit/shared/lib/pending-draft";
import type { ProjectUiAction } from "@fizz/agent-kit/shared/lib/tool-actions";
import { Sidebar } from "@/app/layout/Sidebar";
import { useAndroidBackHandler } from "@/app/android-back";
import { useSidebarSwipe } from "@/app/use-sidebar-swipe";
import { MobileAppBar } from "@/app/layout/MobileAppBar";
import {
  openHostTab,
  openLocalTerminalTab,
} from "@fizz/agent-kit/shared/lib/tool-tabs";
import {
  useDirtyTabCountSync,
  useExternalFileOpen,
} from "@/app/layout/use-external-file-open";
import { openTab } from "@fizz/agent-kit/shared/lib/panel-store";
import { NEW_TAB_KEY } from "@fizz/agent-kit/shared/lib/panel-tabs";
import type { NewInWorkspaceKind } from "@fizz/agent-kit/shared/lib/new-in-workspace";
import { CommandPalette } from "@/app/CommandPalette";
import { ScriptRunHost } from "@fizz/agent-kit/features/scripts/RunScriptDialog";
import { ImportConversationDialog } from "@fizz/agent-kit/features/projects/ImportConversationDialog";
import { ManageWorktreeDialog } from "@fizz/agent-kit/features/projects/ManageWorktreeDialog";
import { NewWorktreeDialog } from "@fizz/agent-kit/features/projects/NewWorktreeDialog";
import { QuickActionsDialog } from "@fizz/agent-kit/features/projects/QuickActionsDialog";
import { PluginsDialog } from "@fizz/agent-kit/features/projects/PluginsDialog";
import { SettingsPage } from "@/app/SettingsPage";
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
    settingsTab,
    clearSettingsTab,
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
   * - `browser-active`:Agent 调了 `browser_*` → 自动把浏览器画面面板挂出来。两道闸:
   *   ① 只在「正看的这个会话」里动作(后台会话用浏览器不该抢当前会话的面板);
   *   ② 已挂出过就不动(Agent 一轮里会连着 snapshot / click,逐个弹会反复抢焦点)。
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
   * 会话等第一句发送时才由 `runRound` 里的 `newConversation` 创建。
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * 任意位置右滑开抽屉、抽屉开着时左滑收起（判定见 use-sidebar-swipe.ts）。
   * 设置页是整屏 fixed、盖在抽屉之上：它开着时手势不接管，否则关掉设置页会发现
   * 抽屉已经在底下开好了。弹层（命令面板 / 底部抽屉）由 hook 自己按 role 拦。
   */
  useSidebarSwipe(!settingsOpen);

  // ---- 可配置快捷键：配置在共享存储里（设置页写、这里分发），分发监听也在这里 ----
  const shortcuts = useShortcuts();
  /** 设置页录制中：全局分发要让路，否则组合键既被录进去又执行一遍 */
  const shortcutRecordingRef = useRef(false);
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

  /** 侧栏抽屉开合：手机版侧栏**恒为覆盖抽屉**，开合状态在 Provider（对话工具条的汉堡键也读写它） */
  const mobileSidebarOpen = useMobileSidebarOpen();

  /**
   * 安卓返回（见 `android-back.ts`）：抽屉开着时先收抽屉，别直接回桌面。
   *
   * 排在这里而不是 `SettingsPage` 里：设置页自己注册的那条**后注册**（它后挂载），
   * 按处理器栈「后进的先问」自然压在抽屉之上 —— 先退设置页，再轮到抽屉。
   */
  useAndroidBackHandler(() => {
    if (!mobileSidebarOpen) return false;
    setMobileSidebarOpen(false);
    return true;
  });
  /*
   * ⚠️ 这里**刻意不装** `useKeyboardInset()`（web / desktop 那两棵外壳装着）。
   *
   * 手机壳的键盘会**缩布局视口**（`capacitor.config.ts` 的 `Keyboard.resize: 'native'`
   * 与 `SystemBars` 的原生让位 + `index.html` 的 `interactive-widget=resizes-content`），
   * `html/body` 用 `height: 100%` 就自动贴到键盘上沿。那套 JS 补偿是给「键盘只缩视觉
   * 视口、布局视口不动」的场景（iOS / 桌面浏览器）准备的，在手机上是**多余的第二次计算**：
   * 它把 `window.innerHeight` 拍成一个 px 值写进 `--app-height`，聚焦那一刻
   * `visualViewport` 与布局视口不是同一拍更新，于是先写一个偏小的值、150ms 后再写回
   * 正确值 —— 表现就是用户报的「一点输入框，整页高度先变一下又弹回去」。
   *
   * 想加回来？先确认键盘**不再**缩布局视口，否则就是重复补偿 + 高度抖动。
   * ⚠️ 也不要删 `index.html` 的 `interactive-widget=resizes-content`：只靠原生让位时
   * 终端底部快捷键条会落到输入法下层（用户报过）。
   */

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

  /** 打开设置：本工程恒为**独立整页**（`SettingsPage`，见它的文件头），没有弹窗形态。 */
  const openSettings = (): void => {
    // 清掉「指定分组」的请求：普通入口（侧栏菜单 / 快捷键）落回「通用」
    clearSettingsTab();
    setSettingsOpen(true);
  };

  /** 关闭设置：顺手清掉「指定分组」请求，下次从普通入口打开落回「通用」 */
  const closeSettings = (): void => {
    setSettingsOpen(false);
    clearSettingsTab();
  };

  /**
   * 快捷键录制态（页面 / 弹窗共用）：
   * 面板级快捷键（推送 / 关闭当前标签）的监听器也读这个状态，录制时按下的键既会被录下来，
   * 也会撞上面板自己的 window 监听 —— 不广播一下，录制 `Ctrl+W` 会顺手把当前标签关掉。
   * 见 shortcuts.ts 的 isShortcutRecording。
   */
  const handleShortcutRecordingChange = (recording: boolean): void => {
    shortcutRecordingRef.current = recording;
    setShortcutRecording(recording);
  };

  /** 模型选择下拉的设置入口请求到了某个分组：开弹窗，initialTab 随 props 透传下去 */
  useEffect(() => {
    if (settingsTab) setSettingsOpen(true);
  }, [settingsTab]);

  const runShortcutAction = (action: AgentShortcutAction): void => {
    switch (action) {
      case "open-command-palette":
        setPaletteOpen(true);
        break;
      case "open-settings":
        openSettings();
        break;
      case "toggle-sidebar":
        // 手机版侧栏是覆盖抽屉：开 / 合它，与顶栏那颗汉堡键同义
        setMobileSidebarOpen(!mobileSidebarOpen);
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
      if (e.isComposing || e.repeat || shortcutRecordingRef.current) return;
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
      if (shortcutRecordingRef.current) return;
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
          挂在外壳根上，各处不必再挂一个 Provider。 */}
      <ConfirmProvider>
        {/*
        **唯一**的 react-dnd 后端：共享组件里的拖拽（会话面板的队列 / 插话排序等）
        共用同一个 DragDropManager，靠 item type 隔离不同语义。
        ⚠️ `context={DND_CONTEXT}` **必须传**（见 `DND_CONTEXT` 的注释）：不传的话
        StrictMode 会把 react-dnd 的单例槽清空，之后重渲染就会偷偷再造一个后端。
        也正因为 manager 由这个根 provider 提供，**别处不要再挂 `DndProvider`** ——
        嵌套的 provider 在槽为空时会各自造一个后端（这正是之前拖拽落区失效的根因）。
      */}
        <DndProvider backend={HTML5Backend} context={DND_CONTEXT}>
          {/*
        **画布只在 `main` 上画一次**（`bg-background`）：外壳根保持透明，顶栏自己画
        一层（并补顶部系统栏安全区），这样带背景图 / 视频时媒体能透出来，不会出现
        「根 + 顶栏 + 正文各叠一层、层层几乎不透」。底部安全区由 `main` 的
        `padding-bottom` 让出（没有底部导航条了）。
      */}
          {/* 高度链：`html/body/#root { height: 100% }`（见 src/index.css），整条由 CSS 决定 ——
            键盘弹起时原生把布局视口一起缩，`100%` 跟着缩，输入框自然留在键盘上方。
            这里**没有** JS 写 `--app-height` 的那一步（为什么，见上面 `useKeyboardInset` 的注释）。 */}
          {/*
        外层竖向两段：**顶栏**（`MobileAppBar`）在上，**工作行**（侧栏抽屉 / 主区 / 助手浮层）
        居中。手机版没有底部导航条，设置入口在抽屉左下角（见 `layout/Sidebar.tsx`）。
      */}
          {/*
        系统栏安全区**由顶栏 / 主区自己补**：顶部是 `MobileAppBar` 的 padding-top，
        底部是 `main` 的 padding-bottom。两处各自画 `bg-background`，安全区与栏体 /
        画布同色、不会露出跟主题对不上的原生色带；外壳根不再垫底色、也不再带
        padding，否则会多叠一层、把媒体背景盖掉。

        这几个变量由 Capacitor 8 的 `SystemBars` 插件注入到 `<html>` 上
        （`android.insetsHandling` 默认 `css`，见 `capacitor.config.ts` 那段注释）；
        web / desktop 没有它们，fallback 到 0。

        ⚠️ 别改成 `env(safe-area-inset-*)`：安卓 WebView 的 `env()` 只报屏幕刘海，
        不报系统栏（返回 0），写了等于没写。
      */}
          <div
            className="flex h-full flex-col overflow-hidden text-foreground"
            // 抽屉开关的**唯一**状态源（CSS 只读它）：`styles.css` 的
            // `[data-mobile-sidebar-open] [data-mobile-push]` 把顶栏 / 正文
            // 一起右移一个 `--mobile-sidebar-width`。挂在外壳根上而不是 `main` 上，
            // 是因为要推的是**整块内容区**，不只正文。
            data-mobile-sidebar-open={mobileSidebarOpen ? "" : undefined}
          >
            {/*
          顶栏：**只有这一条** `h-11`（抽屉 / 当前标签 / 助手 / 更多，见 `MobileAppBar`）。
          本工程是**单标签**（`main.tsx` 调 `setSingleTabMode`）：既没有标签条，也没有标签列表。
        */}
            <MobileAppBar />
            {/* 工作行：`min-h-0 flex-1` 才让里面的侧栏 / 主区各自滚动，不被内容撑高 */}
            <div className="flex min-h-0 flex-1">
              {/*
          ⚠️ 这里**没有活动栏**（见 `app/activities.tsx` 的文件头）：侧栏固定是会话列表。
          外壳里也不再有「侧栏占位宽度 / 折叠动画 / 右缘拖拽条」—— 那些是桌面外壳的东西；
          手机版侧栏仍是 `ActivitySidebar` 的 mobile 抽屉（不占工作行宽度），但打开时
          **整块内容区**（顶栏 / 正文）被 `translate` 顶到右边，看起来像「推挤」。

          想加回功能区？先把 `activities.tsx` 的注册表恢复成多项，再在这里挂回
          `ActivityBar`（web 那份还在 `packages/agent-kit/src/shell/layout/ActivityBar.tsx` 可参考），
          同时把 `layout/Sidebar.tsx` 的固定渲染改回按 `useActiveActivity()` 分发、
          并删掉 `src/styles.css` 里 `--sidebar-mobile-inset: 0px` 那条覆盖（恢复竖条让位）。
          三处是一套，缺一处就会出现「抽屉左边空 40px」或「图标切了但侧栏不变」。
        */}
              <Sidebar
                onOpenChatView={() => {
                  // 项目行点击 / 新项目是**显式**开始新对话：创建占位标签并切视图。
                  // ⚠️ 零标签时 PanelView 自己也会补一张草稿标签（见那边的 useLayoutEffect），
                  // 这里仍要显式 openTab 才切得过去（单标签模式下它是「替换」）。
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
                onOpenSettings={openSettings}
                onOpenCommandPalette={() => {
                  // 抽屉是覆盖层（z-40）、命令面板是 dialog（z-50）：不收起抽屉的话，
                  // 面板会浮在半开的列表上面，背后还压着一层暗色遮罩，看着像卡住。
                  // 先收抽屉再开面板，视觉上是「从内容区打开」。
                  setMobileSidebarOpen(false);
                  setPaletteOpen(true);
                }}
              />
              {/*
          工作区「浮岛」：手机形态**一点内边距都不给** —— 内容直接铺满整屏，
          不再画「浮在桌面窗口里的画布」。

          抽屉打开时顶栏 / 正文整体右移一个侧栏宽度（规则在 `styles.css` 的
          `[data-mobile-sidebar-open] [data-mobile-push]`，与侧栏宽度共用
          `--mobile-sidebar-width`）：这就是 App 那种「推挤」，而不是原地盖一层。
          两块都带 `data-mobile-push`，根上那一份属性是唯一开关（见上面的注释）。
          `transition-transform` 必须留着：Tailwind v4 会把它展开成
          `transform, translate, scale, rotate`，正好覆盖 `translate` 属性。
        */}
              <main
                data-mobile-push=""
                className="flex min-w-0 flex-1 flex-col bg-background transition-transform duration-200"
                // 底部手势条安全区由画布自己让：没有底部导航条了，这里补上原来那条的
                // padding-bottom，内容不会压在系统手势条下面。
                style={{ paddingBottom: "var(--safe-area-inset-bottom, 0px)" }}
              >
                {children}
              </main>
            </div>

            {/* 设置：本工程恒为**独立整页**（`SettingsPage`，为什么不用弹窗见它的文件头）。
            入口是抽屉左下角那一颗（手机版没有底部导航）。 */}
            {settingsOpen && (
              <SettingsPage
                app={app}
                shortcuts={shortcuts}
                onSaveShortcuts={(next) => setShortcuts(next)}
                onShortcutRecordingChange={handleShortcutRecordingChange}
                initialTab={settingsTab ?? undefined}
                onClose={closeSettings}
              />
            )}
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

            {/*
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
