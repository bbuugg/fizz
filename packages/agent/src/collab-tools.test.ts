/**
 * 子 Agent 工具白名单的回归守卫。
 *
 * 防的是这一类回归：`skill` 被白名单挡掉。技能清单是系统提示词里固定的一段
 * （`buildAgentSetup` 按 `opts.skills` 自动拼），提示词还要求模型「相关时先
 * skill 再动手」——工具一旦没了，子 Agent 只会回「我无法读取技能」，
 * 而主智能体还以为它读过。
 */
import { describe, expect, it } from 'vitest'
import { pickCollabTools } from './collab-tools'

const noop = (): void => {}

describe('pickCollabTools', () => {
  it('只保留白名单里的工具', () => {
    const picked = pickCollabTools({ read: noop, write: noop }, ['read'])
    expect(Object.keys(picked)).toEqual(['read'])
  })

  it('skill 不在白名单里也保留', () => {
    const picked = pickCollabTools({ read: noop, skill: noop }, ['read'])
    expect(Object.keys(picked).sort()).toEqual(['read', 'skill'])
  })

  it('白名单里列了、工具集里没有的键不会凭空出现', () => {
    const picked = pickCollabTools({ read: noop }, ['read', 'skill'])
    expect(Object.keys(picked)).toEqual(['read'])
  })

  it('没有技能可读时不留空壳', () => {
    expect(Object.keys(pickCollabTools({ read: noop }, []))).toEqual([])
  })
})
