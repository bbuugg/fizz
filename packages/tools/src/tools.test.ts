/**
 * 工具层路由基线：每个文件 / 搜索 / 命令工具都必须经 `WorkspaceBackend`，
 * 而不是偷偷摸本地 `node:fs` / `spawn`；返回值与错误文案必须保持固定形状。
 *
 * 用一份全 vi.fn 的假后端断言调用点与可见输出格式 —— 远端后端只要实现同一份
 * contracts 接口，就能复用这些工具；这里漏掉一条路由，远端工作区就会悄悄读写
 * 服务器本地盘。
 *
 * 另有一条**语义**基线：write / edit 只能改「本次读过且没被改过」的文件，
 * 读后写 / 严格唯一匹配的行为都在下面钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { applyLiteralEdit, buildAgentTools, globToRegExpSource, type AgentToolOptions } from './tools'

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
    search: vi.fn(async () => [{ file: 'src/a.ts', hits: [{ line: 2, text: 'needle' }] }]),
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
  it('read 走 stat / readFile，返回固定信封与行号', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'read', { file_path: 'a.txt' })
    expect(out).toContain('<path>a.txt</path>')
    expect(out).toContain('<type>file</type>')
    expect(out).toContain('1: hello')
    expect(out).toContain('2: world')
    expect(out).toContain('(End of file - total 3 lines)')
    expect(backend.readFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, { maxBytes: 8_000_000 })
  })

  it('read 的 limit 超过 2000 直接报错（上限不是夹取）', async () => {
    const backend = fakeBackend()
    await expect(run(toolsWith(backend), 'read', { file_path: 'a.txt', limit: 5000 })).rejects.toThrow(
      'limit must be less than or equal to 2000'
    )
  })

  it('read 的 offset 越界报错', async () => {
    const backend = fakeBackend()
    await expect(run(toolsWith(backend), 'read', { file_path: 'a.txt', offset: 99 })).rejects.toThrow(
      'offset 99 is out of range for "a.txt" (3 lines)'
    )
  })

  it('write 新建文件返回 Created file', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'write', { file_path: 'missing', content: 'abc' })
    expect(out).toContain('Created file')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/missing`, 'abc', { createParents: true })
  })

  it('write 覆盖未读过的已存在文件被拒（读后写）', async () => {
    const backend = fakeBackend()
    await expect(
      run(toolsWith(backend), 'write', { file_path: 'x.txt', content: 'abc' })
    ).rejects.toThrow('file has not been read')
    expect(backend.writeFile).not.toHaveBeenCalled()
  })

  it('read 之后再 write 才放行，返回 Updated file', async () => {
    const backend = fakeBackend()
    const tools = toolsWith(backend)
    await run(tools, 'read', { file_path: 'x.txt' })
    const out = await run(tools, 'write', { file_path: 'x.txt', content: 'abc' })
    expect(out).toContain('Updated file')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/x.txt`, 'abc', { createParents: true })
  })

  it('edit 读改写都经后端，命中唯一时成功', async () => {
    const backend = fakeBackend()
    const tools = toolsWith(backend)
    await run(tools, 'read', { file_path: 'a.txt' })
    const out = await run(tools, 'edit', {
      file_path: 'a.txt',
      old_string: 'world',
      new_string: 'there'
    })
    expect(out).toBe('The file a.txt has been updated successfully.')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, 'hello\nthere\n', {
      createParents: true
    })
  })

  it('edit 命中多处时要求 replace_all', async () => {
    const backend = fakeBackend()
    backend.readFile = vi.fn(async () => Buffer.from('a\na\n'))
    const tools = toolsWith(backend)
    await run(tools, 'read', { file_path: 'a.txt' })
    await expect(
      run(tools, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
    ).rejects.toThrow('old_string matched 2 times in "a.txt"')
  })

  it('edit 的 old_string 与 new_string 相同直接拒', async () => {
    const backend = fakeBackend()
    await expect(
      run(toolsWith(backend), 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'x' })
    ).rejects.toThrow('old_string and new_string must differ')
  })

  it('grep 走 backend.search，输出 Found N matches 格式', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'grep', { pattern: 'needle' })
    expect(out).toBe('Found 1 match(es)\n\nsrc/a.ts\nLine 2: needle')
    expect(backend.search).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'needle', subPath: '', context: 0, maxResults: 250 })
    )
  })

  it('grep 无命中时返回 No matches found', async () => {
    const backend = fakeBackend()
    backend.search = vi.fn(async () => [])
    expect(await run(toolsWith(backend), 'grep', { pattern: 'zzz' })).toBe('No matches found')
  })

  it('glob 走 backend.find，输出路径清单', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'glob', { pattern: '*.ts' })
    expect(out).toBe('src/a.ts')
    expect(backend.find).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '*.ts', subPath: '', maxResults: 100 })
    )
  })

  it('glob 无命中时返回 No files found', async () => {
    const backend = fakeBackend()
    backend.find = vi.fn(async () => [])
    expect(await run(toolsWith(backend), 'glob', { pattern: '*.md' })).toBe('No files found')
  })

  it('bash 走 backend.exec，退出码以 `[exit code: N]` 标注', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), 'bash', { command: 'echo hi', intent: 'say hi' })
    expect(out).toBe('ok')
    expect(backend.exec).toHaveBeenCalledWith(
      'echo hi',
      expect.objectContaining({ cwd: ROOT, timeoutMs: 120_000 })
    )
  })

  it('bash 非 0 退出时补 `[exit code: N]`', async () => {
    const backend = fakeBackend()
    backend.exec = vi.fn(async () => ({
      stdout: '',
      stderr: 'boom\n',
      exitCode: 2,
      reason: 'exit' as const,
      truncated: false
    }))
    const out = await run(toolsWith(backend), 'bash', { command: 'false', intent: 'fail' })
    expect(out).toContain('[stderr]\nboom')
    expect(out).toContain('[exit code: 2]')
  })

  it('bash 在远端后端上拒绝 run_in_background', async () => {
    const backend = fakeBackend('remote')
    const out = await run(toolsWith(backend), 'bash', {
      command: 'npm run dev',
      intent: 'dev server',
      run_in_background: true
    })
    expect(out).toContain('首期不支持后台执行')
    expect(backend.exec).not.toHaveBeenCalled()
  })

  it('readonly 仍在写操作之前拦住（不触达后端）', async () => {
    const backend = fakeBackend()
    const tools = toolsWith(backend, { permissionMode: 'readonly' })
    const out = await run(tools, 'write', { file_path: 'missing', content: 'abc' })
    expect(out).toContain('只读模式')
    expect(backend.writeFile).not.toHaveBeenCalled()
  })
})

describe('applyLiteralEdit', () => {
  it('默认必须唯一命中，否则报多处', () => {
    expect(() => applyLiteralEdit('a\na\n', 'a', 'b', false, 'x.txt')).toThrow(
      'old_string matched 2 times in "x.txt"'
    )
  })

  it('replace_all 替换全部', () => {
    expect(applyLiteralEdit('a\na\n', 'a', 'b', true, 'x.txt').text).toBe('b\nb\n')
  })

  it('CRLF 文件改完仍是 CRLF', () => {
    const out = applyLiteralEdit('one\r\ntwo\r\n', 'two', 'three', false, 'x.txt')
    expect(out.text).toBe('one\r\nthree\r\n')
  })

  it('找不到时报错', () => {
    expect(() => applyLiteralEdit('abc', 'zzz', 'y', false, 'x.txt')).toThrow(
      'old_string was not found in "x.txt"'
    )
  })
})

describe('globToRegExpSource', () => {
  it('把 * 与 {a,b} 翻成正则', () => {
    expect(globToRegExpSource('*.ts')).toBe('^[^/]*\\.ts$')
    expect(new RegExp(globToRegExpSource('*.{ts,tsx}')).test('a.tsx')).toBe(true)
    expect(new RegExp(globToRegExpSource('*.{ts,tsx}')).test('a.md')).toBe(false)
  })
})
