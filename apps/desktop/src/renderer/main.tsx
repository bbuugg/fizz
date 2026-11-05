import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setAgentHost } from '@fizz/agent-client/host'
import { applyThemeClass, bootstrapLanguage, hydrateConnection, resolveTheme } from '@fizz/agent-kit'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { TitleBar } from './TitleBar'
import { ClientRoot } from './app/client-root'
import { ConversationWindow } from './app/ConversationWindow'
import { resolveWindowKind } from './app/window-kind'
import { openDeepLink } from './app/layout/use-deep-link'
import { desktopHost } from './host'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 宿主**必须在 render 之前注入**：UI 内部靠它拿请求实现 / 连接信息 / 本机终端
 * （见 `@fizz/agent-client` 的 `host.ts`）。
 *
 * ⚠️ 这里**不再注入路由适配器**：前端路由已整体移除。下面那个 `?window=conversation`
 * 是**查询参数**、不是路由 —— 主进程用 `loadFile(file, { query })` 传，这里直接读
 * `location.search`，与前端路由无关，别把它一起删了。
 */
setAgentHost(desktopHost)
/**
 * store 在 `@fizz/agent-kit` 模块求值时就建好了（那一刻宿主还没注入，连接读不到），
 * 而 desktop 的连接是「恒存在」的 —— 在这里补一次，否则 `AppShell` 的登录守卫
 * 会先 `return null`（`AppGate` 那道门禁在 desktop 上是关的），首屏空一帧。
 */
hydrateConnection()

/**
 * 首帧之前就把主题类名落上：`index.html` 里写死的是 `class="dark"`，浅色主题的用户
 * 否则会先闪一下深色再被 React 的 effect 纠正（两种窗口都走这里）。
 */
applyThemeClass(resolveTheme(desktopHost.loadTheme()))

/**
 * 一个渲染端服务**两种**窗口（主进程用查询参数区分，见 main/index.ts 的 loadRenderer）：
 * - 默认：主界面（自绘标题栏 + ClientRoot）；
 * - `?window=conversation&conversationId=…`：会话浮窗（**一条会话一个窗口**，窗内不切换；
 *   换一条会话 = 主进程带新 id 重载这个窗口，见 `main/index.ts` 的 `openConversationWindow`）。
 * 判定收在 `resolveWindowKind`（纯函数、带单测）。
 *
 * 设置**不是**一种窗口：它是主区域的一条标签（`settings:list`），与对话共享同一个
 * `AppProvider`。`?window=settings` 那条分支已于 2026-11 删除 —— 再开一个渲染进程就是
 * 第二份 store 单例，设置里改完主窗口不知道，见 `window-kind.ts` 的注释。
 */
const windowKind = resolveWindowKind(location.search)

bootstrapLanguage()

/**
 * 配色主题（`<html data-theme>`）同理：两种窗口都要在首帧前落上。
 *
 * 主题现在只在主窗口里改（设置是同一个渲染进程的标签），但**浮窗仍是独立 BrowserWindow**：
 * 它只收得到 `storage` 事件，所以监听还得挂在窗口这一层（见 bootstrapColorTheme）。
 * 背景媒体（图 / 视频）也两种窗口一视同仁，这里不关它。
 */
bootstrapColorTheme()

/**
 * 浮窗的 store 必须在 **render 之前** 种好：
 * `AppProvider` 挂着 `useAgentApp()`，它的「自动恢复上次会话」effect 在
 * activeConversationId 为空时会自己开一条会话 —— 它的**首次闭包**里 activeConversationId
 * 就是这里种下的值，于是不会再抢。
 *
 * 没有 id 就**什么都不种**（不再开草稿）：浮窗是「一条会话一个窗口」，没有 id 只可能是
 * 主进程漏传，界面上给「没有指定会话」的空态，不该顺手建一条草稿会话出来。
 */
if (windowKind.kind === 'conversation' && windowKind.conversationId) {
  void useAgentStore.getState().openConversation(windowKind.conversationId)
}

/**
 * 主窗口：首帧之前把「从浮窗跳过来」的会话接上（浮窗右上角「在主窗口打开」）。
 *
 * 主进程要存着这条深链的唯一理由就是这一刻：主窗口可能在托盘里（页面还活着，后续的
 * 靠 `useDeepLink` 的订阅接住），也可能刚被重建、页面还在加载（事件先存着）。
 * 这里**同步**取一次再渲染，首帧直接就是目标会话，不会先显示上一个再跳过去。
 */
if (windowKind.kind === 'main') openDeepLink(desktopHost.takePendingDeepLink?.() ?? '')

createRoot(container).render(
  <StrictMode>
    {windowKind.kind === 'conversation' ? (
      <ConversationWindow conversationId={windowKind.conversationId} />
    ) : (
      /*
        主窗口根**不画底色**（`bg-transparent`）。

        ⚠️ 这里曾经是 `bg-sidebar`：配了背景图 / 视频的主题下，`--sidebar` 是半透明遮罩
        （默认 alpha 0.72），于是整窗先蒙一层，`ClientRoot` → `AppShell` 的根再蒙一层
        —— 侧栏区域两层叠成 0.92，背景图几乎看不见。web 宿主没有这层外壳（`main.tsx`
        直接渲染 `ClientRoot`），所以同一套主题在浏览器里正常、在桌面端侧栏「多一层蒙版」。
        底色归 `AppShell` 的根画**一次**，这里只管竖向排布。
      */
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <TitleBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ClientRoot />
        </div>
      </div>
    )}
  </StrictMode>
)
