/**
 * 防回归：三平台 profile 的拼接形状。
 *
 * 这里断言的是「参数长什么样」而不是「沙箱真的挡住了」—— 真机验证另做（不起真 runner）。
 * 关键回归点是 bwrap 的挂载顺序（先整根只读，再开写口）与 Seatbelt 的 SBPL 转义：
 * 顺序反了会把 `--ro-bind / /` 盖掉工作区的可写绑定；转义漏了会让带引号的路径直接
 * 把 profile 拼坏。
 */
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  bwrapProfileArgs,
  canonicalPath,
  seatbeltProfileArgs,
  writableRoots
} from './profiles'

const ROOT = '/work/space'

describe('bwrapProfileArgs', () => {
  it('read-only 只挂只读根，不开任何写口', () => {
    const args = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: ROOT })
    expect(args).toContain('--ro-bind')
    expect(args).not.toContain('--bind')
    expect(args).not.toContain('--tmpfs')
    // 少了它，宿主被强杀后沙箱里的命令会变成孤儿
    expect(args).toContain('--die-with-parent')
  })

  it('workspace-write 在只读根之后追加 /tmp 与工作区绑定', () => {
    const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: ROOT })
    const roBind = args.indexOf('--ro-bind')
    const tmpfs = args.indexOf('--tmpfs')
    const bind = args.indexOf('--bind')
    expect(roBind).toBeGreaterThanOrEqual(0)
    // 顺序错了工作区就还是只读
    expect(tmpfs).toBeGreaterThan(roBind)
    expect(bind).toBeGreaterThan(tmpfs)
    expect(args.slice(bind, bind + 3)).toEqual(['--bind', ROOT, ROOT])
  })
})

describe('writableRoots', () => {
  it('read-only 不开放任何写口', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: ROOT })).toEqual([])
  })

  it('workspace-write 去重后包含工作区与临时目录', () => {
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ROOT }, '/var/tmp/fizz-test')
    expect(roots).toContain(canonicalPath(ROOT))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(canonicalPath('/var/tmp/fizz-test'))
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('默认临时目录取 os.tmpdir()', () => {
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ROOT })
    expect(roots).toContain(canonicalPath(tmpdir()))
  })
})

describe('seatbeltProfileArgs', () => {
  it('先全量放开再只禁写入，最后按 subpath 放开工作区', () => {
    const [, profile] = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: ROOT }, '/tmp/fizz-x')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(allow default)')
    expect(profile).toContain(`(subpath "${ROOT}")`)
    // /dev/null 必须单独放行，否则 bash 连重定向都做不了
    expect(profile).toContain('(literal "/dev/null")')
  })

  it('read-only 不产生任何 subpath 允许', () => {
    const [, profile] = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: ROOT })
    expect(profile).not.toContain('(subpath')
  })

  it('路径里的引号与反斜杠会被转义，不会拼坏 profile', () => {
    const [, profile] = seatbeltProfileArgs(
      { mode: 'workspace-write', workspaceRoot: '/work/"weird"\\path' },
      '/tmp/fizz-x'
    )
    expect(profile).toContain('(subpath "/work/\\"weird\\"\\\\path")')
  })
})
