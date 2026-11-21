/** 防止不完整 usage 把圆环压到输出 token 数，以及新轮首步估算覆盖仍适用的真值。 */
import { describe, expect, it } from 'vitest'
import { contextMessagesDigest, measuredContextTokens, reuseContextMeasurement } from './context'
import type { ModelMessage } from 'ai'

describe('上下文测量有效性', () => {
  it('拒绝缺输入、缺输出、全零和负数，但兼容旧字段名', () => {
    for (const usage of [{ outputTokens: 100 }, {}, { inputTokens: 0, outputTokens: 0 },
      { inputTokens: -1, outputTokens: 3 }, { inputTokens: 100 }]) {
      expect(measuredContextTokens(usage)).toBeUndefined()
    }
    expect(measuredContextTokens({ promptTokens: 1000, completionTokens: 50 })).toBe(1050)
    expect(measuredContextTokens({ inputTokens: 1000, outputTokens: 50, totalTokens: 1 })).toBe(1050)
  })

  it('新轮只增加尾部估算，环境或前缀改变后不沿用旧测量', () => {
    const prefix: ModelMessage[] = [{ role: 'user', content: '任务' }, { role: 'assistant', content: '完成' }]
    const next: ModelMessage[] = [...prefix, { role: 'user', content: '继续' }]
    const measurement = { environment: 'env', messages: contextMessagesDigest(prefix), usedTokens: 50000 }
    expect(reuseContextMeasurement(next, 'env', measurement)).toBe(50002)
    expect(reuseContextMeasurement(next, 'other', measurement)).toBeUndefined()
    expect(reuseContextMeasurement([{ role: 'user', content: '压缩摘要' }], 'env', measurement)).toBeUndefined()
  })
})
