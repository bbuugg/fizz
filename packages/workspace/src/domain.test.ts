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
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonStore } from './store'
import { AgentDomain, sameWorkspacePath } from './domain'

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

/**
 * 路径去重口径：防的是「同一个目录被登记成两行」。
 *
 * 拖拽进侧栏时系统给的是**真实大小写**，而历史登记可能来自手输；Windows / macOS 的
 * 文件系统本身不区分大小写，字符串严格比较会在侧栏长出两个一模一样的项目。
 * Linux 上则必须区分 —— 那两个是真目录。
 */
describe('工作区路径去重口径', () => {
  /** 换平台口径跑：`sameWorkspacePath` 每次现读 `process.platform`，不在加载时固化 */
  function asPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      return run()
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  }

  it('Windows / macOS 上大小写不同的同一路径算一个目录', () => {
    expect(asPlatform('win32', () => sameWorkspacePath('D:\\Work\\Foo', 'd:\\work\\foo'))).toBe(
      true
    )
    expect(asPlatform('darwin', () => sameWorkspacePath('/Users/Me/App', '/users/me/app'))).toBe(
      true
    )
  })

  it('Linux 上大小写不同就是两个目录，原样相等仍算一个', () => {
    expect(asPlatform('linux', () => sameWorkspacePath('/srv/App', '/srv/app'))).toBe(false)
    expect(asPlatform('linux', () => sameWorkspacePath('/srv/app', '/srv/app'))).toBe(true)
  })

  // 真实目录上的端到端确认（大小写不敏感的文件系统才跑得通，其它平台跳过：
  // 在 Linux 上 `dir.toUpperCase()` 压根 stat 不到，测的就不是本意了）
  it.skipIf(process.platform !== 'win32')('同一目录换个大小写登记不新增工作区', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-case-'))
    try {
      const first = await domain.addWorkspace({ path: dir })
      const again = await domain.addWorkspace({ path: dir.toUpperCase() })

      expect(again.id).toBe(first.id)
      expect(domain.listWorkspaces()).toHaveLength(1)
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  // 重复登记不该把既有记录「改写成另一种大小写」：拖拽给的是文件系统真实大小写，
  // 直接落盘会让侧栏的项目名从 `MyProject` 变成 `myproject`，看着像被改坏了
  it.skipIf(process.platform !== 'win32')('重复登记同一目录时保留既有的路径写法与项目名', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-name-'))
    try {
      const first = await domain.addWorkspace({ path: dir })
      const again = await domain.addWorkspace({ path: dir.toUpperCase() })

      expect(again.path).toBe(first.path)
      expect(again.name).toBe(first.name)
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})

/**
 * 「移除项目」只把它移出列表，不该连会话一起删。
 *
 * ## 防的是什么
 *
 * 会话文件写在 `<项目>/.fizz/conversation/<会话 id>/`，而工作区记录是启动扫盘的入口。
 * 以前 `deleteWorkspace` 连记录带目录一起删 —— 用户「移除项目，过两天再加回来」等于把
 * 聊天记录全丢了。现在移除是打 `removedAt` 标记，重新登记同一目录要能原样接上。
 */
describe('移除工作区与恢复', () => {
  it('移除后会话还在；同一目录重新登记会复用记录、会话原样接上', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-remove-'))
    try {
      const ws = await domain.addWorkspace({ path: dir })
      const conv = domain.saveConversation({ workspaceId: ws.id, title: '旧对话' })

      domain.deleteWorkspace(ws.id)

      // 列表里没了，但记录还在（软删）—— 会话文件仍挂在它名下
      expect(domain.listWorkspaces().some((w) => w.id === ws.id)).toBe(false)
      expect(domain.getWorkspace(ws.id)?.removedAt).toBeTypeOf('number')
      expect(domain.listConversations().some((c) => c.id === conv.id)).toBe(true)

      // 「移除」也收回了访问权：文件工具不该还能在它下面读写
      expect(domain.findWorkspaceContaining(join(dir, 'a.txt'))).toBeUndefined()

      const again = await domain.addWorkspace({ path: dir })
      expect(again.id).toBe(ws.id)
      expect(again.removedAt).toBeUndefined()
      expect(domain.listWorkspaces().some((w) => w.id === ws.id)).toBe(true)
      expect(domain.findWorkspaceContaining(join(dir, 'a.txt'))?.id).toBe(ws.id)
      expect(
        domain.listConversations().filter((c) => c.workspaceId === again.id)
      ).toHaveLength(1)
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('移除时保留用户改过的项目名，不拿目录名覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-rename-'))
    try {
      const ws = await domain.addWorkspace({ path: dir, name: '我的项目' })
      domain.saveConversation({ workspaceId: ws.id, title: '对话' })
      domain.deleteWorkspace(ws.id)

      const again = await domain.addWorkspace({ path: dir })
      expect(again.name).toBe('我的项目')
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('按 id 重命名一个已移除的项目，不会把它放回列表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-hidden-'))
    try {
      const ws = await domain.addWorkspace({ path: dir })
      domain.saveConversation({ workspaceId: ws.id, title: '对话' })
      domain.deleteWorkspace(ws.id)

      const renamed = await domain.addWorkspace({ id: ws.id, path: ws.path, name: '改个名' })

      expect(renamed.name).toBe('改个名')
      expect(renamed.removedAt).toBeTypeOf('number')
      expect(domain.listWorkspaces().some((w) => w.id === ws.id)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('没有任何会话的项目移除时直接真删，不留永远回不来的空壳', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-empty-'))
    try {
      const ws = await domain.addWorkspace({ path: dir })
      domain.deleteWorkspace(ws.id)
      expect(domain.getWorkspace(ws.id)).toBeUndefined()
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('purgeWorkspace 仍然连会话一起删（勾了删磁盘走这条路）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fizz-purge-'))
    try {
      const ws = await domain.addWorkspace({ path: dir })
      const conv = domain.saveConversation({ workspaceId: ws.id, title: '对话' })

      domain.purgeWorkspace(ws.id)

      expect(domain.getWorkspace(ws.id)).toBeUndefined()
      expect(domain.listConversations().some((c) => c.id === conv.id)).toBe(false)
    } finally {
      // 会话目录是 store 异步落盘的，删到一半可能还在写 —— 重试几次再放弃
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
/**
 * 打开会话不该让它在侧栏里换位置（回归测试）。
 *
 * ## 防的是什么
 *
 * 用 ACP 会话时，点开侧栏里的某一条（一条消息都没发）它就跳到列表最上面。
 *
 * 链路：打开 ACP 会话会走 `session/load` 回放，回放后的 `refreshAcpSessionState`
 * 把 agent 广告的 Session Modes / 思考档合并回会话配置 —— `setAcpSessionState` 里
 * 顺手写了 `updatedAt: Date.now()`，而侧栏按 `updatedAt` 倒序排。于是「看一眼」
 * 等于「活跃了一次」。
 *
 * 这里钉住：同步运行态不改 `updatedAt`，且值没变时连落盘都不做。
 */
describe('ACP 运行态同步 · 不动 updatedAt', () => {
  const modes = (current: string) => ({
    available: [
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' }
    ],
    current
  })

  async function acpConversation(): Promise<string> {
    const ws = await domain.addWorkspace({ path: dataDir })
    const conv = domain.saveConversation({
      workspaceId: ws.id,
      title: 'acp 会话',
      backend: 'acp',
      configId: 'cfg-1',
      acpSessionId: 'sess-1'
    })
    return conv.id
  }

  it('写入新的档位：acpModes 生效，但 updatedAt 原样不动', async () => {
    const id = await acpConversation()
    const before = domain.getConversation(id)!

    const next = domain.setAcpSessionState(id, { acpModes: modes('plan') })

    expect(next.acpModes?.current).toBe('plan')
    expect(next.updatedAt).toBe(before.updatedAt)
  })

  it('值没变：直接返回原对象（不落盘、不标脏）', async () => {
    const id = await acpConversation()
    domain.setAcpSessionState(id, { acpModes: modes('plan') })
    const before = domain.getConversation(id)!

    const next = domain.setAcpSessionState(id, { acpModes: modes('plan') })

    expect(next).toBe(before)
  })
})

/**
 * 防的回归：临时会话目录退回成 `conversations/<id>` 一层 —— 用户要求按年月日分组，
 * 一旦有人把日期层删掉，所有临时会话又会在 `conversations/` 下堆成 uuid 目录。
 */
describe('临时工作区目录', () => {
  it('按本地年月日分组：conversations/<YYYYMMDD>/<会话 id>', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 22, 10, 0, 0))
    try {
      const ws = await domain.ensureScratchWorkspace('conv-1')

      expect(ws.scratch).toBe(true)
      expect(ws.path).toBe(join(dataDir, 'conversations', '20261122', 'conv-1'))
      expect((await stat(ws.path)).isDirectory()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
