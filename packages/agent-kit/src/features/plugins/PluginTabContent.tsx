"use client";

/**
 * 插件界面在主视图区里的**标签页内容**。
 *
 * 与侧栏共用 `PluginSurfaceBody`（取数 / 渲染 / 动作都是同一套），这里只负责
 * 「从标签 key 反查是哪个插件的哪个面 + 它是什么参数开的」。
 *
 * ⚠️ 内容**常挂载**（非活动标签由内容层 `hidden` 藏而不卸，见 `PanelView` 的说明），
 * 所以别在这里做「切换标签就重来一遍」的事 —— 插件面里的状态留在内存里更好。
 */
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { getToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { PluginSurfaceBody } from '@fizz/agent-kit/features/plugins/PluginSurfaceBody'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function PluginTabContent({ tabKey }: { tabKey: string }) {
  const t = useT()
  const { app } = useAppContext()
  const tool = getToolTab(tabKey)
  /*
   * 标签 key 里只有 pluginId / surfaceId，**没有**「谁来渲染」。
   * 那份信息在界面清单上（`renderMode` / `clientRev`），所以这里要查一次：
   * 忘了查的后果是 client 面被当成服务端面去取 blocks，永远停在
   * 「插件没注册这个界面」——而插件作者明明写了。
   */
  const surfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)

  // 老插件的 sider 面也开成标签页（入口统一到「插件」列表），kind 得跟着标签走
  const kind = tool?.surfaceKind ?? 'view'

  // 登记表里没有它 = 标签与数据不同步（理论上不该发生，见 PanelView 里的同款兜底）
  if (!tool?.pluginId || !tool.surfaceId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('这个标签的数据已失效，关闭后重新打开即可。')}
      </div>
    )
  }

  const surface = surfaces.find(
    (item) => item.pluginId === tool.pluginId && item.kind === kind && item.id === tool.surfaceId
  )

  return (
    <PluginSurfaceBody
      app={app}
      pluginId={tool.pluginId}
      kind={kind}
      id={tool.surfaceId}
      {...(surface?.renderMode ? { renderMode: surface.renderMode } : {})}
      {...(surface?.clientRev ? { clientRev: surface.clientRev } : {})}
      // 参数：同一个面可以用它开出多屏（一个连接一页）
      {...(tool.params ? { params: tool.params } : {})}
      className="h-full"
    />
  )
}
