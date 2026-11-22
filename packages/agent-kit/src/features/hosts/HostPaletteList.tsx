/**
 * 命令面板「主机」视图的列表：**按分组分段**（规则见 `host-palette-sections.ts`）。
 *
 * 抽成共享件的理由与 `ScriptPaletteList` 相同：两份命令面板（web / desktop 与手机外壳）
 * 的条目观感必须一致；另外「主机页」和「连接远端服务器 → SSH 主机页」也是同一批数据，
 * 分组规则只该有一份。
 *
 * 过滤仍交给 cmdk：每条的 `value` 带上分组标题，键入组名能把整组筛出来；组内一条都不
 * 匹配时 cmdk 会把整个 `CommandGroup`（连标题）标成 hidden，不会留下空标题。
 * 招牌式 / 副标题 / 关键词统一由 `hostPaletteFields` 给（含缺字段记录的兜底）。
 */
import { Cloud, SquareTerminal } from 'lucide-react'
import { CommandGroup, CommandItem } from '@fizz/ui/command'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { hostPaletteFields } from '@fizz/agent-kit/features/hosts/host-format'
import {
  hostPaletteSections,
  UNGROUPED_HOST_SECTION_ID,
  type HostPaletteSection
} from '@fizz/agent-kit/features/hosts/host-palette-sections'
import type { HostConfig, HostGroup } from '@fizz/contracts/types'

interface HostPaletteListProps {
  hosts: HostConfig[]
  groups: HostGroup[]
  onSelect: (host: HostConfig) => void
}

export function HostPaletteList({ hosts, groups, onSelect }: HostPaletteListProps) {
  const t = useT()
  const sections = hostPaletteSections(hosts, groups, t('未分组'))
  /**
   * 只有一段且那一段就是「未分组」时**不写标题**：那是「还没建过分组」的常态，
   * 顶上挂一句「未分组」纯属噪声（与 `ScriptPaletteList` 同一判断）。
   */
  const headingOf = (section: HostPaletteSection): string | undefined =>
    sections.length === 1 && section.id === UNGROUPED_HOST_SECTION_ID
      ? undefined
      : section.heading

  return (
    <>
      {sections.map((section) => (
        <CommandGroup key={section.id} heading={headingOf(section)}>
          {section.items.map((host) => {
            const { label, subtitle, keywords } = hostPaletteFields(host)
            return (
              <CommandItem
                key={host.id}
                // value 参与 cmdk 的本地过滤：能搜的字段 + 分组名都拼进来
                value={`${label} ${subtitle} ${section.heading}`}
                keywords={keywords}
                onSelect={() => onSelect(host)}
              >
                {host.kind === 'local' ? <SquareTerminal /> : <Cloud />}
                <span className="truncate">{label}</span>
                <span className="ml-auto max-w-40 truncate font-mono text-xs text-muted-foreground">
                  {subtitle}
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      ))}
    </>
  )
}
