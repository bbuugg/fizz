/**
 * 防「远端工作区目录浏览器从 `/` 起」这条回归。
 *
 * Termux / Android 上 `/` 不可读，一打开就是 permission denied，用户只能手敲家目录
 * （`/data/data/com.termux/files/home`）才能继续；Windows OpenSSH 的默认目录同样是
 * 盘符风格路径。起点必须交给服务端 `realpath('.')`（与 SFTP 面板、拖拽上传同一口径）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { SftpEntry } from '@fizz/contracts/agent-api'
import { remoteDirSource, remoteParent } from './remote-dir-source'

const TERMUX_HOME = '/data/data/com.termux/files/home'

function makeApp(opts: { home?: string; realpathFails?: boolean } = {}) {
  const sftpRealpath = vi.fn(async () => {
    if (opts.realpathFails) throw new Error('realpath 不支持')
    return opts.home ?? TERMUX_HOME
  })
  const sftpList = vi.fn(async (_hostId: string, path: string) => {
    const entries: SftpEntry[] = [
      { name: 'proj', path: `${path}/proj`, isDir: true, size: 0, mtime: 0 },
      { name: 'a.txt', path: `${path}/a.txt`, isDir: false, size: 3, mtime: 0 }
    ]
    return { path, entries }
  })
  const app = { sftpRealpath, sftpList, sftpMkdir: vi.fn() } as unknown as AgentApp
  return { app, sftpRealpath, sftpList }
}

describe('remoteDirSource', () => {
  it('空路径 = 起点：先用 realpath 解析家目录，再从家目录列', async () => {
    const { app, sftpRealpath, sftpList } = makeApp()
    const listing = await remoteDirSource(app, 'host-1').list('')

    expect(sftpRealpath).toHaveBeenCalledWith('host-1')
    expect(sftpList).toHaveBeenCalledWith('host-1', TERMUX_HOME)
    expect(listing.path).toBe(TERMUX_HOME)
    // 只留目录：文件选了当不了工作区根
    expect(listing.entries).toEqual([{ name: 'proj', path: `${TERMUX_HOME}/proj` }])
  })

  it('用户给了明确路径时不再绕 realpath', async () => {
    const { app, sftpRealpath, sftpList } = makeApp()
    await remoteDirSource(app, 'host-1').list('/sdcard')

    expect(sftpRealpath).not.toHaveBeenCalled()
    expect(sftpList).toHaveBeenCalledWith('host-1', '/sdcard')
  })

  it('realpath 失败时退回 `/`，让 SFTP 的错误原样报给用户', async () => {
    const { app, sftpList } = makeApp({ realpathFails: true })
    await remoteDirSource(app, 'host-1').list('')

    expect(sftpList).toHaveBeenCalledWith('host-1', '/')
  })
})

describe('remoteParent', () => {
  it('去掉尾斜杠后取上一级', () => {
    expect(remoteParent(`${TERMUX_HOME}/`)).toBe('/data/data/com.termux/files')
  })

  it('根没有上一级', () => {
    expect(remoteParent('/')).toBeNull()
    expect(remoteParent('///')).toBeNull()
  })

  it('一级目录的上一级是根', () => {
    expect(remoteParent('/home')).toBe('/')
  })
})
