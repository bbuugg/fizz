/**
 * 设置模块的**共享形状**：分组 / 导航项 / 宿主扩展项 / 各壳的公共入参 / 平台与形态枚举。
 *
 * 这里只放数据形状，不放导航形态 —— 三端都从 `SettingsShell` 进，由它按 `platform`
 * 过滤菜单、按 `form` 挑 `DesktopSettingsPanel`（两栏）/ `MobileSettingsPanel`（两级）。
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'

/** 内置设置项（内容在 `SettingsContent` 里按 id 渲染） */
export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'terminal'
  | 'history'
  | 'container'
  | 'ai-prefs'
  | 'models'
  | 'acp'
  | 'mcp'
  | 'browser'
  | 'skills'
  | 'plugins'
  | 'usage'

/**
 * 设置页跑在哪种宿主上。
 *
 * **只决定菜单里有哪几项**（见 `sections.ts` 每行的 `platforms`），不决定导航形态
 * —— 形态是 `SettingsNavForm`，两者正交（手机壳在平板横屏上仍是「菜单 + 详情」两级）。
 *
 * - `desktop`：桌面端（主界面里的设置弹窗、`?window=settings` 独立窗口）；
 * - `web`：浏览器里的 web 版；
 * - `mobile`：手机版整页设置。
 *
 * ⚠️ 别拿它当「窗口宽不宽」用：窄屏 web 仍是 `web`（判据与 `useIsMobile` 无关）。
 */
export type SettingsPlatform = 'desktop' | 'web' | 'mobile'

/**
 * 设置外壳的两种导航形态：
 * - `two-column`：左侧分组菜单常驻 + 右侧内容（`DesktopSettingsPanel`）；
 * - `two-level`：菜单 / 详情两级（`MobileSettingsPanel`）。
 *
 * 选哪个由宿主决定（见 `SettingsShell` 的 `settingsNavForm`），两个面板内部都不写断点。
 */
export type SettingsNavForm = 'two-column' | 'two-level'

/**
 * 导航项：内置项与宿主扩展项合并后的形状。
 * `id` 是 string（扩展分组的 id 由宿主任意定，不进 `SettingsTabId` 联合）。
 */
export interface SettingsNavItem {
  id: string
  label: string
  icon: LucideIcon
  /** 点一下就地执行，不切内容页（如手机版底部的「退出」） */
  action?: () => void
  /** 危险动作（如「退出」）用红色，别和普通设置项混在一起 */
  tone?: 'destructive'
}

export interface SettingsNavGroup {
  /** 不传 = 不画分组标题（单项的宿主入口，如手机版底部的「退出」） */
  title?: string
  items: SettingsNavItem[]
}

/**
 * 宿主扩展项：手机版用它把「数据 / 退出」这类**宿主级入口**收进设置导航
 * （入口在设置里的都该长这样，别在旁边另起炉灶）。
 *
 * `content` 与 `action` 二选一：
 * - `content` = 进内容页（设置项）；
 * - `action` = 点一下就地执行，不切页（「退出」这种一次性动作不该多一层）。
 */
export interface SettingsExtraItem {
  id: string
  label: string
  icon: LucideIcon
  /** 点这一项直接执行（不切内容页）；给了它就不需要 `content` */
  action?: () => void
  /** 选中时的内容（`action` 项不需要）；样式要跟其它 Tab 同款（`space-y-6` 根 + `space-y-2` 分节） */
  content?: ReactNode
  tone?: 'destructive'
}

export interface SettingsExtraGroup {
  title?: string
  items: SettingsExtraItem[]
}

/** 各壳都需要的入参：设置数据 + 快捷键读写（快捷键由宿主持有与分发） */
export interface SettingsCommonProps {
  app: AgentApp
  shortcuts: AgentShortcutConfig[]
  onSaveShortcuts: (shortcuts: AgentShortcutConfig[]) => void
  onShortcutRecordingChange: (recording: boolean) => void
}

/**
 * 选中分组的受控入参。
 *
 * 设置**标签**把选中值提在标签层（`SettingsTabContent`）：两栏 / 两级是两个组件，
 * `form` 一变就整块重挂（把标签拖窄 / 拖宽、切走再切回都会换），状态留在面板里会被
 * 初始化回「通用」。手机整页设置不传这两项，面板自己管。
 */
export interface SettingsSelectionProps {
  /** 受控的选中分组（扩展分组的 id 由宿主任意定，所以是 string） */
  tab?: string
  onTabChange?: (tab: string) => void
}
