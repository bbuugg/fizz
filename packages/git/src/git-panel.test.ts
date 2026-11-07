/**
 * `samePath` 的归一化判据（纯函数，vitest 覆盖）。
 *
 * 用途见 `apps/server/src/api/workspaces/[id]/git/status/route.ts`：判断 `repoRoot()`
 * 返回的仓库根**是不是工作区自己**。临时会话（`scratch`）目录落在数据目录里
 * （`~/.fizz-server/conversations/<会话 id>`），而数据目录常常落在用户主目录 ——
 * 主目录一旦被 `git init` 过（dotfiles 仓库，很常见），`repoRoot()` 就会返回主目录。
 * 那时若把它当仓库，`git status --untracked-files=all` 会在**整个主目录**上枚举未跟踪
 * 文件：面板永远停在「读取仓库状态…」，会话 JSON 还会被列成待提交改动。
 *
 * 所以这条判据错一次的代价是「面板卡死 / 用户把数据目录提交进仓库」，这里钉住它：
 * 1. 同一目录的不同写法（分隔符 / 末尾斜杠 / Windows 大小写）必须算同一个；
 * 2. 形近的兄弟目录不能误判（`/home/a` 与 `/home/ab`）—— 所以不能用 `startsWith`。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  git,
  parseLogOutput,
  parseRemoteV,
  samePath,
  type GitExec
} from './git-panel'

describe('samePath', () => {
  it('同一目录的不同写法算同一个（分隔符 / 末尾斜杠）', () => {
    // Windows 才允许 `\` 作分隔符；POSIX 上 `\` 是合法文件名字符，不能拿它当同义写法
    if (process.platform === 'win32') {
      expect(samePath('C:/Users/a/repo', 'C:\\Users\\a\\repo\\')).toBe(true)
      expect(samePath('C:\\Users\\a\\repo', 'C:/Users/a/repo')).toBe(true)
    } else {
      expect(samePath('/home/a/repo', '/home/a/repo/')).toBe(true)
    }
  })

  it('大小写：Windows 不敏感，其它平台敏感（两个不同目录）', () => {
    const insensitive = process.platform === 'win32'
    expect(samePath('/home/A/repo', '/home/a/repo')).toBe(insensitive)
  })

  it('父子 / 兄弟目录不算同一个', () => {
    expect(samePath('/home/a', '/home/a/repo')).toBe(false)
    expect(samePath('/home/a', '/home/ab')).toBe(false)
  })

  it('相对路径先按 cwd 解析再比（调用方传谁都行，不要求预先 resolve）', () => {
    expect(samePath('.', process.cwd())).toBe(true)
  })
})

/**
 * 远端工作区的 Git 面板把命令原样发到 SSH 主机上跑（见 `apps/server/.../git-exec.ts`），
 * 因此 `git remote -v` / `git log` 的输出要由本包自己解析。这两条在本地链路上也走同一份
 * 解析，所以本地与远端的面板行为不会分叉。
 */
describe('parseRemoteV', () => {
  it('同名远端取 fetch 地址，push 行不覆盖', () => {
    const out = parseRemoteV(
      [
        'origin\thttps://example.com/fetch.git (fetch)',
        'origin\tgit@example.com:push.git (push)',
        'upstream\t/tmp/upstream (fetch)'
      ].join('\n')
    )
    expect(out).toEqual([
      { name: 'origin', url: 'https://example.com/fetch.git' },
      { name: 'upstream', url: '/tmp/upstream' }
    ])
  })

  it('只有 push 行时退回 push 地址；坏行忽略', () => {
    expect(parseRemoteV('origin\t/tmp/only-push (push)\n乱七八糟')).toEqual([
      { name: 'origin', url: '/tmp/only-push' }
    ])
  })

  it('空输出（没配远端）是空列表', () => {
    expect(parseRemoteV('')).toEqual([])
  })
})

describe('parseLogOutput', () => {
  it('按 %x1f 切字段，空行忽略', () => {
    const line =
      'a'.repeat(40) + '\u001f' + 'aaaaaaa' + '\u001f' + '张三' + '\u001f' + '2026-11-07T10:00:00+08:00' + '\u001f' + '修复：登录失败'
    expect(parseLogOutput(`${line}\n\n`)).toEqual([
      {
        hash: 'a'.repeat(40),
        short: 'aaaaaaa',
        author: '张三',
        date: '2026-11-07T10:00:00+08:00',
        subject: '修复：登录失败'
      }
    ])
  })

  it('空仓库（git log 失败时的空 stdout）是空列表', () => {
    expect(parseLogOutput('')).toEqual([])
  })
})

describe('git 的可注入执行层', () => {
  it('传给 git() 的 exec 就是唯一执行入口（远端注入点）', async () => {
    const exec = vi.fn<GitExec>(async () => ({ ok: true, stdout: 'ok', stderr: '' }))
    const res = await git('/srv/app', ['status'], exec)
    expect(exec).toHaveBeenCalledWith('/srv/app', ['status'])
    expect(res).toEqual({ ok: true, stdout: 'ok', stderr: '' })
  })
})
