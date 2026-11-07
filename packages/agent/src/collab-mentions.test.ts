/**
 * 点名解析的回归守卫。
 *
 * 防的是：`@调研员` 在同时存在「调研」「调研员」时把两个 Agent 都叫起来；
 * 以及英文名 `@Bob` 误命中 `@Bobby`。
 */
import { describe, expect, it } from 'vitest'
import { createCollabAgent } from '@fizz/contracts/types'
import { resolveCollabMentions } from './collab-mentions'

const a = createCollabAgent({ name: '调研' })
const b = createCollabAgent({ name: '调研员' })
const c = createCollabAgent({ name: 'Bob' })
const d = createCollabAgent({ name: 'Bobby' })

describe('resolveCollabMentions', () => {
  it('没有 @ 时返回空数组（调用方据此走广播）', () => {
    expect(resolveCollabMentions('看看这个改动', [a, b])).toEqual([])
  })

  it('点名一个 Agent', () => {
    expect(resolveCollabMentions('@调研员 看下这个', [a, b]).map((x) => x.id)).toEqual([b.id])
  })

  it('最长名字优先，不会因前缀命中两个', () => {
    expect(resolveCollabMentions('@调研员 看下这个', [a, b]).map((x) => x.id)).toEqual([b.id])
  })

  it('点名多个 Agent', () => {
    const ids = resolveCollabMentions('@调研员 @Bob 一起看', [a, b, c]).map((x) => x.id)
    expect(ids.sort()).toEqual([b.id, c.id].sort())
  })

  it('英文名不吞掉更长的英文名字', () => {
    expect(resolveCollabMentions('@Bobby 看下', [c, d]).map((x) => x.id)).toEqual([d.id])
  })

  it('中文名后面直接接正文也算点名', () => {
    expect(resolveCollabMentions('@调研员看下这个', [a, b]).map((x) => x.id)).toEqual([b.id])
  })
})
