/**
 * 设置的**分组清单**：三端共用的一份（桌面两栏 / 手机两级 / web 弹窗的菜单都由它建）。
 *
 * 这里只管「有哪些设置、叫什么、什么图标、归哪一组、**在哪台宿主上出现**」——**不掺导航形态**：
 * 菜单怎么摆、点一下怎么换页、返回键画在哪，是各外壳自己的组件
 * （`SettingsShell` 按形态挑 `DesktopSettingsPanel` / `MobileSettingsPanel`）。以前这些和
 * `useIsMobile()` 一起挤在一个 `SettingsPanel` 里，两边的形态都得为对方让路，谁也不好调。
 *
 * ## 三端功能差异靠 `platforms` 声明，别在壳里写 `if (isMobile)`
 *
 * 每一项可以选择只出现在某些宿主上（不写 = 三端都有）。过滤在 `buildSettingsGroups` 里
 * 一次做完，两个壳拿到的都只是「这台宿主该有的项」—— 于是「手机版不显示 X」是一行声明，
 * 不是散在三个宿主里的三处条件。
 *
 * 当前唯一的差异项是**快捷键**：手机版只有软键盘 + 偶尔的外接键盘，没有键位可配，
 * 列出来只会让人点进去发现「这里跟我没关系」。
 *
 * 新增一个设置项：这里登记一行 + `SettingsContent` 里加一个分支。
 */
import {
  Archive,
  Bot,
  Box,
  Cpu,
  Gauge,
  Globe,
  Keyboard,
  Palette,
  Plug,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { SettingsPlatform, SettingsTabId } from '@fizz/agent-kit/features/settings/types'
import { t } from '@fizz/i18n'

export interface SettingsSection {
  id: SettingsTabId
  label: string
  icon: LucideIcon
  /**
   * 这一项在**哪些宿主**上出现。不写 = 三端都有；写了就是白名单。
   * @see SettingsPlatform
   */
  platforms?: SettingsPlatform[]
}

export interface SettingsGroup {
  title: string
  items: SettingsSection[]
}

/**
 * 这台宿主上的分组菜单。
 *
 * 过滤只做一层：白名单不匹配的项从组里摘掉，**整组摘空时连分组标题一起收走**
 * （否则菜单里会剩一个孤零零的标题）。两个壳都只认这个结果，别在壳里再筛一遍。
 */
export function buildSettingsGroups(app: AgentApp, platform: SettingsPlatform): SettingsGroup[] {
  return allSettingsGroups(app)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.platforms || item.platforms.includes(platform))
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * 「打开设置时落在哪一项」的兜底：指定的这一项在当前宿主上**不存在**时（例如手机版被
 * 传了 `shortcuts`）退回菜单第一项，而不是渲染一个菜单里没有、内容区空白的页面。
 */
export function resolveInitialTab(groups: MenuLike, want?: string): string {
  const ids = groups.flatMap((group) => group.items.map((item) => item.id))
  return want && ids.includes(want) ? want : (ids[0] ?? 'general')
}

/**
 * 这一项在菜单里吗。
 *
 * 入参只要求「有 items、每项有 id」—— 内置分组（`SettingsGroup`）与手机壳合并宿主扩展项
 * 之后的导航分组（`SettingsNavGroup`）都能直接传。两个壳判断「带分组进来时要不要直接
 * 落到二级页」用的是同一个口径，别各写一份 `some(...)`。
 */
export function hasSettingsTab(groups: MenuLike, id: string): boolean {
  return groups.some((group) => group.items.some((item) => item.id === id))
}

/** 上面两个函数的入参形状（只关心 id，不关心 label / icon） */
type MenuLike = readonly { items: readonly { id: string }[] }[]

/**
 * 分组菜单：按「用户想干什么」分组，不按内部模块。AI 相关的一切
 * （模型 / ACP / MCP / 技能 / 插件 / 容器 / 用量 / 历史会话）都在同一个「AI」组里 ——
 * 别再按模块把它们拆回多组。
 * 数字类后缀（模型 / MCP / 技能 / 归档）现算 —— 菜单每次渲染都重建，不需要缓存。
 */
function allSettingsGroups(app: AgentApp): SettingsGroup[] {
  return [
    {
      title: t('基础'),
      items: [
        { id: 'general', label: t('通用'), icon: SlidersHorizontal },
        // 外观（配色主题 / 明暗 / 强调色）是**内置**分组，不再由各宿主自己拼：
        // 手机版原来把它塞在 extraGroups 里、web / desktop 藏在左下角菜单，同一个功能两套入口。
        { id: 'appearance', label: t('外观'), icon: Palette },
        // 快捷键：**手机版没有**（只有软键盘，键位无从谈起，见文件头）。桌面 / web 保留。
        {
          id: 'shortcuts',
          label: t('快捷键'),
          icon: Keyboard,
          platforms: ['desktop', 'web']
        }
      ]
    },
    {
      // 「SSH 主机」不在这里：它已经升格成活动栏里的「主机」功能区（清单在侧栏、
      // 表单在 features/hosts/HostDialog），设置页只管本机终端偏好。
      title: t('终端'),
      items: [{ id: 'terminal', label: t('偏好'), icon: SquareTerminal }]
    },
    {
      // 「AI」一组：模型 / ACP agent / 能力（MCP、技能、插件）/ 运行环境（容器）/ 用量 /
      // 历史会话都归这里 —— 原先拆成「模型」「能力」「运行环境」「统计」「会话」五组，
      // 用户想找「我接的是什么、它能干什么、跑在哪、花了多少、聊过什么」得翻五个标题；
      // 它们本来就是同一件事的几个侧面。
      // 组内按「连什么 → 能干什么 → 跑在哪 → 用了多少 → 产出在哪」排；容器排在能力之后
      // （它是执行环境，不是能力本身，但同属 AI 这条链路）。
      title: t('AI'),
      items: [
        // 「通用」= 原来挤在通用里、只作用于 AI 的那几条（工具权限 / 并发 / 意图 / 子任务 /
        // 审批超时 / 重试），见 `AiPreferencesTab`。放第一项：它是「这套 AI 怎么
        // 干活」的总开关，先定行为再看接什么模型。
        // 叫「通用」而不是「偏好」：这一页装的是 AI 的**默认行为**（权限档、并发、步数、
        // 意图），不是用户口味；「偏好」那种叫法会让人以为里面是主题 / 字号之类的个人口味。
        { id: 'ai-prefs', label: t('通用'), icon: SlidersHorizontal },
        { id: 'models', label: t('模型 ({count})', { count: app.models.length }), icon: Cpu },
        { id: 'acp', label: t('Agents ({count})', { count: app.acpAgents.length }), icon: Bot },
        { id: 'mcp', label: t('MCP ({count})', { count: app.mcpServers.length }), icon: Plug },
        // 内置浏览器（Playwright headless shell）的检测 / 安装 / 卸载。跟着 MCP 排：
        // 两者回答的是同一类问题「这台机器上有什么能替我操作网页」，而且这里是
        // playwright MCP 那条替代路线的说明所在。
        // 也不带「装没装」的角标：那会让菜单宽度随安装状态跳（用户报过数字变化导致重排）。
        { id: 'browser', label: t('浏览器'), icon: Globe },
        { id: 'skills', label: t('技能 ({count})', { count: app.skills?.skills.length ?? 0 }), icon: Sparkles },
        // 叫「插件」而不是「插件」：设置页只管用户级（`~/.fizz/plugins`）那一份，
        // 项目自己的插件在侧栏那个项目的「更多 → 插件」里管。名字里写清楚，省得用户
        // 进来发现「我项目里的插件怎么不在」。也不带计数 —— 清单是现拉的，菜单渲染时
        // 手里没有这个数，硬塞一个只会误导。
        { id: 'plugins', label: t('插件'), icon: Puzzle },
        // 容器型项目的运行环境（镜像）：管的是执行环境本身（docker / 镜像构建）。
        // 导航上叫「运行环境」而不是「容器」：将来还会有别的运行形态，且「容器」在用户眼里
        // 更像一个具体技术名词，不如「运行环境」直白（tab id 仍是 `container`，别跟着改）
        { id: 'container', label: t('运行环境'), icon: Box },
        // 用量虽跨对话与流程，但它回答的就是「这套 AI 花了我多少」，跟在能力后面最自然
        { id: 'usage', label: t('用量'), icon: Gauge },
        // 「历史会话」（归档）原先占着 AI Agent 侧栏的一整组，后来单独成「会话」组，现在并进
        // AI 组：会话就是这套 AI 的产出，清理 / 找回都在这条链路上。放最后（存量数据，日常不常来）。
        // ⚠️ **不带条数**：这个数字随归档 / 删除实时变，导航项宽度一变整列菜单就重排
        // （用户报的「数字变化导致内容闪烁」）。要看条数去「历史会话」页里各分组的组头。
        { id: 'history', label: t('历史会话'), icon: Archive }
      ]
    }
  ]
}
