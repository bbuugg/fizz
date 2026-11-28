/**
 * desktop 自定义标题栏（参考根应用 `src/renderer/src/app/layout/TitleBar.tsx`）：
 * - 整条为拖拽区域（app-drag），交互元素用 app-no-drag 排除
 * - macOS：hiddenInset 保留交通灯，左侧留出交通灯位置，不渲染自绘控制按钮
 * - Windows / Linux：右侧自绘最小化 / 最大化(还原) / 关闭按钮
 *
 * 左侧：品牌区（应用 logo + 名字，从 AI Agent 侧栏顶部搬过来的 —— 侧栏收起后整条会消失，
 * 品牌不该跟着没）。品牌右侧是**菜单条**（目前只有「视图」：全屏 / 窗口置顶）。
 *
 * 右侧：**AI 助手**开关键（靠窗口控制键左侧）。助手是全局右侧
 * 停靠面板，入口放窗口级 chrome 上才哪儿都能点到；web 的 `WebTitleBar` 也是同一位置
 * （右上角）。窗口置顶在「视图」菜单里（带勾选），不再是独立图钉键。
 *
 * 「应用日志」入口**已从这里移走**，下沉到**底部状态栏最右端**（`LogsButton`）—— 它低频、
 * 属全局工具，交给状态栏的 `actions` 槽。
 *
 * 窗口级工具只留「菜单条 + AI 助手」（窗口控制键除外），**中间**是命令面板的搜索框。
 * 除此之外刻意不再放别的功能入口：侧边栏折叠在各侧栏自己身上（AgentSidebar /
 * HostsSidebar / ApiPanel 里那颗按钮），退出走系统窗口控制与菜单。
 *
 * 搜索框（`TitleBarSearch`）替代了底部状态栏最右那颗 ⌘ 图标 —— 图标按钮看不出是搜索，
 * 和旁边的日志 / 文件管理排成一排只能靠 tooltip 分辨；顶栏中央一条横贯的框才是「找东西
 * 去顶部」的预期。快捷键 `CommandOrControl+Shift+P` 照旧生效，只是不再是唯一入口。
 *
 * 与根应用的差别：平台判定用 navigator（desktop 的 preload 只暴露传输桥 + 窗口桥，
 * 没有 window.api.app.platform）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Minus, Sparkles, Square, X } from 'lucide-react'
import { AppBrand, setAssistantPanelOpen, useAssistantPanelOpen } from '@fizz/agent-kit'
import { MobileSidebarToggle } from '@fizz/agent-kit/shell/layout/MobileSidebarToggle'
import { TitleBarSearch } from '@fizz/agent-kit/shell/layout/TitleBarSearch'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { isShortcutRecording } from '@fizz/agent-kit/shared/lib/shortcuts'
import { isViewMenuKey } from '../shared/keys'
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarShortcut,
  MenubarTrigger
} from '@fizz/ui/menubar'
// `window.fizzWindow` 的全局声明在 `shared/window.ts`（纯类型文件，preload 与渲染端共用）

/** 渲染端没有 process.platform：从 UA 判（macOS 的 UA 一定带 Mac） */
const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent)

/*
  `SettingsTitleBar` 已删除：那是独立设置窗口的自绘标题栏（「设置」+ 关闭）。
  设置现在是主区域的一条标签，标题就是标签名，不需要第二套标题栏。
*/

export function TitleBar() {
  const t = useT()
  const [maximized, setMaximized] = useState(false)
  /**
   * 全屏状态：F11 由主进程拦截（终端等区域抢焦点时渲染端收不到键），所以启动时查一次，
   * 之后只认主进程的 `fullScreenChanged` 广播 —— 菜单文案与真实窗口状态不会分叉。
   */
  const [fullScreen, setFullScreen] = useState(false)
  /**
   * 窗口置顶状态：首帧同步取主进程那份偏好（与 loadCloseToTray 同一套路），
   * 重启后仍是上次退出时的状态。
   */
  const [onTop, setOnTop] = useState(() => window.fizzWindow.loadMainAlwaysOnTop())
  // 助手开关：模块级单例状态，与 app-shell 里那份是同一个（同一份 bundle，见 index.ts 导出说明）
  const assistantOpen = useAssistantPanelOpen()
  /** 「视图」菜单开合（受控：Alt+V 要在渲染端把它打开） */
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  useEffect(() => {
    void window.fizzWindow.isMaximized().then(setMaximized)
    const offMaximized = window.fizzWindow.onMaximizedChange(setMaximized)
    void window.fizzWindow.isFullScreen().then(setFullScreen)
    const offFullScreen = window.fizzWindow.onFullScreenChange(setFullScreen)
    return () => {
      offMaximized()
      offFullScreen()
    }
  }, [])

  /**
   * Alt+V 打开 / 收起「视图」菜单（Windows 菜单助记符 `视图(V)`）。
   *
   * 捕获阶段挂：xterm / Monaco 这类自己处理键盘的区域在冒泡阶段拦截，
   * 捕获阶段先轮到我们；设置页正在录制快捷键时让路，别把用户按的键吃了。
   * macOS 不绑：Option+V 在输入框里要用于输入 √。
   *
   * ⚠️ 全局快捷键里 Alt+V 是「语音输入」的默认值，但桌面端 `capabilities.voice`
   * 为 false、全局分发直接放行，所以这里不会抢它的键（见 `../shared/keys`）。
   */
  useEffect(() => {
    if (IS_MAC) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || isShortcutRecording()) return
      // 窄到手机宽度时菜单入口本身已隐藏（见 Menubar 的 `max-md:hidden`）：
      // 快捷键也不该再「打开一个看不见的菜单」，否则状态会留到下次拉宽时莫名弹开。
      // 断点与隐藏完全一致：`md` = 768px。
      if (window.innerWidth < 768) return
      const hit = isViewMenuKey({
        type: event.type,
        key: event.key,
        control: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        isAutoRepeat: event.repeat
      })
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      setViewMenuOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    // 底色与 AgentApp 的 header / sidebar 同色（bg-sidebar），窗口顶部连成一片。
    // ⚠️ 必须自己画：外层根容器是 `bg-transparent`（见 main.tsx，避免整窗多蒙一层），
    // 标题栏不画的话这里直接透出背景图，与下面那条侧栏色断成两截。
    //
    // ⚠️ `pointer-events-auto`：模态弹窗（Dialog / AlertDialog / Sheet / Drawer）打开时
    // Radix 会给 `body` 打 `pointer-events: none`（`DismissableLayer` 的
    // `disableOutsidePointerEvents`），整条标题栏连带最小化 / 最大化 / 关闭一起点不动 ——
    // 那三颗是**窗口级能力**，不该被应用里的一个弹窗挡住。遮罩本身已经从顶栏下沿开始
    // （见 `packages/ui` 的 `*Overlay`），这里只把点击还回去。
    <header className="app-drag pointer-events-auto flex h-8 shrink-0 items-stretch bg-sidebar">
      {/* macOS：左边这 76px 让给系统交通灯（主进程 hiddenInset + trafficLightPosition x:12） */}
      {IS_MAC && <div className="w-[76px] shrink-0" />}

      {/*
        手机形态（窗口缩到 <768px，渲染层切进手机版布局）下，活动栏竖条 + 侧栏抽屉的
        **唯一入口**。web 顶栏挂的是同一颗组件（`MobileSidebarToggle`），desktop 标题栏
        原先没有它 —— 窗口一拉窄，抽屉打不开、整个活动栏就再也回不来了（用户报过）。
        非手机宽度 / 当前功能区没有侧栏时它自己渲染成 null，不占位。
        `app-no-drag` 必须加：否则点它会变成拖窗口。
      */}
      <MobileSidebarToggle className="app-no-drag ml-1 self-center" />

      {/*
        品牌区：应用 logo + 名字。原来在 AI Agent 侧栏顶部，搬到标题栏 —— 侧栏收起后
        整条会消失，品牌不该跟着没；web 宿主没有自绘标题栏，那边仍留在侧栏顶栏里
        （同一个 `AppBrand` 组件，名字与图片只有一份来源）。

        ⚠️ **品牌本身仍不包 `app-no-drag`**（整块留着当拖拽区，窗口还能靠它拖）。
        `size-4.5`（18px）是给 36px 高的标题栏挑的 —— 侧栏那份是 `size-6`，
        直接搬过来会把整条撑满。
      */}
      <div className="flex shrink-0 items-center gap-1 pl-2 pr-1">
        <AppBrand iconClassName="size-4.5" nameClassName="text-xs" />
      </div>

      {/*
        菜单条（品牌右侧）：紧凑、无边框，与标题栏连成一片。
        `app-no-drag` 必须加在根上：菜单项的可点击区域落在拖拽区里时会被当成拖窗口。

        下拉面板按截图那种「整行高亮」样式收：内容只留 2px 内边距，行内左右撑开。
        **hover / 键盘高亮走主色**：不改 `@fizz/ui` 的 Menubar 原语（它用的是 accent），
        只在这块面板上把 `--accent` / `--accent-foreground` 两个变量就地换成
        primary / primary-foreground —— 这样连勾选图标、F11 角标这些子元素的
        `focus:**` 规则也会跟着变，不用逐条压 specificity。

        「视图」里的两项：
        - 全屏 / 退出全屏：文案随主进程广播的 `fullScreenChanged` 切换，右侧标注 F11
          （键由主进程拦截，见 main/index.ts 的 bindFullScreenShortcut）；
        - 窗口置顶：带勾选，状态仍由主进程落盘（重启后保持），与原来的图钉同一份偏好。
      */}
      <Menubar
        // 窄到手机宽度时整条菜单入口收起：与中间搜索框**同一个断点**（`md`）——
        // 那边文字一消失、只剩一颗搜索图标，这边再挂一条「视图(V)」就只有它挤不下。
        className="app-no-drag ml-3 h-auto gap-0 border-0 bg-transparent p-0 max-md:hidden"
      >
        {/* Base UI 的 Menubar 没有「当前打开哪个菜单」的 value 体系：开关状态挂在这个
            Menu 自己的 `open` 上（Alt+V 快捷键按下时就是它在驱动） */}
        <MenubarMenu open={viewMenuOpen} onOpenChange={setViewMenuOpen}>
          {/*
            `h-6 py-0 leading-none`：原语靠 `py-[2px] + text-sm 行高` 撑高度，换成
            固定 24px 高、行高 1 之后，中文按 em 盒在按钮里严格居中 —— 原来那套
            半行距叠在 CJK 上，视觉上会偏下。
            hover / 展开态用主色 20%：原语的 `muted` 比 sidebar 还浅，
            `sidebar-accent` 也只差 0.028 亮度，都看不出来。
            括号里的字母是 Windows 菜单助记符（截图里的 编辑(E)）：`视图(V)` 真的绑了
            Alt+V（见上面的捕获监听），mac 没有这套约定、也不显示。
          */}
          <MenubarTrigger className="h-6 rounded-[4px] px-3 py-0 text-xs leading-none hover:bg-primary/20 aria-expanded:bg-primary/20">
            {t('视图')}
            {!IS_MAC && <span className="ml-0.5">(V)</span>}
          </MenubarTrigger>
          {/*
            `alignOffset={0}`：原语默认 -4px，会让面板比入口左沿再往外探 4px；
            归零后面板左沿与「视图」按钮的左沿齐平。
          */}
          <MenubarContent
            alignOffset={0}
            className="min-w-44 rounded-[6px] px-2 py-1.5 text-xs [--accent:var(--primary)] [--accent-foreground:var(--primary-foreground)]"
          >
            <MenubarItem
              className="rounded-[3px] px-2 py-1.5 text-xs"
              onSelect={() => void window.fizzWindow.toggleFullScreen()}
            >
              {fullScreen ? t('退出全屏') : t('全屏')}
              <MenubarShortcut>F11</MenubarShortcut>
            </MenubarItem>
            <MenubarCheckboxItem
              /*
                对号挪到右端：原语的指示器是 `absolute left-1.5`，这里把直接子 span
                改到右边（`[&>span]` 的 specificity 高于原语的单个 `left-*` 类），
                再把行的左内边距收回来、右侧留出勾选位。
              */
              className="rounded-[3px] py-1.5 pl-2 pr-7 text-xs [&>span]:right-1.5 [&>span]:left-auto"
              checked={onTop}
              onCheckedChange={(checked) => {
                const next = checked === true
                setOnTop(next)
                void window.fizzWindow.setMainAlwaysOnTop(next)
              }}
            >
              {t('窗口置顶')}
            </MenubarCheckboxItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      {/*
        中间：命令面板的搜索框（点击弹出面板，与 web 顶栏同一颗 `TitleBarSearch`）。
        ⚠️ `app-no-drag` **只加在框本身**：这层 div 若整块设 no-drag，窗口中间就再也拖不
        动了 —— 空白处必须留给窗口拖拽（顶栏整条是 `app-drag`，见文件头）。

        窄到手机宽度（`<md`）时这层改为**靠右**：搜索框只剩一颗图标（文字隐藏、宽度收到
        `w-7`），再居中就会孤零零飘在中间；贴到右端与 AI 助手入口挨着，视觉上并进右侧那组
        窗口级按钮。宽屏仍是居中一条横贯的框。
      */}
      <div className="flex min-w-0 flex-1 items-center justify-end px-2 md:justify-center">
        <TitleBarSearch className="app-no-drag w-7 max-md:bg-transparent max-md:hover:bg-foreground/10 md:w-full md:max-w-xs" />
      </div>

      {/*
        AI 助手（右上角，靠窗口控制键左侧）：全局右侧停靠面板的入口。桌面上直接调
        `setAssistantPanelOpen` 读写与 app-shell 同一份单例状态，AppShell 会跟着重渲染。
        `app-no-drag` 必须加：否则点它会变成拖窗口。样式复用同条的 `TitleBarButton`。
      */}
      <div className="app-no-drag flex items-center">
        <TitleBarButton
          title={assistantOpen ? '关闭 AI 助手' : '打开 AI 助手'}
          active={assistantOpen}
          // 与搜索图标同形：24px 高 + 圆角，上下各留 4px（不再贴满标题栏整高）
          inset
          onClick={() => setAssistantPanelOpen(!assistantOpen)}
        >
          <Sparkles className="size-3.5" />
        </TitleBarButton>
      </div>

      {!IS_MAC && (
        <div className="app-no-drag flex items-stretch">
          <TitleBarButton title="最小化" onClick={() => void window.fizzWindow.minimize()}>
            <Minus className="size-3.5" />
          </TitleBarButton>
          <TitleBarButton
            title={maximized ? '还原' : '最大化'}
            onClick={() => void window.fizzWindow.toggleMaximize()}
          >
            {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </TitleBarButton>
          <TitleBarButton
            title="关闭"
            destructive
            onClick={() => void window.fizzWindow.close()}
          >
            <X className="size-3.5" />
          </TitleBarButton>
        </div>
      )}
    </header>
  )
}

/**
 * 标题栏上的一个按钮。
 *
 * ⚠️ **各个分支的类名必须整段二选一，不能拼在一起**。原来写的是
 * `'… hover:bg-secondary hover:text-foreground' + (destructive ? ' hover:bg-destructive …' : '')`
 * —— 两条 `hover:bg-*` 同时留在 class 里，谁生效**只由 Tailwind 产物里的先后顺序决定**
 * （实测 `hover:bg-destructive` 在 50993、`hover:bg-secondary` 在 52333，后者靠后、盖住前者），
 * 所以关闭按钮 hover 出来一直是灰的。这里没有 `cn`（tailwind-merge）可用，
 * 就老老实实写完整分支，别再用字符串拼接。
 */
function TitleBarButton({
  title,
  destructive,
  active,
  inset = false,
  onClick,
  children
}: {
  title: string
  destructive?: boolean
  /** 开关类按钮的开启态（目前只有 AI 助手）：图标用主题色，与 web 端 `AiAssistantButton` 一致 */
  active?: boolean
  /**
   * 与顶栏那颗搜索图标同形：高度收到 `h-6`、`rounded-md`，上下各留 4px。
   *
   * 窗口控制键（最小化 / 最大化 / 关闭）**不要**开这个 —— 它们要贴满标题栏整高，
   * 与系统原生按钮一个观感。
   */
  inset?: boolean
  onClick: () => void
  children: ReactNode
}) {
  /**
   * 开启态 / 普通态统一用「淡前景色」hover（与搜索图标一致）。
   *
   * `inset` 时宽度也跟搜索图标一致（`w-7`）：图标只有 14px，`w-11` 会在左右各多出
   * 15px 空白，看起来像「图标缩在中间」。窗口控制键要保持 44px 的点击宽度，不开 `inset`。
   */
  const base = `flex items-center justify-center transition-colors ${
    inset ? 'h-6 w-7 rounded-md' : 'w-11'
  }`
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? `${base} text-primary hover:bg-foreground/10 hover:text-primary`
          : destructive
            // shadcn v4 没有 --destructive-foreground token（Button 的 destructive 变体也是
            // bg-destructive text-white）：写 text-destructive-foreground 会因 token 缺失
            // 静默不生成，图标停在灰色
            ? `${base} text-muted-foreground hover:bg-destructive hover:text-white`
            : `${base} text-muted-foreground hover:bg-foreground/10 hover:text-foreground`
      }
    >
      {children}
    </button>
  )
}
