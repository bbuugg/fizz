import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentFsEntry } from '@fizz/contracts/types'
import { createIgnoreChecker, relPathOf, resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { jsonError } from '@/app/api/_lib/auth'
import { zipDirectory } from '@/lib/server/lib/zip'

const MAX_ENTRIES = 2000

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied
  const url = new URL(request.url)
  // `?zip=<rel>`：把某个文件夹打包成 zip 直接吐出来（文件视图的「下载文件夹」）。
  // 与下面「列目录」是同一资源（工作区的文件）的两种表示，所以共用这条路由、不另开一条。
  const zipPath = url.searchParams.get('zip')
  if (zipPath !== null) return zipFolder(workspace.path, zipPath)
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
    abs = resolveInside(workspace.path, dir)
  } catch {
    return jsonError(403, '路径越界')
  }
  const ignore = await createIgnoreChecker(workspace.path)
  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const entries: AgentFsEntry[] = []
  let truncated = false
  for (const d of dirents) {
    const entryAbs = join(abs, d.name)
    /**
     * `Dirent.isFile()` / `isDirectory()` 是 **lstat 语义**：符号链接（以及 Windows 的
     * 目录 junction）**两个都为 false**，会被下面那句「既不是文件也不是目录就 continue」
     * 整条丢掉 —— 用户自己造的软链因此在文件树里**根本不存在**（2026-10 反馈）。
     *
     * 所以链接条目补一次 `fs.stat`（**跟随链接**）问出真实类型；断链（目标不存在）
     * 时按普通文件列出，至少让用户看得见它在那儿，而不是凭空消失。
     */
    let type: AgentFsEntry['type'] | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null
    if (!type && d.isSymbolicLink()) {
      const target = await fs.stat(entryAbs).catch(() => null)
      type = target?.isDirectory() ? 'dir' : 'file'
    }
    if (!type) continue
    const isDir = type === 'dir'
    const rel = relPathOf(workspace.path, entryAbs)
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
 */
async function zipFolder(workspacePath: string, rel: string): Promise<Response> {
  let abs: string
  try {
    abs = resolveInside(workspacePath, rel)
  } catch {
    return jsonError(403, '路径越界')
  }
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isDirectory()) return jsonError(404, '文件夹不存在')
  const ignore = await createIgnoreChecker(workspacePath)
  const { buffer, skipped } = await zipDirectory(abs, {
    ignore: (absPath, isDir) => ignore(relPathOf(workspacePath, absPath), isDir)
  })
  if (skipped > 0) {
    // 下载本身照常给，但把「有东西没进包」透出去，免得用户以为下全了
    console.warn(`[files.zip] ${rel}：${skipped} 个条目被忽略 / 超限，未打进压缩包`)
  }
  const name = `${basename(abs)}.zip`
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(buffer.length),
      // 中文目录名走 RFC 5987 的 filename*；客户端本来就会自己定文件名，这里只是直连 URL 时的兜底
      'Content-Disposition': `attachment; filename="archive.zip"; filename*=UTF-8''${encodeURIComponent(name)}`
    }
  })
}
