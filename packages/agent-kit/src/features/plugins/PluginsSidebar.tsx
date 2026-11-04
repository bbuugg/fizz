"use client";

/**
 * 插件侧栏 = **插件列表**（活动栏那颗「插件」对应的内容）。
 *
 * 所有插件共用这一份侧栏：每行一个插件，点一行就在 `PanelView` 里开出它的标签页。
 * 插件**不占**图标栏、也没有自己的侧栏 —— 加一个插件不会改动 `activities.tsx`，
 * 用户也不必先记住「哪个图标是哪个插件」。
 *
 * 「点开谁」的判定在 `plugin-list.ts`（纯函数，有单测）；这里只管画和开标签。
 *
 * ## 行样式按 VS Code 的「扩展」列表来
 *
 * 一行 = **图标 / 名字 + 版本 / 说明**（左边一列图标，右边两行文字），而不是早先
 * 「16px 图标 + 一行插件名」：插件一多，光看名字根本分不清哪个是干什么的 ——
 * 说明就写在清单（`plugin.json` 的 `description`）里，服务端随面一起带下来
 * （`PluginSurfaceView.pluginDescription`），这里只负责显示。
 *
 * - 说明 `line-clamp-2`：写满两行就截断，行高不会因为作者写了一篇长文而失控；
 *   完整文案走 `title`，鼠标停一下能看全。
 * - 没写说明的插件**不留空占位**（只显示名字 + 版本），否则列表里全是空气行。
 * - 版本是 `text-[0.625rem]` 的灰色小字，跟名字**基线对齐**（`items-baseline`）：
 *   版本比名字短，居中对齐会让文字看起来高低不齐。
 *
 * props 故意声明得比 `ActivityPanelProps` **窄**：函数参数逆变，窄签名照样能挂到
 * `Activity.sidebar` 上（见 `shell/activities.tsx` 的说明）。
 */
import { useMemo } from 'react'
import { Puzzle } from 'lucide-react'
import { ActivitySidebar } from '@fizz/agent-kit/shared/components/activity-sidebar'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { openPluginTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { pluginListOf, type PluginListEntry } from '@fizz/agent-kit/features/plugins/plugin-list'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function PluginsSidebar({
  app,
  width,
  mobileOpen,
  onMobileOpenChange
}: {
  app: AgentApp
  width: number
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const surfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  const entries = useMemo(() => pluginListOf(surfaces), [surfaces])

  const open = (entry: PluginListEntry): void => {
    const { target } = entry
    openPluginTab({
      pluginId: target.pluginId,
      surfaceId: target.id,
      surfaceKind: target.kind === 'sider' ? 'sider' : 'view',
      label: target.title || entry.name,
      title: `${entry.name} · ${target.title}`
    })
    // 手机端：点完就收起抽屉，露出刚打开的标签页（桌面端 mobileOpen 恒为 false，不会命中）
    if (mobileOpen) onMobileOpenChange(false)
  }

  return (
    <ActivitySidebar width={width} mobileOpen={mobileOpen} onMobileOpenChange={onMobileOpenChange}>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-2 py-1.5">
        {entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t('还没有可用的插件。在「设置 → 插件」里启用后，它会出现在这里。')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {entries.map((entry) => (
              <li key={entry.pluginId}>
                <button
                  type="button"
                  onClick={() => open(entry)}
                  // 说明被截断时，悬停能看全（没说明就退回插件名）
                  title={entry.description ?? entry.name}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {/* 32px 图标位：图标与占位同尺寸，有图标 / 没图标的两行文字左边界才对得齐 */}
                  {entry.icon ? (
                    <img
                      src={entry.icon}
                      alt=""
                      aria-hidden
                      className="size-8 shrink-0 rounded-lg object-contain"
                    />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                      <Puzzle className="size-4 text-muted-foreground" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 pt-0.5">
                    <span className="flex items-baseline gap-1.5">
                      {/* 行内主标题用 text-foreground；灰色只有一档（不要叠半透明） */}
                      <span className="min-w-0 truncate text-xs font-medium text-foreground">
                        {entry.name}
                      </span>
                      {entry.version ? (
                        <span className="shrink-0 text-[0.625rem] tabular-nums text-muted-foreground">
                          v{entry.version}
                        </span>
                      ) : null}
                    </span>
                    {entry.description ? (
                      <span className="mt-0.5 line-clamp-2 block text-[0.6875rem] leading-snug text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ActivitySidebar>
  )
}
