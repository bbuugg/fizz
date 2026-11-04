/**
 * 设置外壳：三个宿主唯一的入口组件。
 *
 * ## 它替宿主决定什么
 *
 * 1. **这台宿主该看到哪些设置项** —— 交给 `buildSettingsGroups(app, platform)` 过滤
 *    （哪一项在哪些宿主上出现，写在 `sections.ts` 的 `platforms` 上，不写在宿主里）；
 * 2. **用哪种导航形态** —— `two-column`（菜单常驻 + 内容）还是 `two-level`（菜单 / 详情）；
 * 3. **各形态专属的那些 props 归谁** —— `extraGroups` / `animate` / `onDetailChange` 只有
 *    两级形态用得上，两栏形态压根不接收（省得宿主对着一个用不到的参数猜）。
 *
 * 宿主自己只管**外面那层壳**。web / desktop 只有一处：主区域的**设置标签**
 * （`features/settings/SettingsTabContent`）；`apps/mobile` 是另一套应用，用整页。
 *
 * | 宿主 | platform | form |
 * |---|---|---|
 * | `apps/mobile/src/app/SettingsPage` | `mobile` | `two-level`（恒，平板横屏也是） |
 * | `features/settings/SettingsTabContent` | 宿主 `platform` | 窄屏 `two-level` / 宽屏 `two-column` |
 *
 * ## 为什么 form 由宿主传、而不是这里用 `useIsMobile()` 自己算
 *
 * 因为「多宽算窄」不是所有宿主同一件事：`apps/mobile` **恒**是两级（它连宽屏也用这套，
 * 只是不播转场）。塞一个 `useIsMobile()` 进来，等于把 mobile 宿主的形态也交给视口决定
 * —— 平板横屏上会突然变成两栏。
 *
 * 标签宿主那边只有一个判断入口（`SettingsTabContent` 调 `settingsNavForm()`）。
 */
import type {
  SettingsCommonProps,
  SettingsExtraGroup,
  SettingsNavForm,
  SettingsPlatform,
  SettingsTabId
} from '@fizz/agent-kit/features/settings/types'
import type { MobileSettingsDetail } from '@fizz/agent-kit/features/settings/MobileSettingsPanel'
import { DesktopSettingsPanel } from '@fizz/agent-kit/features/settings/DesktopSettingsPanel'
import { MobileSettingsPanel } from '@fizz/agent-kit/features/settings/MobileSettingsPanel'

/**
 * 二级页的标题 / 返回动作。宿主（整页设置）接管顶部标题栏时上报它 ——
 * 类型本体在 `MobileSettingsPanel`，这里转出去是为了让宿主**不必**直接引面板。
 */
export type SettingsShellDetail = MobileSettingsDetail

/**
 * 「这台宿主 + 这个宽度」该用哪种导航形态。
 *
 * 只有 web 会因为视口改变形态；手机 / 桌面各自写死自己的那一种（理由见文件头）。
 */
export function settingsNavForm(platform: SettingsPlatform, narrow: boolean): SettingsNavForm {
  if (platform === 'mobile') return 'two-level'
  if (platform === 'desktop') return 'two-column'
  return narrow ? 'two-level' : 'two-column'
}

export function SettingsShell({
  platform,
  form,
  className,
  initialTab,
  extraGroups,
  animate,
  onDetailChange,
  ...common
}: SettingsCommonProps & {
  /** 这台宿主是谁 —— 决定菜单里有哪几项（`sections.ts` 的 `platforms` 白名单） */
  platform: SettingsPlatform
  /** 导航形态（用 `settingsNavForm()` 算，别手写常量） */
  form: SettingsNavForm
  /** 外层尺寸：两栏形态要定高（`h-[60dvh]` / `h-full`），两级形态吃父级剩高 */
  className?: string
  /** 打开时落在哪一项；在当前宿主上不存在时会自动退回第一项（`resolveInitialTab`） */
  initialTab?: SettingsTabId
  /** 宿主扩展入口（手机版的「数据 / 退出」）；只有两级形态接收 */
  extraGroups?: SettingsExtraGroup[]
  /** 两级形态要不要播横滑转场（手机版宽屏时关掉）；只有两级形态接收 */
  animate?: boolean
  /** 两级形态的标题 / 返回键交给宿主时上报（手机版整页设置用它改标题栏）；只有两级形态接收 */
  onDetailChange?: (detail: MobileSettingsDetail | null) => void
}) {
  if (form === 'two-level') {
    return (
      <MobileSettingsPanel
        platform={platform}
        className={className}
        initialTab={initialTab}
        extraGroups={extraGroups}
        animate={animate}
        onDetailChange={onDetailChange}
        {...common}
      />
    )
  }

  /*
    两栏形态：`extraGroups` / `animate` / `onDetailChange` 到这里就是**没有意义**的
    （桌面没有宿主扩展项，也没有「二级页」可以退），所以不往下传 —— 传了 `DesktopSettingsPanel`
    也不接收，等于多一条没人读的参数。
  */
  return <DesktopSettingsPanel platform={platform} className={className} initialTab={initialTab} {...common} />
}
