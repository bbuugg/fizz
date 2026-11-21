/**
 * 工具卡 / 过程分组的头部图标：**工具名优先、ACP 类别兜底、最后扳手**。
 *
 * ## 防的是什么
 *
 * 外部 Agent（ACP）常常不报工具名：`acp.ts` 在拿不到 `name` 时落成占位名 `"tool"`，
 * 真正的信息只在 `kind` 里（read / edit / execute …）。文案早就按它兜底了
 * （`parts.ts` 的 `toolCardTitle`：「tool + read」→「读取」），图标却只看工具名，
 * 于是出现「文字写着『读取』、图标是扳手」。收起的过程分组调的是同一个函数，所以
 * 不只是展开后的卡片，组抬头那一排也全成了扳手。
 *
 * 这里钉住三档顺序：名字命中就用名字的、名字认不出才看类别、都没有才扳手 ——
 * 以及**顺序不能倒**（类别是粗粒度，倒过来会把 `bash` 这类有专门字形的工具压成一类一个图标）。
 */
import { describe, expect, it } from 'vitest'
import { FilePenIcon, FileTextIcon, SquareTerminalIcon, WrenchIcon } from 'lucide-react'
import { toolHeadIcon } from './tool'

describe('toolHeadIcon · ACP 类别兜底', () => {
  it('占位名 "tool" + acpKind：按类别取图标', () => {
    expect(toolHeadIcon('tool', 'read')).toBe(FileTextIcon)
    expect(toolHeadIcon('tool', 'edit')).toBe(FilePenIcon)
    expect(toolHeadIcon('tool', 'execute')).toBe(SquareTerminalIcon)
  })

  it('工具名命中时优先于类别（别把 bash 之类的专门字形压成类别图标）', () => {
    expect(toolHeadIcon('bash', 'read')).not.toBe(FileTextIcon)
    expect(toolHeadIcon('read', 'execute')).toBe(FileTextIcon)
  })

  it('名字和类别都认不出才退回扳手', () => {
    expect(toolHeadIcon('tool')).toBe(WrenchIcon)
    expect(toolHeadIcon('tool', 'some-unknown-kind')).toBe(WrenchIcon)
  })
})
