/**
 * 手机版的窗口级顶栏 —— **一条顶替桌面三条 chrome**。
 *
 * ## 它替掉了什么
 *
 * 手机上原来叠着三层 36px 的桌面外壳：品牌顶栏 + 主区域标签条（VS Code 那套方形
 * 标签、可拖拽分屏）+ 底部状态栏（系统监控 / 日志 / 更新）。
 * 竖屏本来只有 600–800px 高，三条 chrome 就吃掉 100px+，观感就是一个被压扁的桌面应用。
 * 现在顶栏只留这一条 `h-11`（底部**没有**导航条：设置入口在抽屉左下角，见
 * `layout/Sidebar.tsx`）：
 *
 * - **左**：抽屉开关（唯一的侧栏入口，见 `mobile-sidebar.ts`）；
 * - **中**：当前标签的名字（解析与桌面标签条同一份 `useTabMeta`）；
 * - **右**：后台任务徽标（有事才出现，见下）、新建对话。
 *
 * ## 单标签：没有标签条，也没有标签列表
 *
 * 手机版**不支持多标签**（`panel-store` 的 `setSingleTabMode`，由 `main.tsx` 打开）：
 * 打开一个会话 / 工具 = 把它换成当前视图，旧标签连同它的终端 PTY 与流式订阅一起收起。
 * 所以这里没有标签条、标签列表与关闭按钮 —— 换「看哪个会话」走左侧抽屉，换「看什么」
 * 就是替换当前标签。
 *
 * ## 手机版不做的两件事
 *
 * **AI 助手**：整屏浮层与顶栏入口一起撤掉（共享的 `AssistantPanel` 还在，本工程不挂）。
 * **应用日志**：原先在「更多」菜单里，入口与面板一起移除（`PanelView` 不再渲染
 * `LogsPanel`）。设置走抽屉左下角那一颗，不在这条顶栏上 —— 同一个动作两个入口，
 * 点了一个的人会以为另一个没反应。
 *
 * ⚠️ 别再在顶栏上挂「标签 / 多窗口」那类按钮：一旦有入口，用户就会以为后台还有别的
 * 标签在跑 —— 而单标签模式下它们真的不存在（`openTab` 已经把旧的收起了）。
 * **后台任务徽标是例外**：它显示的是服务端真实在跑的任务（别的会话、别的客户端起的也算），
 * 单标签模式下点开是一张清单，不是「标签列表」；一条任务都没有时它自己回 null，
 * 不占宽度。
 *
 * 它本来挂在桌面那条底部状态栏里（`app-shell.tsx` 的 `actions` 槽），手机壳没有那条栏
 * （`styles.css` 把 `--status-bar-height` 压成 0），所以搬到这里 —— 否则转到后台的克隆 /
 * 安装跑起来之后，用户离开那个页面就再也看不见它了。
 *
 * ⚠️ 本工程是**手机壳**：从 `app-shell.tsx` 到这里都按手机形态写死，不再按窗口宽度
 * 分岔（共享组件内部的 `useIsMobile` 是它们自己的事，真机上同样落在手机分支）。
 */
import { Menu, Plus } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  setMobileSidebarOpen,
  useMobileSidebarOpen
} from '@fizz/agent-kit/shared/lib/mobile-sidebar'
import { activeTabKey, openTab, usePanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import { NEW_TAB_KEY } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { BackgroundTasksBadge } from '@fizz/agent-kit/shared/components/BackgroundTasksBadge'
import { TransferBadge } from '@fizz/agent-kit/shared/components/TransferBadge'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useTabMeta } from '@/app/layout/use-tab-meta'

/** 顶栏上按钮的统一尺寸：`size-10` 在 18px 根字号下约 45px，够触摸目标推荐值 */
const BAR_BUTTON = 'size-10! shrink-0 p-0! text-muted-foreground hover:text-foreground'

export function MobileAppBar() {
  /** 订阅面板状态：当前标签被打开 / 替换时标题要跟着变（`activeTabKey()` 本身是裸读） */
  const panelState = usePanelState()
  const tabMeta = useTabMeta()
  const { app } = useAppContext()
  const sidebarOpen = useMobileSidebarOpen()

  /**
   * 当前标签：单标签模式下它恒等于「唯一开着的那一个」，标题直接取它的元数据。
   */
  const key = activeTabKey(panelState)
  const meta = key ? tabMeta(key) : null
  const label = meta?.label ?? 'Fizz'

  /**
   * 新建对话：与侧栏「项目行 → 新建会话」走同一条路。
   *
   * ⚠️ 不能只 `openTab(NEW_TAB_KEY)`：占位标签换了，但「当前会话」还是上一个，
   * 侧栏会继续高亮旧会话、新对话页也还挂在旧会话上下文上。必须先
   * `openConversation(null)` 把选中态退回空态。
   */
  const newConversation = (): void => {
    app.selectWorkspace(app.activeWorkspaceId, false)
    app.openConversation(null)
    openTab(NEW_TAB_KEY)
  }

  return (
    <header
      // 抽屉打开时整条顶栏跟着正文一起右移（`styles.css` 的
      // `[data-mobile-sidebar-open] [data-mobile-push]`）—— 顶栏 / 正文
      // 被同一个 token 推走，不会出现「正文走了、顶栏还原地不动」的半截效果。
      data-mobile-push=""
      // 状态栏安全区由这条自己补（`box-content` 让 h-11 之外再加上 padding）：
      // 外壳根不再垫底色，安全区若单独透明会露出与栏体不同的一截。
      className="box-content flex h-11 shrink-0 items-center gap-1 bg-background px-1.5 transition-transform duration-200"
      style={{ paddingTop: 'var(--safe-area-inset-top, 0px)' }}
    >
      {/* 抽屉开关：手机版侧栏唯一的入口（见 `mobile-sidebar.ts` 的一份状态一个写入者） */}
      <Button
        variant="ghost"
        className={BAR_BUTTON}
        aria-label={sidebarOpen ? '收起会话列表' : '展开会话列表'}
        aria-expanded={sidebarOpen}
        onClick={() => setMobileSidebarOpen(!sidebarOpen)}
      >
        <Menu className="size-5" />
      </Button>

      {/* 当前标签：只留名字。名字截断（长会话标题很常见），完整标题走 title */}
      <div className="flex min-w-0 flex-1 items-center px-1" title={meta?.title}>
        <span className="truncate text-sm font-medium">{label}</span>
      </div>

      {/*
        后台任务徽标（与桌面状态栏同一份组件）：没任务时回 null，跑着时「转圈 + 后台 N」，
        全结束是「清单 + 任务 N」。弹层朝下、按视口收 —— 桌面那套 `side="top"` +
        `w-[23rem]` 是给屏幕底缘的，搬到顶栏不改会顶出屏幕。
      */}
      <BackgroundTasksBadge
        app={app}
        side="bottom"
        contentClassName="w-[calc(100vw-1rem)]"
      />

      {/*
        SFTP 传输徽标：与后台任务同一套形态（没传输时回 null）。手机壳没有底部状态栏
        （`--status-bar-height` 压成 0），这颗徽标原本是右下角那张 `fixed` 浮层 ——
        贴屏幕底缘、没有收起态，正好压在内容右下角。搬到顶栏后与桌面同一份组件。
      */}
      <TransferBadge side="bottom" contentClassName="w-[calc(100vw-1rem)]" />

      {/* 新建对话：与侧栏「项目行 → 新建会话」同一条路；手机版没有 AI 助手，右侧只留它 */}
      <Button
        variant="ghost"
        className={BAR_BUTTON}
        aria-label="新建对话"
        title="新建对话"
        onClick={newConversation}
      >
        <Plus className="size-5" />
      </Button>
    </header>
  )
}
