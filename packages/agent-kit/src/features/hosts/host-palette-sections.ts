/**
 * 命令面板「主机」的分段规则（**纯函数、零 React**，单测直接跑它）。
 *
 * 主机功能本来就按多级分组树维护（见 `HostsSidebar`），命令面板以前把所有主机平铺在
 * 一个「主机」标题下 —— 分组信息整块丢失，主机一多就分不出哪台属于哪个环境。
 *
 * ## 与侧栏同一口径
 *
 * - 分组按 `hostGroups` 的 DFS 前序在前，**未分组恒最后**（侧栏就是这样排的）；
 * - `groupId` 指向已不存在分组的条目按未分组处理，否则那条主机会凭空消失；
 * - 空分组不出段：命令面板没有拖拽，空标题只是噪声。
 *
 * ## 多级标题
 *
 * 命令面板的小标题没有缩进，层级只能写进文字 —— 用 `父 / 子` 路径，父分组本身没有
 * 直属主机时也不会丢掉这层信息。
 */
import type { HostConfig, HostGroup } from '@fizz/contracts/types'
import { buildGroupTree, collectUngrouped, type GroupNode } from '@fizz/agent-kit/shared/lib/group-tree'

/** 未分组段的固定 id（不与真实分组 id 冲突，只做 React key） */
export const UNGROUPED_HOST_SECTION_ID = '__ungrouped_hosts__'

export interface HostPaletteSection {
  /** React key：未分组段是 {@link UNGROUPED_HOST_SECTION_ID}，其余是分组 id */
  id: string
  /** 段标题（分组是 `父 / 子` 路径；未分组段是调用方传进来的本地化文案） */
  heading: string
  items: HostConfig[]
}

/** 分组名路径；父链断了（父分组不存在 / 成环）就停在能解析到的那一层 */
function groupPath(groups: HostGroup[], id: string): string {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const names: string[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

export function hostPaletteSections(
  hosts: HostConfig[],
  groups: HostGroup[],
  ungroupedLabel: string
): HostPaletteSection[] {
  const sections: HostPaletteSection[] = []
  const walk = (node: GroupNode<HostGroup, HostConfig>): void => {
    if (node.items.length > 0) {
      sections.push({
        id: node.group.id,
        heading: groupPath(groups, node.group.id),
        items: node.items
      })
    }
    for (const child of node.children) walk(child)
  }
  for (const root of buildGroupTree(groups, hosts)) walk(root)

  const ungrouped = collectUngrouped(hosts, groups)
  if (ungrouped.length > 0) {
    sections.push({
      id: UNGROUPED_HOST_SECTION_ID,
      heading: ungroupedLabel,
      items: ungrouped
    })
  }
  return sections
}
