/**
 * 桌面 / web 的**两栏**设置面板：左侧分组菜单常驻 + 右侧内容区，两栏同时在场。
 *
 * 只服务**容器够宽**的宿主（窗口宽不等于容器宽：设置标签可以单独拖窄）。窄容器与手机
 * 那套「菜单 / 详情两级」是另一个组件（`MobileSettingsPanel`）：
 * 两边不共用导航结构，也不靠 `useIsMobile()` 在一份代码里分叉 —— 这里每个类名、
 * 每个交互都只为两栏服务，改桌面不会牵动手机，反之同理。
 *
 * 内容本身仍是共享的 `SettingsContent`（只有一个 tab 的选中值要管）。
 *
 * ⚠️ 这个组件**不再由宿主直接用**：三端统一从 `SettingsShell` 进，由它按
 * `platform` / `form` 挑到这儿。`platform` 是必须的 —— 菜单里出现哪几项按宿主过滤
 * （手机版没有「快捷键」，见 `sections.ts`）。
 */
import { useState } from 'react'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type {
  SettingsCommonProps,
  SettingsPlatform,
  SettingsSelectionProps,
  SettingsTabId
} from '@fizz/agent-kit/features/settings/types'
import { buildSettingsGroups, resolveInitialTab } from '@fizz/agent-kit/features/settings/sections'
import { SettingsContent } from '@fizz/agent-kit/features/settings/SettingsContent'
import { SettingsFooter } from '@fizz/agent-kit/features/settings/SettingsFooter'

export function DesktopSettingsPanel({
  platform,
  className,
  initialTab,
  tab: tabProp,
  onTabChange,
  ...common
}: SettingsCommonProps &
  SettingsSelectionProps & {
    /** 这台宿主是谁（菜单按它过滤，见 `sections.ts`） */
    platform: SettingsPlatform
    /** 宽高由调用方给：标签页铺满整个主区域（`SettingsTabContent`） */
    className?: string
    /** 打开时落在哪个分组（模型选择下拉的设置入口用）；只在挂载时生效一次 */
    initialTab?: SettingsTabId
  }) {
  useLanguage()
  const groups = buildSettingsGroups(common.app, platform)
  // 受控时以宿主为准（设置标签把它提在标签层，见 `SettingsSelectionProps`）；不受控时
  // 自己管。两者都过一遍 `resolveInitialTab`：传进来的分组若在这台宿主上不存在
  // （例如手机版被传了 `shortcuts`），退回第一项，别渲染菜单里没有的空白页。
  const [ownTab, setOwnTab] = useState<string>(() => resolveInitialTab(groups, initialTab))
  const tab = resolveInitialTab(groups, tabProp ?? ownTab)
  const selectTab = (next: string): void => {
    if (tabProp === undefined) setOwnTab(next)
    onTabChange?.(next)
  }

  return (
    <div className={cn('flex min-h-0 flex-1 gap-2 pr-2', className)}>
      {/* 菜单列：**分组列表可滚，底部那行不动**（版本号 / 仓库常驻可见，别跟着滚走）。
          顶部与右侧内容卡片的 p-4 对齐；水平内边距也交给这一列，不再在根上叠一层。 */}
      <nav className="flex w-44 shrink-0 flex-col pl-2 pr-1 py-2">
        <div className="min-h-0 flex-1 space-y-4 overflow-auto no-scrollbar">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {group.title}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectTab(item.id)}
                  className={cn(
                    'mb-0.5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    tab === item.id
                      ? 'bg-primary-subtle text-foreground'
                      : 'text-muted-foreground hover:bg-primary-soft hover:text-foreground'
                  )}
                >
                  {/* 图标用 currentColor 描边，选中 / 悬停的颜色变化自动跟随按钮文字色 */}
                  <item.icon className="size-4 shrink-0 mr-1.5" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <SettingsFooter onOpenGeneral={() => selectTab('general')} />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col rounded-lg bg-background px-4 py-2">
        {/*
          `key={tab}`：**每个分组用自己那份滚动容器**（容器共用的话，在「通用」滚到底
          再切到「模型」，新分组会停在底部而不是顶部）。孩子本来就会随 tab 重挂。
        */}
        <div key={tab} className="min-h-0 flex-1 overflow-auto no-scrollbar">
          <SettingsContent tab={tab} {...common} />
        </div>
      </div>
    </div>
  )
}
