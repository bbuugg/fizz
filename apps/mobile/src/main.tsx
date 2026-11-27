// 宿主注册必须**最先**执行：store 在 agent-kit 模块求值时就建好了，`connection` 初值当场
// 读取（见 `bootstrap.ts` 头注释）—— 放在 main.tsx 模块体里会晚于 import 求值，
// hosted `/m` 同源页会从浏览器兜底读到 web 的 `fizz.web.connection`（看似已登录，
// 而终端/工作台走宿主读 `fizz.mobile.*`，全部抛「未连接服务端」—— 实测 2026-10）。
import './bootstrap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getAgentHost, setServerBase } from '@fizz/agent-client/host'
import { normalizeServerBase } from '@fizz/agent-client/api'
import { loadServerUrl } from './server-url'
import { hasLocalRuntime } from './runtime/bridge'
import { bootstrapLanguage, hydrateConnection } from '@fizz/agent-kit'
import { setSingleTabMode } from '@fizz/agent-kit/shared/lib/panel-store'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { ClientRoot } from './app/client-root'
import './index.css'

/**
 * 手机版**不支持多标签**：打开一个会话 / 工具就是把它换成当前视图，旧标签连同它的
 * 终端 / 流式订阅一起收起（行为与 web / desktop 不同 —— 它们有标签条与标签列表）。
 *
 * ⚠️ 必须在**任何** `openTab` 之前：第一次写入前就要定下语义，否则启动那一帧会先
 * 按多标签建出旧标签。放在模块体里就行（import 求值完、首次渲染前）。
 */
setSingleTabMode(true)

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 服务端地址 —— 壳里页面 origin 是 `https://localhost`，相对路径的 `/api`、SSE、WS
 * 一条都到不了 server，所以必须是绝对地址。
 *
 * 地址**不烘进产物**（同一个 APK 可以连不同服务器），按优先级取：
 *
 * 1. `?server=http://host:port`：调试用，这一次打开生效；
 * 2. `localStorage` 里保存的地址（登录页填写，见 `server-url.ts`）；
 * 3. 已保存连接里的 `serverBase`：老版本 APK 升级上来的兜底（那时地址是烘进来的，
 *    连接记录里带着它，但还没有单独存地址）。
 *
 * 都没有 = 未配置：hosted APK 登录页会要求先填地址；server 托管的 `/m/` 保持同源。
 * 内置本机运行时的 APK 跳过这条分支，由原生桥提供 loopback 连接。
 *
 * ⚠️ 必须在 `hydrateConnection()` **之前**注入：`hydrateConnection` 读的是
 * `host.loadConnection()`，覆盖值就是在那一步补进 `Connection.serverBase` 的；
 * 晚一步的话 store 会先按同源建好 api 并缓存，后面再改也无效。
 */
if (!hasLocalRuntime) {
  const queryServer = normalizeServerBase(new URLSearchParams(location.search).get('server'))
  const storedServer = normalizeServerBase(getAgentHost().loadConnection()?.serverBase)
  const serverBase = queryServer ?? loadServerUrl() ?? storedServer
  if (serverBase) setServerBase(serverBase)
}

// 现场恢复兼防回归：store 创建时（bootstrap 已注入宿主）已按 `fizz.mobile.*` 读过一次；
// 这里再同步一遍是防线 —— 若哪天宿主注入又晚于 store 初值，一律以宿主为准（见 agent-store.ts）
hydrateConnection()

/**
 * 配色主题：`useColorTheme` 只挂在设置 → 外观里，首屏得在这里先落上（否则启动瞬间是默认配色）。
 * `storage` 那条监听在壳里同样有用（多标签页 / 平板上同时开两个页面时）。
 */
bootstrapLanguage()
bootstrapColorTheme()

createRoot(container).render(
  <StrictMode>
    <ClientRoot />
  </StrictMode>
)
