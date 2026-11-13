/**
 * `str_replace_editor` 的语义基线（与 dsh 的同名工具对齐）。
 *
 * 防的回归：
 * - `view` 的行号宽度 / 总数说明被改（模型按行号定位，错一位就换错行）；
 * - `str_replace` 从「必须唯一命中」退化成「全替换」—— 那会静默改掉别的相似片段；
 * - `insert` 的插入位置从「第 N 行之后」错成「第 N 行之前」；
 * - `create` 允许覆盖已有文件（覆盖属于 write，create 只负责新建）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { buildAgentTools } from './tools'
import { formatFileView, insertAfterLine, replaceUnique } from './str-replace-editor'

const ROOT = '/root'

function fakeBackend(files: Record<string, string> = {}): WorkspaceBackend {
  return {
    kind: 'local',
    root: ROOT,
    resolve: (p) => (p.startsWith('/') ? p : `${ROOT}/${p.replace(/^\/+/, '')}`),
    rel: (abs) => (abs === ROOT ? '' : abs.replace(`${ROOT}/`, '')),
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    basename: (p) => p.split('/').pop() ?? p,
    stat: vi.fn(async (p: string) => {
      const rel = p.replace(`${ROOT}/`, '')
      if (rel in files) return { type: 'file' as const, size: files[rel].length, mtimeMs: 0 }
      return null
    }),
    readDir: vi.fn(async () => []),
    readFile: vi.fn(async (p: string) => Buffer.from(files[p.replace(`${ROOT}/`, '')] ?? '')),
    writeFile: vi.fn(async (p: string, data: Buffer | string) => {
      files[p.replace(`${ROOT}/`, '')] = String(data)
    }),
    mkdirp: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    ignoreChecker: vi.fn(async () => () => false),
    search: vi.fn(async () => []),
    find: vi.fn(async () => []),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, reason: 'exit' as const, truncated: false }))
  }
}

function toolsWith(backend: WorkspaceBackend) {
  return buildAgentTools(ROOT, { permissionMode: 'full', backend })
}

async function run(tools: ReturnType<typeof toolsWith>, input: unknown): Promise<string> {
  const entry = tools.str_replace_editor as unknown as {
    execute: (i: unknown, o: unknown) => Promise<unknown>
  }
  return String(await entry.execute(input, { toolCallId: 'call-1' }))
}

describe('formatFileView', () => {
  it('行号右对齐 6 位，并说明总行数', () => {
    const out = formatFileView('a.txt', 'one\ntwo\n')
    expect(out).toContain('Here’s the content'.replace('’', "'"))
    expect(out).toContain('total of 3 lines')
    expect(out).toContain('     1  one')
    expect(out).toContain('     2  two')
  })

  it('view_range 只给指定区间，[-1] 表示到结尾', () => {
    const content = 'a\nb\nc\nd\n'
    expect(formatFileView('f', content, [2, 3])).toContain('     2  b\n     3  c')
    expect(formatFileView('f', content, [3, -1])).toContain('     3  c\n     4  d')
  })

  it('view_range 越界 / 倒序报错', () => {
    expect(() => formatFileView('f', 'a\nb\n', [5, 6])).toThrow('should be within the range of lines')
    expect(() => formatFileView('f', 'a\nb\n', [2, 1])).toThrow('should be larger or equal')
  })

  it('超长内容截断并标注', () => {
    const out = formatFileView('f', 'x'.repeat(200), undefined, 50)
    expect(out).toContain('<response clipped>')
  })
})

describe('replaceUnique', () => {
  it('唯一命中时替换', () => {
    expect(replaceUnique('a\nb\nc', 'b', 'B', 'f')).toBe('a\nB\nc')
  })

  it('找不到时原样报错', () => {
    expect(() => replaceUnique('abc', 'zzz', 'y', 'f')).toThrow('did not appear verbatim in f')
  })

  it('多处命中时报出所在行号', () => {
    expect(() => replaceUnique('a\nx\nb\nx\n', 'x', 'y', 'f')).toThrow('in lines [2, 4]')
  })
})

describe('insertAfterLine', () => {
  it('插在第 N 行之后（0 = 文件最前）', () => {
    expect(insertAfterLine('a\nb', 0, 'head')).toBe('head\na\nb')
    expect(insertAfterLine('a\nb', 1, 'mid')).toBe('a\nmid\nb')
    expect(insertAfterLine('a\nb', 2, 'tail')).toBe('a\nb\ntail')
  })

  it('越界报错', () => {
    expect(() => insertAfterLine('a\nb', 9, 'x')).toThrow('should be within the range of lines')
  })
})

describe('str_replace_editor · 接进工具集', () => {
  it('view 之后 str_replace 才能改（读后写）', async () => {
    const backend = fakeBackend({ 'a.txt': 'hello\nworld\n' })
    const tools = toolsWith(backend)
    await run(tools, { command: 'view', path: 'a.txt' })
    const out = await run(tools, {
      command: 'str_replace',
      path: 'a.txt',
      old_str: 'world',
      new_str: 'there'
    })
    expect(out).toBe('The file a.txt has been edited successfully.')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, 'hello\nthere\n', {
      createParents: true
    })
  })

  it('没 view 过就 str_replace 会被读后写拦住', async () => {
    const backend = fakeBackend({ 'a.txt': 'hello\n' })
    await expect(
      run(toolsWith(backend), { command: 'str_replace', path: 'a.txt', old_str: 'h', new_str: 'H' })
    ).rejects.toThrow('file has not been read')
  })

  it('create 不能覆盖已存在的文件', async () => {
    const backend = fakeBackend({ 'a.txt': 'x' })
    await expect(
      run(toolsWith(backend), { command: 'create', path: 'a.txt', file_text: 'y' })
    ).rejects.toThrow('File already exists at: a.txt')
  })

  it('create 新建后返回 dsh 的原文案', async () => {
    const backend = fakeBackend()
    const out = await run(toolsWith(backend), { command: 'create', path: 'new.txt', file_text: 'hi' })
    expect(out).toBe('New file created successfully at: new.txt')
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/new.txt`, 'hi', { createParents: true })
  })

  it('insert 在第 N 行之后插入', async () => {
    const backend = fakeBackend({ 'a.txt': 'one\ntwo\n' })
    const tools = toolsWith(backend)
    await run(tools, { command: 'view', path: 'a.txt' })
    await run(tools, { command: 'insert', path: 'a.txt', insert_line: 1, new_str: 'middle' })
    expect(backend.writeFile).toHaveBeenCalledWith(`${ROOT}/a.txt`, 'one\nmiddle\ntwo\n', {
      createParents: true
    })
  })

  it('view 不存在的路径用 dsh 的原文案', async () => {
    await expect(run(toolsWith(fakeBackend()), { command: 'view', path: 'nope.txt' })).rejects.toThrow(
      'The path nope.txt does not exist. Please provide a valid path.'
    )
  })
})
