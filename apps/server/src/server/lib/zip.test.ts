/**
 * `zipRemoteDirectory` 的回归测试。
 *
 * 这条路径只在**远端工作区**「下载文件夹」时走：本地那份用 `node:fs` 递归，远端这边
 * 只能经 `WorkspaceBackend`（SFTP）逐层列目录。这里用内存后端验证三件事：
 * 目录条目齐全（空目录解出来不会消失）、忽略规则整棵子树跳过、符号链接不进包
 * （跟进去可能成环，远端尤其容易踩）。
 */
import { describe, expect, it } from 'vitest'
import type {
  WorkspaceBackend,
  WorkspaceDirEntry,
  WorkspaceStat
} from '@fizz/contracts/workspace'
import { readZip, zipRemoteDirectory } from './zip'

type FakeNode = { type: 'dir' | 'file' | 'symlink'; data?: Buffer }

/** POSIX 的简单 join / basename（远端 backend 的语义，不碰 Windows 分隔符） */
function joinPosix(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/(.)\/+$/, '$1')
}

function basenamePosix(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? ''
}

function fakeRemoteBackend(tree: Map<string, FakeNode>): WorkspaceBackend {
  const statOf = (p: string): WorkspaceStat | null => {
    const node = tree.get(p)
    if (!node) return null
    return {
      type: node.type,
      size: node.data?.length ?? 0,
      mtimeMs: 0
    }
  }
  const notImplemented = async (): Promise<never> => {
    throw new Error('这条测试用不到')
  }

  return {
    kind: 'remote',
    root: '/ws',
    resolve: (p) => (p.startsWith('/') ? p : joinPosix('/ws', p)),
    rel: (abs) => abs.replace(/^\/ws\/?/, ''),
    join: joinPosix,
    dirname: (p) => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/',
    basename: basenamePosix,
    stat: async (p) => statOf(p),
    readDir: async (p): Promise<WorkspaceDirEntry[]> => {
      const prefix = `${p.replace(/\/+$/, '')}/`
      const out: WorkspaceDirEntry[] = []
      for (const [key, node] of tree) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        out.push({ name: rest, type: node.type, size: node.data?.length })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    readFile: async (p, opts) => {
      const node = tree.get(p)
      if (!node?.data) throw new Error(`ENOENT: ${p}`)
      if (opts?.maxBytes !== undefined && node.data.length > opts.maxBytes) {
        throw new Error('文件过大')
      }
      return node.data
    },
    writeFile: notImplemented,
    mkdirp: notImplemented,
    remove: notImplemented,
    rename: notImplemented,
    ignoreChecker: async () => () => false,
    search: notImplemented,
    find: notImplemented,
    exec: notImplemented
  }
}

function sampleTree(): Map<string, FakeNode> {
  return new Map<string, FakeNode>([
    ['/ws/project', { type: 'dir' }],
    ['/ws/project/a.txt', { type: 'file', data: Buffer.from('hello') }],
    ['/ws/project/sub', { type: 'dir' }],
    ['/ws/project/sub/b.txt', { type: 'file', data: Buffer.from('世界') }],
    ['/ws/project/node_modules', { type: 'dir' }],
    ['/ws/project/node_modules/skip.txt', { type: 'file', data: Buffer.from('x') }],
    ['/ws/project/link.txt', { type: 'symlink' }]
  ])
}

describe('zipRemoteDirectory', () => {
  it('逐层走远端目录：顶层目录条目 + 嵌套文件都在，符号链接不进包', async () => {
    const backend = fakeRemoteBackend(sampleTree())
    const { buffer, skipped } = await zipRemoteDirectory(backend, '/ws/project')

    // readZip 会丢掉以 '/' 结尾的目录条目，所以这里只看到文件（默认没有忽略规则，
    // 遍历顺序 = readDir 的名字序：a.txt → node_modules → sub）
    const files = readZip(buffer).map((f) => ({ name: f.name, text: f.data.toString('utf8') }))
    expect(files).toEqual([
      { name: 'project/a.txt', text: 'hello' },
      { name: 'project/node_modules/skip.txt', text: 'x' },
      { name: 'project/sub/b.txt', text: '世界' }
    ])
    // 符号链接是静默跳过（既不算「忽略」也不算超限）
    expect(skipped).toBe(0)
  })

  it('空目录也写目录条目，解压后不会消失', async () => {
    const tree = sampleTree()
    tree.set('/ws/project/empty', { type: 'dir' })
    const backend = fakeRemoteBackend(tree)
    const { buffer } = await zipRemoteDirectory(backend, '/ws/project')

    // 用中央目录里的原始名字验证（readZip 会把目录条目过滤掉）
    expect(buffer.toString('utf8')).toContain('project/empty/')
  })

  it('ignore 命中整棵子树跳过，并上报 skipped', async () => {
    const backend = fakeRemoteBackend(sampleTree())
    const skippedNames: string[] = []
    const { buffer, skipped } = await zipRemoteDirectory(backend, '/ws/project', {
      ignore: (abs) => abs.endsWith('/node_modules'),
      onSkip: (_reason, name) => skippedNames.push(name)
    })

    const files = readZip(buffer).map((f) => f.name)
    expect(files).not.toContain('project/node_modules/skip.txt')
    expect(skipped).toBe(1)
    expect(skippedNames).toEqual(['project/node_modules'])
  })

  it('超过单文件上限的跳过，并上报 too-large', async () => {
    const backend = fakeRemoteBackend(sampleTree())
    const reported: Array<[string, string]> = []
    // 上限设成 0：树里每个文件都非空，全都会被跳过
    const { buffer } = await zipRemoteDirectory(backend, '/ws/project', {
      maxFileBytes: 0,
      onSkip: (reason, name) => reported.push([reason, name])
    })

    expect(readZip(buffer)).toEqual([])
    expect(reported).toEqual([
      ['too-large', 'project/a.txt'],
      ['too-large', 'project/node_modules/skip.txt'],
      ['too-large', 'project/sub/b.txt']
    ])
  })

  it('根目录不存在 / 不是目录时抛人话错误', async () => {
    const backend = fakeRemoteBackend(sampleTree())
    await expect(zipRemoteDirectory(backend, '/ws/missing')).rejects.toThrow('文件夹不存在')
    await expect(zipRemoteDirectory(backend, '/ws/project/a.txt')).rejects.toThrow('不是文件夹')
  })
})
