/**
 * 远端搜索 / 查找的命令构造与输出解析。
 *
 * 防的回归：路径 / 模式里的空格、冒号、引号把 `rg`、`grep -Z`、`find -print0` 的输出
 * 切错（这正是远端搜索最容易静默出错的地方）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildFindCommand,
  buildGrepCommand,
  buildRgCommand,
  isMissingRipgrep,
  normalizeRemoteRel,
  parseFindNull,
  parseGrepZ,
  parseRgJson
} from './remote-search-parse'

const base = { pattern: 'needle', caseInsensitive: false, subPath: '', context: 0, maxFileBytes: 1024 }

describe('buildRgCommand', () => {
  it('走 --json，默认排除忽略目录，参数都加引号', () => {
    const cmd = buildRgCommand(base)
    expect(cmd).toContain(`'rg' '--json' '--hidden' '--no-config' '--line-number'`)
    expect(cmd).toContain(`'--glob' '!**/node_modules/**'`)
    expect(cmd).toContain(`'--glob' '!**/.git/**'`)
    expect(cmd).toContain(`'--' 'needle' '.'`)
    expect(cmd.startsWith('LC_ALL=C ')).toBe(true)
  })

  it('大小写不敏感 / 上下文 / 子路径都带进去', () => {
    const cmd = buildRgCommand({
      ...base,
      caseInsensitive: true,
      context: 2,
      subPath: 'src dir',
      maxFileBytes: 2048
    })
    expect(cmd).toContain(`'-i'`)
    expect(cmd).toContain(`'--context' '2'`)
    expect(cmd).toContain(`'src dir'`)
    expect(cmd).toContain(`'--max-filesize' '2048'`)
  })
})

describe('buildGrepCommand', () => {
  it('用 -Z 让文件名以 NUL 结尾，并排除忽略目录', () => {
    const cmd = buildGrepCommand({ ...base, subPath: 'src' })
    expect(cmd).toContain(`'grep' '-rIZnE'`)
    expect(cmd).toContain(`'--binary-files=without-match'`)
    expect(cmd).toContain(`'--exclude-dir' 'node_modules'`)
    expect(cmd).toContain(`'--' 'needle' 'src'`)
  })
})

describe('buildFindCommand', () => {
  it('先剪掉忽略目录，再输出文件，NUL 分隔', () => {
    const cmd = buildFindCommand('src')
    expect(cmd.startsWith(`find 'src'`)).toBe(true)
    expect(cmd).toContain(`\\( -type d \\(`)
    expect(cmd).toContain(`-name 'node_modules'`)
    expect(cmd).toContain(`-name '.git'`)
    expect(cmd).toContain(`\\) -prune \\) -o -type f -print0`)
  })

  it('空子路径从 . 开始', () => {
    expect(buildFindCommand('')).toContain(`find '.'`)
  })
})

describe('normalizeRemoteRel', () => {
  it('去掉 ./ 与前导斜杠，统一正斜杠', () => {
    expect(normalizeRemoteRel('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeRemoteRel('/src/a.ts')).toBe('src/a.ts')
    expect(normalizeRemoteRel('.\\src\\a.ts')).toBe('src/a.ts')
  })
})

describe('parseRgJson', () => {
  it('只取 match / context，忽略 begin / summary', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: './src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: './src/a.ts' }, line_number: 2, lines: { text: 'needle here\n' } }
      }),
      JSON.stringify({
        type: 'context',
        data: { path: { text: './src/a.ts' }, line_number: 3, lines: { text: 'after\n' } }
      }),
      JSON.stringify({ type: 'summary', data: {} }),
      ''
    ].join('\n')
    expect(parseRgJson(stdout)).toEqual([
      { file: 'src/a.ts', line: 2, text: 'needle here', hit: true },
      { file: 'src/a.ts', line: 3, text: 'after', hit: false }
    ])
  })

  it('坏行直接跳过', () => {
    expect(parseRgJson('not json\n{"type":"match"}\n')).toEqual([])
  })
})

describe('parseGrepZ', () => {
  it('文件名是 NUL 结尾，路径里的空格 / 冒号不会切错', () => {
    const stdout =
      './src/a b.ts\0' +
      '12:needle one\n' +
      './src/a b.ts\0' +
      '15:needle two\n'
    expect(parseGrepZ(stdout)).toEqual([
      { file: 'src/a b.ts', line: 12, text: 'needle one', hit: true },
      { file: 'src/a b.ts', line: 15, text: 'needle two', hit: true }
    ])
  })

  it('没有换行结尾的最后一条也能解析', () => {
    expect(parseGrepZ('./a.ts\0' + '7:tail')).toEqual([
      { file: 'a.ts', line: 7, text: 'tail', hit: true }
    ])
  })
})

describe('parseFindNull', () => {
  it('NUL 分隔，路径原样保留空格', () => {
    expect(parseFindNull('./src/a b.ts\0./c.ts\0')).toEqual(['src/a b.ts', 'c.ts'])
  })
})

describe('isMissingRipgrep', () => {
  it('退出码 127 或明确的 not found 都算缺失', () => {
    expect(isMissingRipgrep(127, '')).toBe(true)
    expect(isMissingRipgrep(1, 'sh: rg: command not found')).toBe(true)
    expect(isMissingRipgrep(1, 'bash: rg: not found')).toBe(true)
  })

  it('普通无匹配 / 正则错误不算缺失', () => {
    expect(isMissingRipgrep(1, '')).toBe(false)
    expect(isMissingRipgrep(2, 'regex parse error')).toBe(false)
  })
})