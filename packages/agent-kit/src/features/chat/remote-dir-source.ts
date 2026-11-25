/**
 * 远端工作区那条路的公用件：SFTP 目录数据源 + 「哪些主机能承载远端目录」。
 *
 * 现在只有命令面板的「连接远端服务器」用得到（选主机 → 选远端目录 → 登记成工作区）；
 * 原先那个 `RemoteWorkspaceDialog` 已经删了 —— 面板里逐级可退，比表单壳更适合「点着选路径」。
 *
 * 为什么仍单独放一处：数据源给的是**工作区根目录**，口径属于业务而不属于某个界面 ——
 * 只列目录（文件选了当不了工作区根）、路径用 SFTP 返回的规范化结果回填（别拿用户敲的
 * 字符串自己拼）、建目录的拼接规则，将来再多一个入口也得用同一份。
 */
import type { DirPickerSource } from '@fizz/agent-kit/shared/components/ServerDirPicker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { HostConfig } from '@fizz/contracts/types'

/**
 * 远端 POSIX 路径的上级目录；`/` 没有上级。
 *
 * 只在远端用（本地那套走 `GET /api/fs/dirs` 返回的 `parent`）。不碰 `path` 的
 * Windows 形态：远端工作区的 `path` 契约上就是 POSIX 绝对路径。
 */
export function remoteParent(path: string): string | null {
  const normalized = path.replace(/\/+$/, '') || '/'
  if (normalized === '/') return null
  const slash = normalized.lastIndexOf('/')
  return slash <= 0 ? '/' : normalized.slice(0, slash)
}

/**
 * 一台 SSH 主机的目录数据源，喂给 `DirectoryBrowser` / `ServerDirPicker` 的 `source`。
 *
 * 每次调用都新建一个对象：放在组件里直接算也没关系 —— 浏览器把 `source` 存在 ref 里，
 * 不参与 `load` 的依赖（否则每帧一个新对象会把请求拖成死循环）。
 */
export function remoteDirSource(app: AgentApp, hostId: string): DirPickerSource {
  return {
    list: async (dir) => {
      /*
        空串 = 「从起点开始」：**起点不能写死 `/`**。

        - Termux / Android 上 `/` 不可读（列出就 EACCES），用户会被迫手敲家目录
          （`/data/data/com.termux/files/home`）才进得去；
        - Windows OpenSSH 的默认目录还是盘符风格（`/C:/…`），`/` 同样不是用户想去的地方。

        和 SFTP 面板的连接逻辑（`SftpPanel.connect`）、拖拽上传的目标初值同一条口径：
        交给服务端 `realpath('.')` 解析成该用户的默认工作目录（通常是家目录）。
        realpath 也失败时仍退回 `/`，让 SFTP 的错误原样报给用户，而不是吞掉。
      */
      let start = dir
      if (!start) {
        try {
          start = await app.sftpRealpath(hostId)
        } catch {
          start = '/'
        }
      }
      const result = await app.sftpList(hostId, start)
      return {
        path: result.path,
        parent: remoteParent(result.path),
        entries: result.entries
          .filter((entry) => entry.isDir)
          .map((entry) => ({ name: entry.name, path: entry.path }))
      }
    },
    mkdir: async (parent, name) => {
      const next = parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`
      await app.sftpMkdir(hostId, next)
      return next
    }
  }
}

/**
 * 能承载远端工作区的主机：排除本机终端条目（`kind: 'local'` 那几条没有远端可言）。
 *
 * 远端工作区弹窗与命令面板的远端主机页共用这一句 —— `filter` 写两处，迟早有一处忘了同步
 * （比如以后加了 `kind: 'wsl'`，远端目录对它不成立）。
 */
export function remoteHostsOf(hosts: HostConfig[]): HostConfig[] {
  return hosts.filter((host) => host.kind !== 'local')
}
