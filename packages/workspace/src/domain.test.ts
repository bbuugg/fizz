/**
 * 远端工作区的登记 / 重命名规则。
 *
 * ## 防的是什么
 *
 * `addWorkspace` 是**逐字段重建整条记录**，而重命名（PATCH）只传 `id + path + name`：
 * 漏带 `remote` 会把远端工作区静默降级成本地工作区（之后工具开始操作本机同名路径）；
 * 去重只按 `path` 时，同名的本机目录与远端目录会互相顶掉记录。
 *
 * 这里的用例钉住三件事：远端标记存活、`(hostId, path)` 去重、以及远端与
 * worktree / 容器 / 临时工作区的互斥。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './store'
import { AgentDomain } from './domain'

let dataDir: string
let store: JsonStore
let domain: AgentDomain

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fizz-domain-'))
  store = await JsonStore.open(dataDir)
  domain = new AgentDomain(store)
})

afterEach(async () => {
  await store.flush()
  await rm(dataDir, { recursive: true, force: true })
})

/** 建一台 SSH 主机（默认不需要凭据就能落库，只有真建连时才用得到） */
function sshHost(name = '测试主机'): string {
  return domain.saveSshHost({ name, host: 'example.com', username: 'root' }).id
}

describe('远端工作区登记', () => {
  it('有效 SSH 主机 + POSIX 绝对路径：登记成功且不做本机 stat', async () => {
    const hostId = sshHost()
    // `/srv/app` 在本机（Windows）必然不存在 —— 能登记成功就说明没走本地 stat
    const ws = await domain.addWorkspace({ path: '/srv//app/', remote: { hostId } })

    expect(ws.remote).toEqual({ hostId })
    expect(ws.path).toBe('/srv/app')
    expect(ws.name).toBe('app')
    expect(domain.getWorkspace(ws.id)?.remote?.hostId).toBe(hostId)
  })

  it('路径必须是以 / 开头的绝对路径', async () => {
    const hostId = sshHost()
    await expect(domain.addWorkspace({ path: 'srv/app', remote: { hostId } })).rejects.toThrow(
      '绝对路径'
    )
    await expect(
      domain.addWorkspace({ path: '/srv/app/../etc', remote: { hostId } })
    ).rejects.toThrow('..')
  })

  it('主机不存在 / 本机终端配置不能当远端主机', async () => {
    await expect(
      domain.addWorkspace({ path: '/srv/app', remote: { hostId: 'missing' } })
    ).rejects.toThrow('SSH 主机不存在')

    const local = domain.saveSshHost({ kind: 'local', name: '本机' }).id
    await expect(
      domain.addWorkspace({ path: '/srv/app', remote: { hostId: local } })
    ).rejects.toThrow('本机终端')
  })

  it('重命名（只传 id + 原路径 + name）保留 remote', async () => {
    const hostId = sshHost()
    const ws = await domain.addWorkspace({ path: '/srv/app', remote: { hostId } })

    const renamed = await domain.addWorkspace({ id: ws.id, path: ws.path, name: '生产环境' })

    expect(renamed.id).toBe(ws.id)
    expect(renamed.name).toBe('生产环境')
    expect(renamed.remote).toEqual({ hostId })
    expect(domain.getWorkspace(ws.id)?.remote).toEqual({ hostId })
  })

  it('去重键是 (hostId, path)：同路径换主机是另一条记录', async () => {
    const a = sshHost('A')
    const b = sshHost('B')
    const first = await domain.addWorkspace({ path: '/srv/app', remote: { hostId: a } })
    const again = await domain.addWorkspace({ path: '/srv/app', remote: { hostId: a } })
    const otherHost = await domain.addWorkspace({ path: '/srv/app', remote: { hostId: b } })

    expect(again.id).toBe(first.id)
    expect(otherHost.id).not.toBe(first.id)
    expect(domain.listWorkspaces()).toHaveLength(2)
  })

  it('远端与 worktree / 容器 / 临时工作区互斥', async () => {
    const hostId = sshHost()
    await expect(
      domain.addWorkspace({ path: '/srv/app', remote: { hostId }, isWorktree: true })
    ).rejects.toThrow('worktree')
    await expect(
      domain.addWorkspace({
        path: '/srv/app',
        remote: { hostId },
        parentWorkspaceId: 'parent'
      })
    ).rejects.toThrow('其他项目')
    await expect(
      domain.addWorkspace({
        path: '/srv/app',
        remote: { hostId },
        container: { slug: 'x' } as never
      })
    ).rejects.toThrow('容器')
    await expect(
      domain.addWorkspace({ path: '/srv/app', remote: { hostId }, scratch: true })
    ).rejects.toThrow('临时工作区')
  })

  it('已登记的本机工作区不能原地改成远端', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'fizz-local-'))
    try {
      const local = await domain.addWorkspace({ path: localDir })
      const hostId = sshHost()
      await expect(
        domain.addWorkspace({ id: local.id, path: '/srv/app', remote: { hostId } })
      ).rejects.toThrow('不能直接改成远端')
    } finally {
      await rm(localDir, { recursive: true, force: true })
    }
  })
})

describe('MCP server 保存', () => {
  // 回归：切到 http 再切回 stdio，原来那组字段不能被「当前方式」的输入清掉
  it('切换传输方式后另一组字段仍在', () => {
    const stdio = domain.saveMcpServer({
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      env: { TOKEN: 'x' }
    })
    const http = domain.saveMcpServer({
      id: stdio.id,
      name: '本地工具',
      transport: 'http',
      url: 'http://127.0.0.1:3000/mcp'
    })
    expect(http.url).toBe('http://127.0.0.1:3000/mcp')
    expect(http.command).toBe('npx')
    expect(http.args).toEqual(['-y', 'some-mcp'])
    expect(http.env).toEqual({ TOKEN: 'x' })

    const back = domain.saveMcpServer({
      id: stdio.id,
      name: '本地工具',
      transport: 'stdio',
      command: 'npx'
    })
    expect(back.command).toBe('npx')
    expect(back.url).toBe('http://127.0.0.1:3000/mcp')
  })

  it('当前方式那一组以输入为准：清空 env 能生效', () => {
    const created = domain.saveMcpServer({
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      env: { TOKEN: 'x' }
    })
    const cleared = domain.saveMcpServer({
      id: created.id,
      name: '本地工具',
      transport: 'stdio',
      command: 'npx'
    })
    expect(cleared.env).toBeUndefined()
  })
})