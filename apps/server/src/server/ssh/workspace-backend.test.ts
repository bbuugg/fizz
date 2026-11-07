/**
 * 远端 `WorkspaceBackend` 的映射与搜索语义（mock SFTP / exec，不连真实主机）。
 *
 * 防的回归：
 * - 工具拿到的路径 / 类型 / 大小与本地 backend 同形（模型不该感到「本地 / 远端」差异）；
 * - 搜索优先 rg、缺失时回退 grep，忽略规则与文件名过滤在 JS 侧二次应用；
 * - 显式点名文件时绕过忽略规则（与本地一致）；
 * - `.gitignore` 按 mtime:size 缓存，改了要失效。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sftpMock, execMock } = vi.hoisted(() => ({
  sftpMock: {
    stat: vi.fn(),
    list: vi.fn(),
    readFile: vi.fn(),
    writeBuffer: vi.fn(),
    mkdirs: vi.fn(),
    removePath: vi.fn(),
    rename: vi.fn()
  },
  execMock: { exec: vi.fn() }
}))

vi.mock('./sftp', () => ({ sftpService: sftpMock }))
vi.mock('./exec', () => ({ remoteExecService: execMock }))

import { createRemoteBackend } from './workspace-backend'

function rgLine(type: 'match' | 'context', file: string, line: number, text: string): string {
  return JSON.stringify({
    type,
    data: { path: { text: file }, line_number: line, lines: { text: `${text}\n` } }
  })
}

function execResult(over: Partial<{
  stdout: string
  stderr: string
  exitCode: number | null
  reason: 'exit' | 'timeout' | 'aborted' | 'error'
  truncated: boolean
}> = {}) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    reason: 'exit' as const,
    truncated: false,
    ...over
  }
}

const searchBase = {
  pattern: 'needle',
  caseInsensitive: false,
  subPath: '',
  context: 0,
  maxResults: 200,
  maxFileBytes: 1000,
  ignore: () => false
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('路径与元信息', () => {
  it('resolve / rel / join 都按 POSIX 语义，越界抛错', () => {
    const backend = createRemoteBackend('h1', '/srv/app')
    expect(backend.kind).toBe('remote')
    expect(backend.root).toBe('/srv/app')
    expect(backend.resolve('src/a.ts')).toBe('/srv/app/src/a.ts')
    expect(() => backend.resolve('../etc/passwd')).toThrow(/越界/)
    expect(() => backend.resolve('/etc/passwd')).toThrow(/越界/)
    expect(backend.rel('/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(backend.join('/srv/app', 'src', 'a.ts')).toBe('/srv/app/src/a.ts')
    expect(backend.dirname('/srv/app/src/a.ts')).toBe('/srv/app/src')
    expect(backend.basename('/srv/app/src/a.ts')).toBe('a.ts')
  })

  it('stat / readDir 映射成工具认识的形状', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'file', size: 12, mtimeMs: 99 })
    sftpMock.list.mockResolvedValue([
      { name: 'src', path: '/srv/app/src', isDir: true, size: 0, mtime: 0 },
      { name: 'a.txt', path: '/srv/app/a.txt', isDir: false, size: 3, mtime: 0 }
    ])
    const backend = createRemoteBackend('h1', '/srv/app')
    await expect(backend.stat('/srv/app/a.txt')).resolves.toEqual({
      type: 'file',
      size: 12,
      mtimeMs: 99
    })
    await expect(backend.readDir('/srv/app')).resolves.toEqual([
      { name: 'src', type: 'dir' },
      { name: 'a.txt', type: 'file', size: 3 }
    ])
  })

  it('stat 不存在返回 null', async () => {
    sftpMock.stat.mockResolvedValue(null)
    await expect(createRemoteBackend('h1', '/srv/app').stat('/srv/app/x')).resolves.toBeNull()
  })

  it('读写 / 建目录 / 删除 / 重命名都带 hostId 透传', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'file', size: 1 })
    sftpMock.readFile.mockResolvedValue(Buffer.from('x'))
    const backend = createRemoteBackend('h1', '/srv/app')
    await backend.readFile('/srv/app/a.txt', { maxBytes: 10 })
    await backend.writeFile('/srv/app/a.txt', 'x', { atomic: true })
    await backend.mkdirp('/srv/app/dir')
    await backend.remove('/srv/app/a.txt', { recursive: false, force: true })
    await backend.rename('/srv/app/a.txt', '/srv/app/b.txt')
    expect(sftpMock.readFile).toHaveBeenCalledWith('h1', '/srv/app/a.txt', { maxBytes: 10 })
    expect(sftpMock.writeBuffer).toHaveBeenCalledWith('h1', '/srv/app/a.txt', 'x', {
      atomic: true
    })
    expect(sftpMock.mkdirs).toHaveBeenCalledWith('h1', '/srv/app/dir')
    expect(sftpMock.removePath).toHaveBeenCalledWith('h1', '/srv/app/a.txt', {
      recursive: false,
      force: true
    })
    expect(sftpMock.rename).toHaveBeenCalledWith('h1', '/srv/app/a.txt', '/srv/app/b.txt')
  })
})

describe('ignoreChecker', () => {
  it('读远端 .gitignore，按 mtime:size 缓存，变了就重新读', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'file', size: 8, mtimeMs: 1 })
    sftpMock.readFile.mockResolvedValue(Buffer.from('dist/\n*.log\n'))
    const backend = createRemoteBackend('h-cache', '/srv/cache')

    const ignore = await backend.ignoreChecker()
    expect(ignore('dist/a.ts', false)).toBe(true)
    expect(ignore('logs/a.log', false)).toBe(true)
    expect(ignore('src/a.ts', false)).toBe(false)
    expect(sftpMock.readFile).toHaveBeenCalledTimes(1)

    await backend.ignoreChecker()
    expect(sftpMock.readFile).toHaveBeenCalledTimes(1)

    sftpMock.stat.mockResolvedValue({ type: 'file', size: 9, mtimeMs: 2 })
    await backend.ignoreChecker()
    expect(sftpMock.readFile).toHaveBeenCalledTimes(2)
  })

  it('没有 .gitignore 时只用默认忽略目录', async () => {
    sftpMock.stat.mockResolvedValue(null)
    const ignore = await createRemoteBackend('h-none', '/srv/none').ignoreChecker()
    expect(ignore('node_modules/a.js', false)).toBe(true)
    expect(ignore('src/a.ts', false)).toBe(false)
    expect(sftpMock.readFile).not.toHaveBeenCalled()
  })
})

describe('search', () => {
  it('rg 命中的文件按路径排序，忽略规则与命中上限生效', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'dir', size: 0 })
    execMock.exec.mockResolvedValue(
      execResult({
        stdout: [
          rgLine('match', './src/b.ts', 5, 'needle two'),
          rgLine('match', './src/a.ts', 2, 'needle one'),
          rgLine('match', './dist/c.ts', 1, 'needle ignored')
        ].join('\n')
      })
    )
    const backend = createRemoteBackend('h1', '/srv/app')
    const files = await backend.search({
      ...searchBase,
      subPath: 'src',
      maxResults: 2,
      ignore: (rel) => rel.startsWith('dist/')
    })
    expect(files).toEqual([
      { file: 'src/a.ts', hits: [{ line: 2, text: 'needle one' }] },
      { file: 'src/b.ts', hits: [{ line: 5, text: 'needle two' }] }
    ])
    expect(execMock.exec).toHaveBeenCalledWith(
      'h1',
      expect.stringContaining(`'rg'`),
      { cwd: '/srv/app' }
    )
  })

  it('filePattern 按文件名过滤，context 只围绕选中的命中重建', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'dir', size: 0 })
    execMock.exec.mockResolvedValue(
      execResult({
        stdout: [
          rgLine('context', './src/a.ts', 1, 'before'),
          rgLine('match', './src/a.ts', 2, 'needle one'),
          rgLine('context', './src/a.ts', 3, 'after'),
          rgLine('match', './src/a.ts', 4, 'needle two'),
          rgLine('match', './src/a.md', 9, 'needle markdown')
        ].join('\n')
      })
    )
    const backend = createRemoteBackend('h1', '/srv/app')
    const files = await backend.search({
      ...searchBase,
      context: 1,
      filePattern: '\\.ts$'
    })
    expect(files).toEqual([
      {
        file: 'src/a.ts',
        hits: [
          { line: 2, text: 'needle one' },
          { line: 4, text: 'needle two' }
        ],
        context: [
          { line: 1, text: 'before', hit: false },
          { line: 2, text: 'needle one', hit: true },
          { line: 3, text: 'after', hit: false },
          { line: 4, text: 'needle two', hit: true }
        ]
      }
    ])
  })

  it('显式点名文件时绕过忽略规则（与本地一致）', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'file', size: 10 })
    execMock.exec.mockResolvedValue(
      execResult({ stdout: rgLine('match', './src/a.ts', 1, 'needle') })
    )
    const files = await createRemoteBackend('h1', '/srv/app').search({
      ...searchBase,
      subPath: 'src/a.ts',
      ignore: () => true
    })
    expect(files).toEqual([{ file: 'src/a.ts', hits: [{ line: 1, text: 'needle' }] }])
  })

  it('没有 rg 时回退 grep，并按需读文件补上下文', async () => {
    sftpMock.stat.mockImplementation(async (_host: string, path: string) => {
      if (path === '/srv/app' || path === '/srv/app/src') return { type: 'dir', size: 0 }
      if (path === '/srv/app/src/a.ts') return { type: 'file', size: 20 }
      return null
    })
    sftpMock.readFile.mockResolvedValue(Buffer.from('one\nneedle\nthree\n'))
    execMock.exec
      .mockResolvedValueOnce(execResult({ exitCode: 127, stderr: 'sh: rg: command not found' }))
      .mockResolvedValueOnce(execResult({ stdout: './src/a.ts\0' + '2:needle\n' }))

    const files = await createRemoteBackend('h1', '/srv/app').search({
      ...searchBase,
      subPath: 'src',
      context: 1
    })
    expect(files).toEqual([
      {
        file: 'src/a.ts',
        hits: [{ line: 2, text: 'needle' }],
        context: [
          { line: 1, text: 'one', hit: false },
          { line: 2, text: 'needle', hit: true },
          { line: 3, text: 'three', hit: false }
        ]
      }
    ])
    expect(execMock.exec).toHaveBeenCalledTimes(2)
    expect(execMock.exec.mock.calls[1][1]).toContain(`'grep'`)
  })

  it('路径不存在时明确报错', async () => {
    sftpMock.stat.mockResolvedValue(null)
    await expect(
      createRemoteBackend('h1', '/srv/app').search({ ...searchBase, subPath: 'missing' })
    ).rejects.toThrow(/路径不存在/)
  })

  it('rg 报错（退出码 2）时把远端 stderr 带回来', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'dir', size: 0 })
    execMock.exec.mockResolvedValue(execResult({ exitCode: 2, stderr: 'regex parse error' }))
    await expect(
      createRemoteBackend('h1', '/srv/app').search(searchBase)
    ).rejects.toThrow(/regex parse error/)
  })
})

describe('find', () => {
  it('NUL 分隔解析后按 glob / 忽略 / 上限过滤并排序', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'dir', size: 0 })
    execMock.exec.mockResolvedValue(
      execResult({ stdout: './src/deep/d.ts\0./dist/b.ts\0./src/c.md\0./src/a.ts\0' })
    )
    const out = await createRemoteBackend('h1', '/srv/app').find({
      pattern: '*.ts',
      subPath: '',
      maxResults: 200,
      ignore: (rel) => rel.startsWith('dist/')
    })
    expect(out).toEqual(['src/a.ts', 'src/deep/d.ts'])
    expect(execMock.exec.mock.calls[0][1]).toContain(`find '.'`)
  })

  it('显式点名文件时只检查它本身', async () => {
    sftpMock.stat.mockResolvedValue({ type: 'file', size: 1 })
    const out = await createRemoteBackend('h1', '/srv/app').find({
      pattern: '*.ts',
      subPath: 'src/a.ts',
      maxResults: 200,
      ignore: () => true
    })
    expect(out).toEqual(['src/a.ts'])
    expect(execMock.exec).not.toHaveBeenCalled()
  })
})

describe('exec', () => {
  it('执行目录落在工作区内，原样透传给执行服务', async () => {
    execMock.exec.mockResolvedValue(execResult({ stdout: 'ok' }))
    const backend = createRemoteBackend('h1', '/srv/app')
    await expect(backend.exec('ls', { cwd: '/srv/app/src' })).resolves.toMatchObject({
      stdout: 'ok'
    })
    expect(execMock.exec).toHaveBeenCalledWith('h1', 'ls', { cwd: '/srv/app/src' })
  })

  it('执行目录越界直接拒绝，不会发到远端', async () => {
    const backend = createRemoteBackend('h1', '/srv/app')
    await expect(backend.exec('ls', { cwd: '/etc' })).rejects.toThrow(/越界/)
    expect(execMock.exec).not.toHaveBeenCalled()
  })
})