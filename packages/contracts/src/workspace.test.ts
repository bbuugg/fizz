/**
 * 远端工作区路径与忽略规则的纯函数测试。
 *
 * 这些函数是远端文件操作的权限边界：`resolveInsidePosix` 放行一次越界，
 * Agent 就能读写远端工作区之外的文件；`validateRemoteWorkspacePath` 放行 `..`
 * 会让登记时的路径与后续 `resolve` 的根不是同一个。这里把边界钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  createIgnoreMatcher,
  globToRegExp,
  parseGitignore,
  remoteRelPathOf,
  resolveInsidePosix,
  validateRemoteWorkspacePath
} from './workspace'

describe('resolveInsidePosix', () => {
  it('把相对路径解析到根目录内', () => {
    expect(resolveInsidePosix('/srv/app', 'src/index.ts')).toBe('/srv/app/src/index.ts')
    expect(resolveInsidePosix('/srv/app', '')).toBe('/srv/app')
    expect(resolveInsidePosix('/srv/app', '.')).toBe('/srv/app')
  })

  it('允许根目录自身的绝对路径', () => {
    expect(resolveInsidePosix('/srv/app', '/srv/app/src')).toBe('/srv/app/src')
  })

  it('拒绝 ../ 越界', () => {
    expect(() => resolveInsidePosix('/srv/app', '../etc/passwd')).toThrow('路径越界')
    expect(() => resolveInsidePosix('/srv/app', 'src/../../etc')).toThrow('路径越界')
  })

  it('拒绝绝对路径跳出根目录', () => {
    expect(() => resolveInsidePosix('/srv/app', '/etc/passwd')).toThrow('路径越界')
  })

  it('把反斜杠当普通字符（POSIX 语义）', () => {
    expect(resolveInsidePosix('/srv/app', 'a\\b')).toBe('/srv/app/a\\b')
  })
})

describe('validateRemoteWorkspacePath', () => {
  it('接受绝对路径并规范化多余分隔符', () => {
    expect(validateRemoteWorkspacePath('/srv//app/')).toBe('/srv/app')
    expect(validateRemoteWorkspacePath('/')).toBe('/')
  })

  it('拒绝相对路径与空串', () => {
    expect(() => validateRemoteWorkspacePath('srv/app')).toThrow('绝对路径')
    expect(() => validateRemoteWorkspacePath('   ')).toThrow('不能为空')
  })

  it('拒绝 .. 段与控制字符', () => {
    expect(() => validateRemoteWorkspacePath('/srv/app/../etc')).toThrow('..')
    expect(() => validateRemoteWorkspacePath('/srv/app\nrm -rf /')).toThrow('非法字符')
    expect(() => validateRemoteWorkspacePath('/srv/app\0x')).toThrow('非法字符')
  })
})

describe('remoteRelPathOf', () => {
  it('返回 POSIX 相对路径，根目录为空串', () => {
    expect(remoteRelPathOf('/srv/app', '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(remoteRelPathOf('/srv/app', '/srv/app')).toBe('')
  })
})

describe('createIgnoreMatcher', () => {
  const rules = parseGitignore(
    ['node_modules', '*.log', '!keep.log', '/generated/', 'cache/', 'src/**/tmp'].join('\n')
  )
  const ignored = createIgnoreMatcher(rules)

  it('默认目录规则任意层级生效', () => {
    expect(ignored('node_modules/a.js', false)).toBe(true)
    expect(ignored('packages/x/node_modules/a.js', false)).toBe(true)
  })

  it('支持取反规则', () => {
    expect(ignored('a.log', false)).toBe(true)
    expect(ignored('keep.log', false)).toBe(false)
  })

  it('目录限定规则只拦目录及其子树', () => {
    expect(ignored('cache', true)).toBe(true)
    expect(ignored('cache/a.js', false)).toBe(true)
    expect(ignored('cache', false)).toBe(false)
  })

  it('锚定规则只从根匹配', () => {
    expect(ignored('generated', true)).toBe(true)
    expect(ignored('pkg/generated', true)).toBe(false)
  })

  it('规则不按前缀误伤', () => {
    expect(ignored('src/tmp', true)).toBe(true)
    expect(ignored('src/tmp2', true)).toBe(false)
  })
})

describe('globToRegExp', () => {
  it('单个 * 不跨目录，** 跨目录', () => {
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true)
  })
})