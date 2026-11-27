/** 防回归：旧 ACP 自动记住策略必须从磁盘迁移清除，保留预设、旧类型与其他启动配置。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './store'
import { AgentDomain } from './domain'

let dir: string
let store: JsonStore | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fizz-acp-migration-')); store = undefined })
afterEach(async () => { await store?.flush(); await rm(dir, { recursive: true, force: true }) })

describe('ACP 配置迁移', () => {
  it.each([1, 3])('v%i 清除旧放行策略并写回，重开后仍保留 pi 身份', async (version) => {
    const agent = { id: 'pi', name: 'Pi', command: 'wrapper', args: ['--acp'], type: 'pi', preset: 'pi',
      protocolVersion: 'v2', models: [{ value: 'model', name: 'Model' }] }
    await writeFile(join(dir, 'agent-core.json'), JSON.stringify({ version, acpAgents: [
      { ...agent, allowStrategy: 'always' },
      { id: 'plain', name: 'Plain', command: 'plain', args: [], allowStrategy: 'once' },
    ] }))
    store = await JsonStore.open(dir)
    expect(store.snapshot().acpAgents[0]).toEqual(agent)
    expect(store.snapshot().acpAgents[1]).not.toHaveProperty('allowStrategy')
    await store.flush()
    const saved = JSON.parse(await readFile(join(dir, 'agent-core.json'), 'utf8'))
    expect(saved.version).toBe(4)
    expect(saved.acpAgents[0]).toEqual(agent)
    expect(saved.acpAgents[1]).not.toHaveProperty('allowStrategy')
    store = await JsonStore.open(dir)
    expect(store.snapshot().acpAgents[0]).toEqual(agent)
  })

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
