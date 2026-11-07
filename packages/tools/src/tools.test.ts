/**
 * 工具层路由基线：每个文件 / 搜索 / 命令工具都必须经 `WorkspaceBackend`，
 * 而不是偷偷摸本地 `node:fs` / `spawn`。
 *
 * 用一份全 vi.fn 的假后端断言调用点与可见输出格式 —— 远端后端只要实现同一份
 * contracts 接口，就能复用这些工具；这里漏掉一条路由，远端工作区就会悄悄读写
 * 服务器本地盘。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { buildAgentTools, type AgentToolOptions } from './tools'

const ROOT = '/root'

function fakeBackend(kind: 'local' | 'remote' = 'local'): WorkspaceBackend {
  return {
    kind,
    root: ROOT,
    resolve: (p) => (p ? `${ROOT}/${p.replace(/^\/+/, '')}` : ROOT),
    rel: (abs) => (abs === ROOT ? '' : abs.replace(`${ROOT}/`, '')),
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    basename: (p) => p.split('/').pop() ?? p,
    stat: vi.fn(async (p: string) =>
      p === '/root/missing'
        ? null
        : p.endsWith('.txt') || p.endsWith('.ts')
          ? { type: 'file' as const, size: 11, mtimeMs: 0 }
          : { type: 'dir' as const, size: 0, mtimeMs: 0 }
    ),
    readDir: vi.fn(async () => [
      { name: 'src', type: 'dir' as const },
      { name: 'a.txt', type: 'file' as const, size: 5 }
    ]),
    readFile: vi.fn(async () => Buffer.from('hello\nworld\n')),
    writeFile: vi.fn(async () => undefined),
    mkdirp: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    ignoreChecker: vi.fn(async () => () => false),
    search: vi.fn(async () => [
      { file: 'src/a.ts', hits: [{ line: 2, text: 'needle' }] }
    ]),
    find: vi.fn(async () => ['src/a.ts']),
    exec: vi.fn(async () => ({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      reason: 'exit' as const,
      truncated: false
    }))
  }
}

function toolsWith(backend: WorkspaceBackend, opts: Partial<AgentToolOptions> = {}) {
  return buildAgentTools(ROOT, { permissionMode: 'full', backend, ...opts })
}

async function run(tools: ReturnType<typeof toolsWith>, name: string, input: unknown) {
  const entry = tools[name] as unknown as {
    execute: (i: unknown, o: unknown) => Promise<unknown>
  }
  return String(await entry.execute(input, { toolCallId: 'call-1' }))
}

describe('buildAgentTools · 全部经后端路由', () => {
  it('list_files 走 readDir / ignoreChecker', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'list_files', { depth: 0 })
    expect(out).toContain('src/')
    expect(out).toContain('a.txt\t5B')
    expect(backend.readDir).toHaveBeenCalledWith(ROOT)
    expect(backend.ignoreChecker).toHaveBeenCalled()
  })

  it('read_file 走 stat / readFile，并保留行号格式', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'read_file', { path: 'a.txt' })
    expect(out).toContain('a.txt（共 3 行 / 12 字符）')
    expect(out).toContain('    1 | hello')
    expect(backend.readFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, { maxBytes: 8_000_000 })
  })

  it('write_file 走 writeFile', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'write_file', { path: 'x.txt', content: 'abc' })
    expect(out).toBe('已写入 x.txt（3 字符）')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/x.txt`, 'abc')
  })

  it('edit_file 读改写都经后端', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'edit_file', {
      path: 'a.txt',
      edits: [{ oldText: 'world', newText: 'there' }]
    })
    expect(out).toContain('已应用 1 处编辑（a.txt）')
    expect(backend.readFile).toHaveBeenCalled()
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, 'hello\nthere\n')
  })

  it('search_files 走 backend.search，并保留 ripgrep 输出格式', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'search_files', { pattern: 'needle' })
    expect(out).toBe('src/a.ts:2: needle')
    expect(backend.search).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'needle', subPath: '', context: 0, maxResults: 200 })
    )
  })

  it('find_files 走 backend.find', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'find_files', { pattern: '*.ts' })
    expect(out).toBe('1 个文件：\nsrc/a.ts')
    expect(backend.find).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '*.ts', subPath: '', maxResults: 200 })
    )
  })

  it('execute_command 走 backend.exec，并保留 `$ 命令` / 退出码格式', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'execute_command', { command: 'echo hi' })
    expect(out).toBe('$ echo hi\n（退出码 0）\nok')
    expect(backend.exec).toHaveBeenCalledWith(
      'echo hi',
      expect.objectContaining({ cwd: ROOT, timeoutMs: 120_000 })
    )
  })

  it('execute_command 在远端后端上拒绝 runInBackground', async () => {
    const backend = fakeBackend('remote')
    const out = await run(toolsWith(backend), 'execute_command', {
      command: 'npm run dev',
      runInBackground: true
    })
    expect(out).toContain('首期不支持后台执行')
    expect(backend.exec).not.toHaveBeenCalled()
  })

  it('delete_file 走 backend.remove', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'delete_file', { path: 'a.txt' })
    expect(out).toBe('已删除文件 a.txt')
    expect(backend.remove).toHaveBeenCalledWith(`${ROOT}/a.txt`, {
      recursive: false,
      force: true
    })
  })

  it('readonly 仍在写操作之前拦住（不触达后端）', async () => {
    const backend = fakeBackend()
    const tools = toolsWith(backend, { permissionMode: 'readonly' })
    const out = await run(tools, 'write_file', { path: 'x.txt', content: 'abc' })
    expect(out).toContain('只读模式')
    expect(backend.writeFile).not.toHaveBeenCalled()
  })
})