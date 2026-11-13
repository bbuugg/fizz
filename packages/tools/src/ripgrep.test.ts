/**
 * 随包 ripgrep 的**参数构造**基线。
 *
 * 这里只测 argv，不 spawn 进程（仓库约定：单测不起真实进程）。argv 一旦写错，
 * 症状是「搜索永远 0 命中」或「rg 把 `-` 开头的 pattern 当选项」，两者都不会报错，
 * 只会安静地返回空 —— 所以把命令行的形状钉在测试里。
 */
import { describe, expect, it } from 'vitest'
import { buildFindArgs, buildSearchArgs, type RipgrepFindOptions, type RipgrepSearchOptions } from './ripgrep'

const searchOpts: RipgrepSearchOptions = {
  pattern: 'needle',
  caseInsensitive: false,
  root: '/root',
  start: '/root/src',
  maxResults: 250,
  maxFileBytes: 1_048_576
}

const findOpts: RipgrepFindOptions = {
  pattern: '*.ts',
  root: '/root',
  start: '/root',
  includeIgnored: false,
  maxResults: 100
}

describe('buildSearchArgs', () => {
  it('pattern 走 --regexp=，避免以 - 开头的正则被当成选项', () => {
    const args = buildSearchArgs({ ...searchOpts, pattern: '-foo' })
    expect(args).toContain('--regexp=-foo')
    // `--` 之后只跟搜索起点
    expect(args.slice(-2)).toEqual(['--', '/root/src'])
  })

  it('大小写不敏感与 include 各自映射到一个开关', () => {
    const args = buildSearchArgs({ ...searchOpts, caseInsensitive: true, includeGlob: '*.{ts,tsx}' })
    expect(args).toContain('--ignore-case')
    expect(args).toContain('--glob=*.{ts,tsx}')
  })

  it('默认忽略目录翻成 `--glob=!**/<dir>/**`（.git 交给 rg 自己）', () => {
    const args = buildSearchArgs(searchOpts)
    expect(args).toContain('--glob=!**/node_modules/**')
    expect(args).toContain('--glob=!**/dist/**')
    expect(args).not.toContain('--glob=!**/.git/**')
  })

  it('--json 必须开着（解析器只认 JSON 事件）', () => {
    expect(buildSearchArgs(searchOpts)).toContain('--json')
  })
})

describe('buildFindArgs', () => {
  it('默认遵守忽略规则（不带 --no-ignore / --hidden）', () => {
    const args = buildFindArgs(findOpts)
    expect(args).toContain('--files')
    expect(args).toContain('--glob=*.ts')
    expect(args).not.toContain('--no-ignore')
    expect(args).not.toContain('--hidden')
  })

  it('includeIgnored（dsh 的 glob 语义）打开隐藏与被忽略文件，但仍排除版本库元数据', () => {
    const args = buildFindArgs({ ...findOpts, includeIgnored: true })
    expect(args).toContain('--no-ignore')
    expect(args).toContain('--hidden')
    expect(args).toContain('--glob=!**/.git/**')
  })
})
