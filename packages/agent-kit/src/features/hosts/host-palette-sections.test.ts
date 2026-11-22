/**
 * 防的回归：命令面板「主机」必须按分组树分段（与侧栏同一口径）。
 *
 * 这条规则坏掉的两种典型症状：
 * 1. 退回「全部平铺一个标题」—— 分组信息整块丢失；
 * 2. 未分组位置 / 已删分组的兜底算错 —— 主机会从列表里凭空消失，或者在顶部多个空标题。
 */
import { describe, expect, it } from 'vitest'
import type { HostConfig, HostGroup } from '@fizz/contracts/types'
import {
  hostPaletteSections,
  UNGROUPED_HOST_SECTION_ID
} from './host-palette-sections'

function sshHost(id: string, groupId?: string): HostConfig {
  return {
    id,
    kind: 'ssh',
    name: id,
    host: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    createdAt: 1,
    updatedAt: 1,
    ...(groupId ? { groupId } : {})
  }
}

function group(id: string, name: string, parentId?: string): HostGroup {
  return { id, name, createdAt: 1, ...(parentId ? { parentId } : {}) }
}

describe('hostPaletteSections', () => {
  it('多级分组按 DFS 前序，标题带父路径，未分组恒最后', () => {
    const groups = [
      group('prod', '生产'),
      group('sh', '上海', 'prod'),
      group('test', '测试')
    ]
    const hosts = [sshHost('a', 'prod'), sshHost('b', 'sh'), sshHost('c', 'test'), sshHost('d')]

    const sections = hostPaletteSections(hosts, groups, '未分组')

    expect(sections.map((s) => [s.id, s.heading, s.items.map((h) => h.id)])).toEqual([
      ['prod', '生产', ['a']],
      ['sh', '生产 / 上海', ['b']],
      ['test', '测试', ['c']],
      [UNGROUPED_HOST_SECTION_ID, '未分组', ['d']]
    ])
  })

  it('空分组不出段：命令面板没有拖拽，空标题只是噪声', () => {
    const sections = hostPaletteSections([sshHost('a', 'g1')], [group('g1', '有'), group('g2', '空')], '未分组')

    expect(sections.map((s) => s.id)).toEqual(['g1'])
  })

  it('groupId 指向已不存在的分组：按未分组处理，不能丢主机', () => {
    const sections = hostPaletteSections([sshHost('a', 'gone')], [group('g1', '在')], '未分组')

    expect(sections).toEqual([
      { id: UNGROUPED_HOST_SECTION_ID, heading: '未分组', items: [sshHost('a', 'gone')] }
    ])
  })

  it('没有任何主机时返回空数组', () => {
    expect(hostPaletteSections([], [group('g1', '分组')], '未分组')).toEqual([])
  })
})
