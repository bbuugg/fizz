/**
 * desktop 自定义标题栏（参考根应用 `src/renderer/src/app/layout/TitleBar.tsx`）：
 * - 整条为拖拽区域（app-drag），交互元素用 app-no-drag 排除
 * - macOS：hiddenInset 保留交通灯，左侧留出交通灯位置，不渲染自绘控制按钮
 * - Windows / Linux：右侧自绘最小化 / 最大化(还原) / 关闭按钮
 *
 * 左侧：品牌区（应用 logo + 名字，从 AI Agent 侧栏顶部搬过来的 —— 侧栏收起后整条会消失，
 * 品牌不该跟着没）。
 *
 * 右侧：**AI 助手**开关键（靠窗口控制键左侧）。助手是全局右侧停靠面板，入口放窗口级
 * chrome 上才哪儿都能点到；web 的 `WebTitleBar` 也是同一位置（右上角）。
 *
 * 「应用日志」入口**已从这里移走**，下沉到**底部状态栏最右端**（`LogsButton`）—— 它低频、
 * 属全局工具，交给状态栏的 `actions` 槽。
 *
 * 除此之外**刻意不再放别的功能入口**（侧边栏折叠 / 搜索 / Window / About 都已移除）：
 * 侧边栏折叠在各侧栏自己身上（AgentSidebar / HostsSidebar / ApiPanel 里那颗按钮），
 * 命令面板走快捷键 `CommandOrControl+Shift+P`，退出走系统窗口控制与菜单。
 * **例外**：右侧浮窗开关（会话浮窗）—— 与 AI 助手同属**窗口级 chrome**（不是某个视图的
 * 入口），按用户要求放在这里。
 *
 * 与根应用的差别：平台判定用 navigator（desktop 的 preload 只暴露传输桥 + 窗口桥，
 * 没有 window.api.app.platform）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Minus, PictureInPicture2, Sparkles, Square, X } from 'lucide-react'
import { AppBrand, setAssistantPanelOpen, useAssistantPanelOpen } from '@fizz/agent-kit'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import type { DesktopWindowBridge } from '../shared/window'

declare global {
  interface Window {
    fizzWindow: DesktopWindowBridge
  }
}

/** 渲染端没有 process.platform：从 UA 判（macOS 的 UA 一定带 Mac） */
const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent)

/** 浮窗开关状态：初值 sendSync，之后靠事件同步（窗口开 / 关都会广播） */
function useConversationWindowOpen(): boolean {
  const [open, setOpen] = useState(() => window.fizzWindow.isConversationWindowOpen())
  useEffect(() => window.fizzWindow.onConversationWindowChange(setOpen), [])
  return open
}

/*
  `SettingsTitleBar` 已删除：那是独立设置窗口的自绘标题栏（「设置」+ 关闭）。
  设置现在是主区域的一条标签，标题就是标签名，不需要第二套标题栏。
*/

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  // 助手开关：模块级单例状态，与 app-shell 里那份是同一个（同一份 bundle，见 index.ts 导出说明）
  const assistantOpen = useAssistantPanelOpen()
  const floatOpen = useConversationWindowOpen()
  const toggleFloat = (): void => {
    if (floatOpen) {
      void window.fizzWindow.closeConversationWindow()
      return
    }
    // 首开用主窗口当前会话作种子；没有当前会话就落草稿（由渲染端决定）
    const active = useAgentStore.getState().activeConversationId
    void window.fizzWindow.openConversationWindow(active ?? undefined)
  }

  useEffect(() => {
    void window.fizzWindow.isMaximized().then(setMaximized)
    return window.fizzWindow.onMaximizedChange(setMaximized)
  }, [])

  return (
    // 底色与 AgentApp 的 header / sidebar 同色（bg-sidebar），窗口顶部连成一片。
    // ⚠️ 必须自己画：外层根容器是 `bg-transparent`（见 main.tsx，避免整窗多蒙一层），
    // 标题栏不画的话这里直接透出背景图，与下面那条侧栏色断成两截。
    <header className="app-drag flex h-8 shrink-0 items-stretch bg-sidebar">
      {/* macOS：左边这 76px 让给系统交通灯（主进程 hiddenInset + trafficLightPosition x:12） */}
      {IS_MAC && <div className="w-[76px] shrink-0" />}

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

      {/* 中间那段是空的拖拽区（浮窗的显隐在「设置 → 通用」里配，这里不放开关） */}
      <div className="flex min-w-0 flex-1 items-end" />

      {/*
        会话浮窗开关（右上角，AI 助手左侧）：窗口级 chrome。开着就关、关着就用当前会话开。
        状态由主进程广播同步（isConversationWindowOpen 首帧 + conversationWindowChange）。
      */}
      <div className="app-no-drag flex items-stretch">
        <TitleBarButton title={floatOpen ? '关闭浮窗' : '打开浮窗'} onClick={toggleFloat}>
          <PictureInPicture2 className="size-3.5" />
        </TitleBarButton>
      </div>

      {/*
        AI 助手（右上角，靠窗口控制键左侧）：全局右侧停靠面板的入口。桌面上直接调
        `setAssistantPanelOpen` 读写与 app-shell 同一份单例状态，AppShell 会跟着重渲染。
        `app-no-drag` 必须加：否则点它会变成拖窗口。样式复用同条的 `TitleBarButton`。
      */}
      <div className="app-no-drag flex items-stretch">
        <TitleBarButton
          title={assistantOpen ? '关闭 AI 助手' : '打开 AI 助手'}
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
  onClick,
  children
}: {
  title: string
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const base = 'flex w-11 items-center justify-center text-muted-foreground transition-colors'
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        destructive
          // shadcn v4 没有 --destructive-foreground token（Button 的 destructive 变体也是
          // bg-destructive text-white）：写 text-destructive-foreground 会因 token 缺失
          // 静默不生成，图标停在灰色
          ? `${base} hover:bg-destructive hover:text-white`
          : `${base} hover:bg-secondary hover:text-foreground`
      }
    >
      {children}
    </button>
  )
}
