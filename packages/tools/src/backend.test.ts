/**
 * 本地后端的行为基线：文件读写 / 列表 / 搜索 / 查找 / 命令执行 / 超时 / 中止 / 越界。
 *
 * 这些用例守的是「工具层改走 backend 之后，本地行为与改造前一致」—— 远端后端
 * （apps/server）只能通过同一份 contracts 接口对齐，语义差异会先在这里暴露。
 *
 * 命令执行不 spawn 真实进程：`node:child_process` 整体换成假的 EventEmitter，
 * `process.kill` 也改成空实现（POSIX 分支会按负 pid 打整组）。
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createLocalBackend } from './backend'
import { summarizeLongOutput } from './output-log'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

/**
 * 搜索 / 查找的 **rg 分支在这里关掉**，强制走 JS 遍历：
 * - 单测不许 spawn 真实进程（仓库约定），本文件又把 `child_process` 整体 mock 了；
 * - 下面两个用例守的是 JS 那套语义（忽略规则、glob 匹配、显式点名文件），
 *   与 rg 分支是两条实现，混在一起会变成「有 rg 的机器绿、没 rg 的机器红」。
 */
vi.mock('./ripgrep', () => ({
  ripgrepSearch: async () => null,
  ripgrepFind: async () => null
}))

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.kill = vi.fn()
  return child
}

/** 是否发生过任何一条「杀进程」路径（Windows taskkill / POSIX 负 pid / 直杀 child） */
function reaped(child: FakeChild): boolean {
  const taskkill = vi.mocked(spawn).mock.calls.some((call) => call[0] === 'taskkill')
  return taskkill || child.kill.mock.calls.length > 0 || vi.mocked(process.kill).mock.calls.length > 0
}

describe('createLocalBackend · 文件系统', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fizz-backend-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('resolve 拒绝越界路径', () => {
    const backend = createLocalBackend(root)
    expect(() => backend.resolve('../outside')).toThrow(/越界/)
    expect(backend.rel(join(root, 'a', 'b.txt'))).toBe('a/b.txt')
  })

  it('写文件自动建父目录，读回与 stat 一致', async () => {
    const backend = createLocalBackend(root)
    const abs = backend.resolve('src/a.ts')
    await backend.writeFile(abs, 'hello\nworld')
    await expect(backend.readFile(abs)).resolves.toEqual(Buffer.from('hello\nworld'))
    await expect(backend.stat(abs)).resolves.toMatchObject({ type: 'file', size: 11 })
    expect(await backend.stat(backend.resolve('missing.txt'))).toBeNull()
  })

  it('readDir 目录在前、同类按名称', async () => {
    const backend = createLocalBackend(root)
    await backend.writeFile(backend.resolve('b.txt'), 'b')
    await backend.writeFile(backend.resolve('a.txt'), 'a')
    await backend.mkdirp(backend.resolve('zdir'))
    const entries = await backend.readDir(root)
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['zdir', 'dir'],
      ['a.txt', 'file'],
      ['b.txt', 'file']
    ])
  })

  it('search 命中行号 / 文件过滤 / 忽略规则 / context 区间', async () => {
    const backend = createLocalBackend(root)
    await backend.writeFile(backend.resolve('src/a.ts'), 'alpha\nneedle one\nomega\n')
    await backend.writeFile(backend.resolve('src/b.md'), 'needle two\n')
    await backend.writeFile(backend.resolve('dist/c.ts'), 'needle ignored\n')
    await backend.writeFile(backend.resolve('.gitignore'), 'dist/\n')
    const ignore = await backend.ignoreChecker()
    const hits = await backend.search({
      pattern: 'needle',
      caseInsensitive: false,
      subPath: 'src',
      filePattern: '\\.ts$',
      context: 1,
      maxResults: 10,
      maxFileBytes: 1_000_000,
      ignore
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].file).toBe('src/a.ts')
    expect(hits[0].hits).toEqual([{ line: 2, text: 'needle one' }])
    expect(hits[0].context).toEqual([
      { line: 1, text: 'alpha', hit: false },
      { line: 2, text: 'needle one', hit: true },
      { line: 3, text: 'omega', hit: false }
    ])
  })

  it('search 显式点名文件时不走忽略规则', async () => {
    const backend = createLocalBackend(root)
    await backend.writeFile(backend.resolve('dist/c.ts'), 'needle hidden\n')
    await backend.writeFile(backend.resolve('.gitignore'), 'dist/\n')
    const hits = await backend.search({
      pattern: 'needle',
      caseInsensitive: false,
      subPath: 'dist/c.ts',
      context: 0,
      maxResults: 10,
      maxFileBytes: 1_000_000,
      ignore: await backend.ignoreChecker()
    })
    expect(hits.map((h) => h.file)).toEqual(['dist/c.ts'])
  })

  it('find 按 glob 匹配相对路径，并跳过忽略目录', async () => {
    const backend = createLocalBackend(root)
    await backend.writeFile(backend.resolve('src/a.ts'), '')
    await backend.writeFile(backend.resolve('src/deep/b.ts'), '')
    await backend.writeFile(backend.resolve('dist/c.ts'), '')
    await backend.writeFile(backend.resolve('.gitignore'), 'dist/\n')
    const out = await backend.find({
      pattern: '*.ts',
      subPath: '',
      maxResults: 10,
      ignore: await backend.ignoreChecker()
    })
    expect(out.sort()).toEqual(['src/a.ts', 'src/deep/b.ts'])
  })

  it('remove / rename 与本地 fs 同义', async () => {
    const backend = createLocalBackend(root)
    await backend.writeFile(backend.resolve('a.txt'), 'a')
    await backend.rename(backend.resolve('a.txt'), backend.resolve('b.txt'))
    expect(await backend.stat(backend.resolve('a.txt'))).toBeNull()
    expect(await backend.stat(backend.resolve('b.txt'))).toMatchObject({ type: 'file' })
    await backend.remove(backend.resolve('b.txt'), { force: true })
    expect(await backend.stat(backend.resolve('b.txt'))).toBeNull()
  })
})

describe('createLocalBackend · 命令执行', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fizz-backend-'))
    vi.mocked(spawn).mockReset()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('汇总 stdout / stderr 与退出码', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const backend = createLocalBackend(root)
    const pending = backend.exec('echo hi')
    child.stdout.emit('data', Buffer.from('hi\n'))
    child.stderr.emit('data', Buffer.from('oops\n'))
    child.emit('exit', 0)
    await expect(pending).resolves.toMatchObject({
      stdout: 'hi\n',
      stderr: 'oops\n',
      exitCode: 0,
      reason: 'exit',
      truncated: false
    })
  })

  it('abortSignal 触发时收场为 aborted 并杀进程树', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const backend = createLocalBackend(root)
    const ctrl = new AbortController()
    const pending = backend.exec('sleep 10', { signal: ctrl.signal })
    ctrl.abort()
    await expect(pending).resolves.toMatchObject({ reason: 'aborted' })
    // Windows 走 taskkill、POSIX 走负 pid；两条路都算「杀过」
    expect(reaped(child)).toBe(true)
  })

  it('超时收场为 timeout', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const backend = createLocalBackend(root)
    await expect(backend.exec('sleep 10', { timeoutMs: 10 })).resolves.toMatchObject({
      reason: 'timeout'
    })
    expect(reaped(child)).toBe(true)
  })

  it('启动失败走 error（不抛）', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const backend = createLocalBackend(root)
    const pending = backend.exec('nope')
    child.emit('error', new Error('spawn ENOENT'))
    await expect(pending).resolves.toMatchObject({ reason: 'error', error: 'spawn ENOENT' })
  })
})

describe('output-log · 落盘', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fizz-spill-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('超预算时写进 .fizz/tool-output 并补 .gitignore', async () => {
    const backend = createLocalBackend(root)
    const text = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n')
    const summary = await summarizeLongOutput(text, { backend, tool: 'execute_command' })
    expect(summary).toContain('.fizz/tool-output/')
    expect(summary).toContain('共 1200 行')
    expect(await fs.readFile(join(root, '.fizz', '.gitignore'), 'utf8')).toBe('*')
    const files = await fs.readdir(join(root, '.fizz', 'tool-output'))
    expect(files).toHaveLength(1)
    expect(await fs.readFile(join(root, '.fizz', 'tool-output', files[0]), 'utf8')).toBe(text)
  })

  it('backend 为 null 时只截断、不落盘', async () => {
    const text = 'x'.repeat(10_000)
    const summary = await summarizeLongOutput(text, { backend: null, tool: 'execute_command' })
    expect(summary).toContain('无法落盘')
    expect(summary.length).toBeLessThan(text.length)
  })
})