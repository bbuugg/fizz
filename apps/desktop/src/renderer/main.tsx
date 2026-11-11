import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setAgentHost } from '@fizz/agent-client/host'
import { applyThemeClass, bootstrapLanguage, hydrateConnection, resolveTheme } from '@fizz/agent-kit'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { TitleBar } from './TitleBar'
import { ClientRoot } from './app/client-root'
import { desktopHost } from './host'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 宿主**必须在 render 之前注入**：UI 内部靠它拿请求实现 / 连接信息 / 本机终端
 * （见 `@fizz/agent-client` 的 `host.ts`）。
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
 * 否则会先闪一下深色再被 React 的 effect 纠正。
 */
applyThemeClass(resolveTheme(desktopHost.loadTheme()))

bootstrapLanguage()

/**
 * 配色主题（`<html data-theme>`）同理：首帧前落上。背景媒体（图 / 视频）也由它管。
 */
bootstrapColorTheme()

createRoot(container).render(
  <StrictMode>
    {/*
      主窗口根**不画底色**（`bg-transparent`）。

      ⚠️ 这里曾经是 `bg-sidebar`：配了背景图 / 视频的主题下，`--sidebar` 是半透明遮罩
      （默认 alpha 0.72），于是整窗先蒙一层，`ClientRoot` → `AppShell` 的根再蒙一层
      —— 侧栏区域两层叠成 0.92，背景图几乎看不见。web 宿主没有这层外壳（`main.tsx`
      直接渲染 `ClientRoot`），所以同一套主题在浏览器里正常、在桌面端侧栏「多一层蒙版」。
      底色归 `AppShell` 的根画**一次**，这里只管竖向排布。
    */}
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <TitleBar />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ClientRoot />
      </div>
    </div>
  </StrictMode>
)
