/** 防回归：旧 ACP 自动记住策略必须从磁盘迁移清除，保留预设、旧类型与其他启动配置。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './store'
import { AgentDomain } from './domain'

let dir: string
let store: JsonStore | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fizz-acp-migration-')); store = undefined })
afterEach(async () => { await store?.flush(); await rm(dir, { recursive: true, force: true }) })

describe('ACP 配置兼容', () => {
  it('旧客户端传来的 allowStrategy 不能重新落盘；编辑仍保留旧 pi 类型', async () => {
    store = await JsonStore.open(dir)
    const domain = new AgentDomain(store)
    const legacyInput = { name: 'Pi', command: 'wrapper', type: 'pi' as const, allowStrategy: 'always' }
    const created = domain.saveAcpAgent(legacyInput)
    expect(created).not.toHaveProperty('allowStrategy')
    const updated = domain.saveAcpAgent({ id: created.id, name: 'Pi renamed', command: 'wrapper' })
    expect(updated.type).toBe('pi')
    expect(updated).not.toHaveProperty('allowStrategy')
    await store.flush()
    store = await JsonStore.open(dir)
    expect(store.snapshot().acpAgents[0]).not.toHaveProperty('allowStrategy')
  })
})
