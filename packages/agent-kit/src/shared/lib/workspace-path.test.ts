/**
 * `workspaceRelativePath` 的回归用例。
 *
 * 防的是「点工具卡里的文件名 → 文件面板里打开」这条链路的**路径归一化**：
 * 模型给的 `file_path` 绝对 / 相对都可能有，而文件面板只认工作区相对路径。
 * 归一错了的表现是「点一下报路径不存在」或「打开的是另一个同名文件」—— 都不报错、很难查，
 * 所以把各种形状钉在这里。
 */
import { describe, expect, it } from 'vitest'
import { isAbsoluteFilePath, workspaceRelativePath } from './workspace-path'

describe('workspaceRelativePath', () => {
  it('相对路径原样保留', () => {
    expect(workspaceRelativePath('src/parts.ts', '/repo')).toBe('src/parts.ts')
  })

  it('去掉 `./` 前缀', () => {
    expect(workspaceRelativePath('./src/parts.ts', '/repo')).toBe('src/parts.ts')
  })

  it('Windows 相对路径的分隔符换成 `/`', () => {
    expect(workspaceRelativePath('src\\parts.ts', 'D:\\repo')).toBe('src/parts.ts')
  })

  it('POSIX 绝对路径按工作区根削掉前缀', () => {
    expect(workspaceRelativePath('/repo/src/parts.ts', '/repo')).toBe('src/parts.ts')
  })

  it('Windows 绝对路径按工作区根削掉前缀', () => {
    expect(workspaceRelativePath('D:\\repo\\src\\parts.ts', 'D:\\repo')).toBe('src/parts.ts')
  })

  it('盘符大小写不一致也认得（Windows 不敏感）', () => {
    expect(workspaceRelativePath('d:/Repo/src/parts.ts', 'D:\\repo')).toBe('src/parts.ts')
  })

  it('根目录带尾部分隔符不影响比对', () => {
    expect(workspaceRelativePath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(workspaceRelativePath('D:\\repo\\a.ts', 'D:\\repo\\')).toBe('a.ts')
  })

  it('路径带尾部分隔符也认得', () => {
    expect(workspaceRelativePath('/repo/src/a.ts/', '/repo')).toBe('src/a.ts')
  })

  it('盘符根目录（`D:`）也能切', () => {
    expect(workspaceRelativePath('D:/repo/a.ts', 'D:')).toBe('repo/a.ts')
  })

  it('工作区之外的绝对路径 → null（不做成可点）', () => {
    expect(workspaceRelativePath('/etc/hosts', '/repo')).toBeNull()
    expect(workspaceRelativePath('D:\\other\\a.ts', 'D:\\repo')).toBeNull()
  })

  it('只是前缀相同的兄弟目录不算子路径', () => {
    expect(workspaceRelativePath('/repo2/a.ts', '/repo')).toBeNull()
  })

  it('根目录本身不是文件 → null', () => {
    expect(workspaceRelativePath('/repo', '/repo')).toBeNull()
    expect(workspaceRelativePath('D:\\repo', 'D:\\repo')).toBeNull()
  })

  it('不知道根目录时只认相对路径', () => {
    expect(workspaceRelativePath('src/a.ts', '')).toBe('src/a.ts')
    expect(workspaceRelativePath('/repo/src/a.ts', '')).toBeNull()
  })

  it('空串 / `.` → null', () => {
    expect(workspaceRelativePath('', '/repo')).toBeNull()
    expect(workspaceRelativePath('   ', '/repo')).toBeNull()
    expect(workspaceRelativePath('.', '/repo')).toBeNull()
  })
})

describe('isAbsoluteFilePath', () => {
  it('三种绝对路径都认', () => {
    expect(isAbsoluteFilePath('/a/b')).toBe(true)
    expect(isAbsoluteFilePath('C:\\a')).toBe(true)
    expect(isAbsoluteFilePath('//server/share')).toBe(true)
  })

  it('相对路径不算', () => {
    expect(isAbsoluteFilePath('a/b')).toBe(false)
    expect(isAbsoluteFilePath('./a')).toBe(false)
    expect(isAbsoluteFilePath('C:')).toBe(false)
  })
})
