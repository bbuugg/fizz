/**
 * 子任务偏好归一化：步数上限是**用户手填**的，必须当成不可信输入。
 *
 * 防的是三件事：手改坏的数据文件让读接口抛错；越界值被悄悄夹到边界，用户看不出
 * 「我填的 500 变成了 128」；未知 id 混进 maxSteps 让设置页渲染出一个不存在的子任务。
 *
 * `models`（每个子智能体自己的模型）还有一条自己的规矩：只有 `modelConfigId` + `modelId`
 * **成对**才生效 —— 只有一半时拼不出一个能用的模型，猜一半等于替用户换网关。
 */
import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_MAX_STEPS,
  SUBAGENT_MIN_STEPS,
  normalizeSubagentSettings
} from './types'

describe('normalizeSubagentSettings · 步数上限', () => {
  it('范围内的整数原样保留（按 id 分开）', () => {
    const settings = normalizeSubagentSettings({ maxSteps: { explorer: 30, reviewer: 12 } })

    expect(settings.maxSteps).toEqual({ explorer: 30, reviewer: 12 })
  })

  it('越界值整条丢弃（回到默认），不夹到边界', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: { explorer: SUBAGENT_MAX_STEPS + 1, reviewer: SUBAGENT_MIN_STEPS - 1 }
    })

    expect(settings.maxSteps).toBeUndefined()
  })

  it('边界值本身是合法的', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: { explorer: SUBAGENT_MAX_STEPS, reviewer: SUBAGENT_MIN_STEPS }
    })

    expect(settings.maxSteps).toEqual({
      explorer: SUBAGENT_MAX_STEPS,
      reviewer: SUBAGENT_MIN_STEPS
    })
  })

  it('非数字 / NaN / 未知 id 一律丢掉', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: {
        explorer: '20',
        reviewer: Number.NaN,
        // 手改坏的数据文件里什么都可能有；参数是 unknown，所以这里能塞得进去
        coder: 20
      }
    })

    expect(settings.maxSteps).toBeUndefined()
  })

  it('小数截断成整数；全被丢掉时不留下空对象', () => {
    expect(normalizeSubagentSettings({ maxSteps: { explorer: 12.9 } }).maxSteps).toEqual({
      explorer: 12
    })
    expect(normalizeSubagentSettings({ maxSteps: {} }).maxSteps).toBeUndefined()
  })

  it('没设步数时结果里不出现这个字段（老数据不受影响）', () => {
    expect('maxSteps' in normalizeSubagentSettings({ enabled: ['explorer'] })).toBe(false)
  })
})

describe('normalizeSubagentSettings · 每个子智能体自己的模型', () => {
  const ref = { modelConfigId: 'cfg-1', modelId: 'fast' }

  it('成对的合法引用原样保留（内置也能配）', () => {
    const settings = normalizeSubagentSettings({ models: { image_reader: ref, explorer: ref } })

    expect(settings.models).toEqual({ image_reader: ref, explorer: ref })
  })

  it('只有一半 / 空串一律丢掉（服务端不猜，让它退回兜底模型）', () => {
    const settings = normalizeSubagentSettings({
      models: {
        image_reader: { modelConfigId: 'cfg-1' },
        explorer: { modelConfigId: '', modelId: 'fast' },
        reviewer: { modelConfigId: 'cfg-1', modelId: '  ' }
      }
    })

    expect(settings.models).toBeUndefined()
  })

  it('未知 id / 非对象项丢掉；全丢掉时不留下空对象', () => {
    const bogus = normalizeSubagentSettings({
      models: { coder: ref, explorer: 'cfg::fast', image_reader: ref } as never
    })
    expect(bogus.models).toEqual({ image_reader: ref })

    expect(normalizeSubagentSettings({ models: {} }).models).toBeUndefined()
  })

  it('自定义 id 也认（定义那边的模型字段才是老路径）', () => {
    const settings = normalizeSubagentSettings({
      definitions: [
        { id: 'custom-ab12cd34', name: '核对', description: '核对文档', instructions: '', tools: ['read'] }
      ],
      models: { 'custom-ab12cd34': ref }
    })
    expect(settings.models).toEqual({ 'custom-ab12cd34': ref })
  })

  it('引用指向已删除的自定义子智能体时跟着丢掉', () => {
    const settings = normalizeSubagentSettings({ models: { 'custom-ab12cd34': ref } })
    expect(settings.models).toBeUndefined()
  })

  it('没配模型时结果里不出现这个字段（老数据不受影响）', () => {
    expect('models' in normalizeSubagentSettings({ enabled: ['explorer'] })).toBe(false)
  })
})

describe('normalizeSubagentSettings · 自定义子智能体', () => {
  const valid = {
    id: 'custom-ab12cd34',
    name: '文档核对',
    description: '核对文档与代码是否一致',
    instructions: '先读 README',
    tools: ['read', 'shell', 'grep', 'read']
  }

  it('保留合法定义，工具取交集并去重（越界的 write / shell 被丢掉）', () => {
    const settings = normalizeSubagentSettings({ definitions: [valid] })
    expect(settings.definitions).toHaveLength(1)
    expect(settings.definitions?.[0]).toMatchObject({
      id: 'custom-ab12cd34',
      name: '文档核对',
      instructions: '先读 README'
    })
    // 按白名单顺序输出：read 在 grep 前面
    expect(settings.definitions?.[0].tools).toEqual(['read', 'grep'])
  })

  it('id 不合法 / 撞内置 / 重复的一律丢掉', () => {
    const settings = normalizeSubagentSettings({
      definitions: [
        { ...valid, id: 'explorer' },
        { ...valid, id: 'bad id!' },
        valid,
        { ...valid }
      ]
    })
    expect(settings.definitions).toHaveLength(1)
  })

  it('缺名称 / 缺用途的定义丢掉；超长文本截断', () => {
    const settings = normalizeSubagentSettings({
      definitions: [
        { ...valid, id: 'custom-1', name: '' },
        { ...valid, id: 'custom-2', description: '' },
        { ...valid, id: 'custom-3', name: 'x'.repeat(200) }
      ]
    })
    expect(settings.definitions).toHaveLength(1)
    expect(settings.definitions?.[0].name.length).toBe(40)
  })

  it('enabled 认自定义 id，定义删掉后同一份数据里会自动摘掉', () => {
    const withDef = normalizeSubagentSettings({
      enabled: ['explorer', valid.id],
      definitions: [valid]
    })
    expect(withDef.enabled).toEqual(['explorer', 'custom-ab12cd34'])

    const withoutDef = normalizeSubagentSettings({ enabled: ['explorer', valid.id] })
    expect(withoutDef.enabled).toEqual(['explorer'])
  })

  it('一个工具都没选时给一份最小可用集', () => {
    const settings = normalizeSubagentSettings({
      definitions: [{ ...valid, tools: [] }]
    })
    expect(settings.definitions?.[0].tools).toEqual(['read', 'glob', 'grep'])
  })

  it('步数越界的定义保留但丢掉步数（回到默认）', () => {
    const settings = normalizeSubagentSettings({
      definitions: [{ ...valid, maxSteps: SUBAGENT_MAX_STEPS + 1 }]
    })
    expect(settings.definitions?.[0].maxSteps).toBeUndefined()
  })
})
