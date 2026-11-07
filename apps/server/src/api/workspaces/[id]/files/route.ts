/**
 * 工作区文件树：列目录 + 文件夹打包下载。
 * GET /api/workspaces/:id/files?dir=相对路径[&ignored=1][&zip=相对路径]
 *
 * 文件操作一律走 `WorkspaceBackend`：本地是 fs，远端工作区是 SFTP。路由只认 backend
 * 的路径语义（`resolve` 负责越界检查，rel 统一 '/'），所以远端目录不用在本机先镜像。
 */
import type { AgentFsEntry } from '@fizz/contracts/types'
import { domain } from '@/lib/server/state'
import { workspaceFilesBackend } from '@/lib/workspace-files'
import { jsonError } from '@/app/api/_lib/auth'
import { zipDirectory, zipRemoteDirectory } from '@/lib/server/lib/zip'

const MAX_ENTRIES = 2000

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const backend = workspaceFilesBackend(workspace)
  const url = new URL(request.url)
  // `?zip=<rel>`：把某个文件夹打包成 zip 直接吐出来（文件视图的「下载文件夹」）。
  // 与下面「列目录」是同一资源（工作区的文件）的两种表示，所以共用这条路由、不另开一条。
  const zipPath = url.searchParams.get('zip')
  if (zipPath !== null) return zipFolder(backend, workspace.remote !== undefined, zipPath)
  const dir = url.searchParams.get('dir') ?? ''
  /**
   * `?ignored=1`：**连命中忽略规则的条目也一起列**（文件树的「显示被忽略」开关）。
   *
   * 默认过滤是给 Agent 的 `list_files` / `search_files` 准备的（别把 node_modules 翻成
   * 上下文），但人翻文件时经常就是要去 .env / vendor / dist 里看一眼 —— 从前这条路
   * 在界面上是**不存在**的，用户只能得出「我文件不见了」。打开这个开关时条目会带
   * `ignored: true`，由界面压暗，两边都不含糊。
   */
  const includeIgnored = url.searchParams.get('ignored') === '1'
  let abs: string
  try {
    abs = backend.resolve(dir)
  } catch {
    return jsonError(403, '路径越界')
  }
  const ignore = await backend.ignoreChecker()
  const dirents = await backend.readDir(abs)
  const entries: AgentFsEntry[] = []
  let truncated = false
  for (const d of dirents) {
    /**
     * `dir` / `file` 直接用；`symlink`（以及本地后端报的 `other`）补一次 `stat`
     * （**跟随链接**）问出真实类型 —— 软链到目录的条目要能点进去。断链（目标不存在）
     * 时按普通文件列出，至少让用户看得见它在那儿，而不是凭空消失。
     */
    let type: AgentFsEntry['type'] | null =
      d.type === 'dir' ? 'dir' : d.type === 'file' ? 'file' : null
    if (!type) {
      const target = await backend.stat(backend.join(abs, d.name)).catch(() => null)
      type = target?.type === 'dir' ? 'dir' : 'file'
    }
    const entryAbs = backend.join(abs, d.name)
    const rel = backend.rel(entryAbs)
    const isDir = type === 'dir'
    const ignored = ignore(rel, isDir)
    if (ignored && !includeIgnored) continue
    entries.push({
      name: d.name,
      path: rel,
      type,
      ...(ignored ? { ignored: true } : {})
    })
    if (entries.length >= MAX_ENTRIES) {
      // 截断了要说话（见 `FsListResult.truncated`）：静默少列等于「文件不见了」
      truncated = true
      break
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return Response.json({ entries, ...(truncated ? { truncated: true } : {}) })
}

/**
 * 把工作区里的一个文件夹打成 zip 返回（`?zip=<相对路径>`）。
 * 打包时**沿用文件树的忽略规则**（`.gitignore` / `.git` / `node_modules`…）：树里看不到的东西
 * 也不该进包，否则随手下个目录就是几百 MB。归档内有顶层同名目录（解压即得 `tools/…`）。
 *
 * 本地用 `zipDirectory`（直接读 fs），远端用 `zipRemoteDirectory`（逐个文件走 SFTP）——
 * 两边共用同一套 zip 写入与忽略规则。
 */
async function zipFolder(
  backend: ReturnType<typeof workspaceFilesBackend>,
  remote: boolean,
  rel: string
): Promise<Response> {
  let abs: string
  try {
    abs = backend.resolve(rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const stat = await backend.stat(abs).catch(() => null)
  if (!stat || stat.type !== 'dir') return jsonError(404, '文件夹不存在')
  const ignore = await backend.ignoreChecker()
  try {
    const { buffer, skipped } = remote
      ? await zipRemoteDirectory(backend, abs, {
          ignore: (absPath, isDir) => ignore(backend.rel(absPath), isDir)
        })
      : await zipDirectory(abs, {
          ignore: (absPath, isDir) => ignore(backend.rel(absPath), isDir)
        })
    if (skipped > 0) {
      // 下载本身照常给，但把「有东西没进包」透出去，免得用户以为下全了
      console.warn(`[files.zip] ${rel}：${skipped} 个条目被忽略 / 超限，未打进压缩包`)
    }
    const name = `${backend.basename(abs)}.zip`
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(buffer.length),
        // 中文目录名走 RFC 5987 的 filename*；客户端本来就会自己定文件名，这里只是直连 URL 时的兜底
        'Content-Disposition': `attachment; filename="archive.zip"; filename*=UTF-8''${encodeURIComponent(name)}`
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonError(500, `打包失败：${message}`)
  }
}
