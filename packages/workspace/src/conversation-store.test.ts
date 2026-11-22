/**
 * 远端工作区的会话根：**固定在本机数据目录**，不写远端 `.fizz/conversation`。
 *
 * ## 防的是什么
 *
 * 如果把会话根解析到 `workspace.path`，远端工作区的每条消息都要经 SFTP 落盘，而且
 * 主机断线后历史直接不可见；启动扫描还会尝试连 SSH。这里钉住三件事：
 * 1. `conversationRootFor` 对远端返回 `conversations/remote/<工作区 id>`；
 * 2. 启动装配能扫到这份目录（主机 / 工作区记录都不参与）；
 * 3. 本地工作区缺失目录时的兜底语义**逐字不变**。
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentWorkspace } from '@fizz/contracts/types'
import {
  conversationRootFor,
  fallbackConversationRoot,
  listRemoteConversations,
  remoteConversationRoot,
  writeConversation
} from './conversation-store'
import { AgentDomain } from './domain'
import { JsonStore } from './store'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fizz-conv-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function remoteWorkspace(id = 'w1'): Pick<AgentWorkspace, 'id' | 'path' | 'remote'> {
  return { id, path: '/srv/app', remote: { hostId: 'h1' } }
}

describe('conversationRootFor', () => {
  it('远端：根在数据目录下，create=true 时建出来', async () => {
    const resolved = await conversationRootFor(remoteWorkspace(), dataDir, { create: true })

    expect(resolved.root).toBe(remoteConversationRoot(dataDir, 'w1'))
    expect(resolved.root).toBe(join(fallbackConversationRoot(dataDir), 'remote', 'w1'))
    expect(resolved.remote).toBe(true)
    // 远端根不在工作区目录里，调用方据此跳过「扫项目目录」那条路
    expect(resolved.fallback).toBe(true)
  })

  it('本地目录不在时仍退回数据目录兜底（老行为不变）', async () => {
    const resolved = await conversationRootFor(
      { id: 'w2', path: join(dataDir, 'not-there') },
      dataDir
    )

    expect(resolved.remote).toBe(false)
    expect(resolved.fallback).toBe(true)
    expect(resolved.root).toBe(fallbackConversationRoot(dataDir))
  })
})

describe('远端会话的落盘与启动装配', () => {
  it('保存后落在 conversations/remote/<工作区 id>，重启扫描能读回', async () => {
    const store = await JsonStore.open(dataDir)
    const domain = new AgentDomain(store)
    const host = domain.saveSshHost({ name: '主机', host: 'example.com', username: 'root' })
    const ws = await domain.addWorkspace({ path: '/srv/app', remote: { hostId: host.id } })

    const conversation = domain.saveConversation({ workspaceId: ws.id, title: '远端会话' })
    await store.flush()

    const dataFile = join(remoteConversationRoot(dataDir, ws.id), conversation.id, 'conversation.json')
    await expect(readFile(dataFile, 'utf8')).resolves.toContain('远端会话')

    // 主机被删 / 断线都只是「这一轮跑不了」，历史照旧读得回来
    domain.deleteSshHost(host.id)
    await store.flush()
    const reopened = await JsonStore.open(dataDir)
    const reloaded = new AgentDomain(reopened)

    expect(reloaded.getConversation(conversation.id)?.title).toBe('远端会话')
    expect(reloaded.getWorkspace(ws.id)?.remote?.hostId).toBe(host.id)
    expect((await listRemoteConversations(dataDir)).map((c) => c.id)).toContain(conversation.id)
    await reopened.flush()
  })

  it('writeConversation 写进远端根后，listRemoteConversations 立刻能扫到', async () => {
    const { root } = await conversationRootFor(remoteWorkspace('w9'), dataDir, { create: true })
    await writeConversation(root, {
      id: 'c9',
      workspaceId: 'w9',
      title: '手写会话',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })

    const found = await listRemoteConversations(dataDir)
    expect(found.map((c) => c.id)).toEqual(['c9'])
  })
})

/**
 * 防的回归：旧布局的临时会话目录（`conversations/<会话 id>`）**不迁移、不兼容**。
 * 新布局只认 `conversations/<年月日>/<会话 id>`；旧的工作区记录与会话在启动时直接
 * 丢弃，不能被扫回列表里（否则等于还在兼容旧路径）。
 */
describe('旧布局临时会话', () => {
  it('启动时直接丢弃，不搬进日期目录', async () => {
    const conversationId = 'old-conv'
    const store = await JsonStore.open(dataDir)
    const domain = new AgentDomain(store)
    const ws = await domain.ensureScratchWorkspace(conversationId)
    domain.saveConversation({ id: conversationId, workspaceId: ws.id, title: '旧会话' })
    await store.flush()

    // 手工退回旧布局，并让工作区记录重新指向它
    const oldPath = join(dataDir, 'conversations', conversationId)
    await mkdir(dirname(oldPath), { recursive: true })
    await rename(ws.path, oldPath)
    store.mutate((d) => {
      d.workspaces = d.workspaces.map((w) => (w.id === ws.id ? { ...w, path: oldPath } : w))
    })
    await store.flush()

    const reopened = await JsonStore.open(dataDir)

    expect(reopened.snapshot().workspaces.some((w) => w.id === ws.id)).toBe(false)
    expect(reopened.snapshot().conversations.some((c) => c.id === conversationId)).toBe(false)
    // 不主动删用户磁盘数据：目录原样留着，需要腾空间时用户自己清
    expect((await stat(oldPath)).isDirectory()).toBe(true)
    await reopened.flush()
  })
})