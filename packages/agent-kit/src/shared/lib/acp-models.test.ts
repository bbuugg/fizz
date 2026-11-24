/**
 * 防回归：「加载一次就保存」的判据。
 *
 * 空数组与「没加载过」必须分开：如果按长度判断，探测结果为空（agent 不支持选模型）时
 * 每次打开模型选择器都会重新 spawn 一次外部 agent，用户看到的是「下拉一开就卡几秒」。
 */
import { describe, expect, it } from 'vitest'
import { needsAcpModelLoad } from './acp-models'

describe('needsAcpModelLoad', () => {
  it('字段缺失 = 从来没加载过', () => {
    expect(needsAcpModelLoad({})).toBe(true)
    expect(needsAcpModelLoad({ models: undefined })).toBe(true)
  })

  it('空数组 = 加载过（这个 agent 没有可选模型），不再探', () => {
    expect(needsAcpModelLoad({ models: [] })).toBe(false)
  })

  it('已有清单 = 用缓存，除非用户点刷新', () => {
    expect(needsAcpModelLoad({ models: [{ value: 'x' }] })).toBe(false)
  })

  it('没有 agent 就没什么可加载的', () => {
    expect(needsAcpModelLoad(null)).toBe(false)
    expect(needsAcpModelLoad(undefined)).toBe(false)
  })
})
