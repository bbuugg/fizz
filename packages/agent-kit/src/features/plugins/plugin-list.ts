/**
 * 「插件」侧栏的列表模型：界面清单（`PluginSurfaceView[]`）→ 一个插件一行。
 *
 * 抽成纯函数是**为了能测**：`点一行打开谁` 有四个分支（清单 `activityBar.opens` 指的面 /
 * 第一个 view / 第一个 sider / 什么都没有），写错了的表现是「点了没反应」或者「打开错的面」，
 * 在界面上很难一眼看出来。渲染在 `PluginsSidebar.tsx`，判定全在这里。
 */
import type { PluginSurfaceView } from '@fizz/contracts/agent-api'

/** 列表里的一行 = 一个插件 */
export interface PluginListEntry {
  pluginId: string
  /** 插件名（清单里的 `name`，服务端原样带回） */
  name: string
  /** 插件图标（`ctx.ui.icon` 或清单 `icon`）；没有就回退 Puzzle */
  icon?: string
  /** 插件说明（清单 `description`）；没写就不渲染第二行 */
  description?: string
  /** 插件版本（清单 `version` 原文） */
  version?: string
  /** 点这一行打开的面 */
  target: PluginSurfaceView
  /** 排序用：插件里最小的那个 `order`（没写 = Infinity，保持原序） */
  rank: number
}

/** `opens: 'view:xxx'` / `'sider:xxx'` → 同一插件下的那个面 */
function openedSurface(
  entry: PluginSurfaceView,
  surfaces: PluginSurfaceView[]
): PluginSurfaceView | undefined {
  const opens = entry.opens
  const kind = opens?.startsWith('view:')
    ? 'view'
    : opens?.startsWith('sider:')
      ? 'sider'
      : null
  if (!kind || !opens) return undefined
  const id = opens.slice(kind.length + 1)
  return surfaces.find((s) => s.pluginId === entry.pluginId && s.kind === kind && s.id === id)
}

/**
 * 同一种面里 `order` 最小的那个（没写 order 的排在最后）。
 *
 * 不能拿数组里第一个：清单顺序是服务端排的，纯函数别依赖调用方已经排好。
 */
function lowest(
  list: PluginSurfaceView[],
  kind: PluginSurfaceView['kind']
): PluginSurfaceView | undefined {
  return list
    .filter((s) => s.kind === kind)
    .reduce<PluginSurfaceView | undefined>((best, s) => {
      if (!best) return s
      return (s.order ?? Number.POSITIVE_INFINITY) < (best.order ?? Number.POSITIVE_INFINITY)
        ? s
        : best
    }, undefined)
}

/**
 * 界面清单 → 插件列表（一个插件一行）。
 *
 * 「点开谁」的顺序：老插件的 `activityBar.opens` 指的 → `order` 最小的 `view` 面 →
 * `order` 最小的 `sider` 面。只声明了 `activityBar` 而没有内容面的插件**不出现** ——
 * 点开一片空白比没有这个入口更糟。
 */
export function pluginListOf(surfaces: PluginSurfaceView[]): PluginListEntry[] {
  const groups = new Map<string, PluginSurfaceView[]>()
  for (const surface of surfaces) {
    const list = groups.get(surface.pluginId)
    if (list) list.push(surface)
    else groups.set(surface.pluginId, [surface])
  }

  const entries: PluginListEntry[] = []
  for (const [pluginId, list] of groups) {
    const anchor = list.find((s) => s.kind === 'activityBar')
    const target =
      (anchor ? openedSurface(anchor, list) : undefined) ??
      lowest(list, 'view') ??
      lowest(list, 'sider')
    if (!target) continue

    const rank = list.reduce(
      (min, s) => Math.min(min, s.order ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY
    )
    // 图标 / 说明 / 版本取「任一面上带的那份」：服务端在每个面上都塞了同一份，取第一个即可
    const icon = list.find((s) => s.pluginIcon)?.pluginIcon
    const description = list.find((s) => s.pluginDescription)?.pluginDescription
    const version = list.find((s) => s.pluginVersion)?.pluginVersion
    entries.push({
      pluginId,
      name: target.pluginName || pluginId,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      target,
      rank
    })
  }

  // 稳定排序：没写 order 的（rank = Infinity）保持服务端给的顺序
  return entries.sort((a, b) => a.rank - b.rank)
}
