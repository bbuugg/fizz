/**
 * 应用根组件（取代旧的 `AgentApp`）：web 与 desktop 两个宿主共用同一棵树。
 *
 * 组合顺序与 Next 版的层级一一对应：
 * - `TooltipProvider`（旧 `main.tsx` 里包的一层）
 * - `AppProvider`（Next 版在根 layout 的 `client-root.tsx`，跨导航不重建）
 * - 连接门禁：未连接时显示 `ConnectGate`（Next 版是独立的 `/login` 路由页）
 * - `AppShell`（Next 版 `(agent)/layout.tsx`）+ `AppRoutes`（三个页面）
 *
 * 两条登录 / 工作台互斥的规则照搬 Next 版：
 * - 未连接 → 只显示连接页（不套外壳，免得「侧栏 + 登录表单」同时出现）；
 * - 已连接但 URL 还停在登录路径 → 由 `AppRoutes` 兜底 `replace` 回对话。
 */
import { TooltipProvider } from '@fizz/ui/tooltip'
import { AppToaster } from '@fizz/agent-kit/shared/components/AppToaster'
import { ConnectGate } from '@/app/ConnectGate'
import { AppShell } from '@/app/app-shell'
import { AppRoutes } from '@/app/app-routes'
import { AppProvider } from '@/app/app-provider'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { getAgentHost } from '@fizz/agent-client/host'

export function App() {
  return (
    <TooltipProvider>
      <AppProvider>
        <AppGate />
      </AppProvider>
    </TooltipProvider>
  )
}

/**
 * 连接门禁：web 未登录时展示连接页，desktop（`showConnectionGate: false`）恒直接进主界面。
 *
 * `<AppToaster />` 挂在**这一层**而不是 AppShell 里：未登录时 AppShell 直接 `return null`
 * （否则会先闪出外壳 / 与登录页打架），登录页上就一个 Toaster 都没有 ——
 * 那里的错误提示只能退化成输入框下面的红字。放上来之后登录页与工作台共用同一个实例。
 */
function AppGate() {
  const { app, theme } = useAppContext()
  const host = getAgentHost()

  return (
    <>
      {/* 手机壳多传一个 safeArea：让出状态栏 / 手势导航条（见 AppToaster 的说明）。 */}
      <AppToaster theme={theme} safeArea />
      {host.showConnectionGate && !app.connection ? (
        <ConnectGate
          // 登录页与手机壳主区同色（顶栏 / 主区各画一层 `bg-background`，
          // 安全区由顶栏 / 主区自己补）；默认 `sidebar` 亮一档，会在状态栏那条露出灰带。
          canvas="background"
          initial={app.connection}
          error={app.error}
          onConnect={app.connect}
          onDismissError={app.clearError}
        />
      ) : (
        <AppShell>
          <AppRoutes />
        </AppShell>
      )}
    </>
  )
}
