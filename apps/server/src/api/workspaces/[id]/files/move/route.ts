import { promises as fs } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/**
 * 移动 / 重命名工作区里的文件 / 文件夹到**指定父目录**。
 * POST /api/workspaces/:id/files/move   body: { path, dest, name? }
 * 返回新条目的相对路径（`dest` 是父目录；不给 `name` 时目标名保持源名）。
 *
 * 可选 `name` = 重命名：只换**最后一段**，父目录仍是 `dest`。没有它时「移动不自动改名」——
 * 目标已存在同名条目时直接 409：移动是有损操作，静默覆盖会毁数据（复制可以加「副本」后缀，移动不能）。
 *
 * `dest: ''` = 工作区根目录。
 *
 * 优先 `fs.rename`（同卷瞬间完成）；跨设备（EXDEV）时退回「复制到目标 + 删源」。
 */

/** `.git` / `.fizz` 不能进也不能出：把它们移走 / 移入和删掉一样危险 */
function reservedHit(rel: string): string | null {
  const hit = rel.split('/').filter(Boolean).find((s) => s === '.git' || s === '.fizz')
  return hit ?? null
}

/** 跨设备移动：`rename` 报 EXDEV 时需要走「复制 + 删源」 */
function isExdev(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EXDEV'
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, '文件面板')
  if (denied) return denied
  const body = await parseJsonBody<{ path?: string; dest?: string; name?: string }>(request)
  // ⚠️ 判**类型**而不是真值：`dest: ''` 是合法值（移到工作区根目录）
  if (typeof body?.path !== 'string' || typeof body.dest !== 'string') {
    return jsonError(400, '缺少 path 或 dest')
  }
  // 可选新名（重命名）：只换最后一段，父目录仍是 dest
  const newName = typeof body.name === 'string' ? body.name.trim() : null
  if (newName !== null) {
    if (!newName) return jsonError(400, '新名字不能为空')
    if (newName === '.' || newName === '..' || /[/\\]/.test(newName)) {
      return jsonError(400, '新名字里不能有 / 或 \\')
    }
    const hit = reservedHit(newName)
    if (hit) return jsonError(400, `「${hit}」是受保护的目录，不能使用`)
  }

  let srcAbs: string
  let destDirAbs: string
  try {
    srcAbs = resolveInside(workspace.path, body.path)
    destDirAbs = resolveInside(workspace.path, body.dest ?? '')
  } catch {
    return jsonError(403, '路径越界')
  }
  const srcRel = relative(workspace.path, srcAbs).split(sep).join('/')
  if (!srcRel) return jsonError(400, '不能移动工作区根目录')
  const reserved =
    reservedHit(srcRel) ?? reservedHit(relative(workspace.path, destDirAbs).split(sep).join('/'))
  if (reserved) return jsonError(400, `「${reserved}」是受保护的目录，不能移动`)

  const srcStat = await fs.stat(srcAbs).catch(() => null)
  if (!srcStat) return jsonError(404, '要移动的文件或文件夹不存在')
  if (!(await fs.stat(destDirAbs).catch(() => null))?.isDirectory()) {
    return jsonError(400, '目标文件夹不存在')
  }

  const target = join(destDirAbs, newName ?? basename(srcAbs))
  // 原地移动（目标就是自己）：当成功返回，不报错 —— 与「复制到同目录」的手感一致
  if (target === srcAbs) {
    return Response.json({ path: srcRel })
  }
  if (srcStat.isDirectory() && target.startsWith(srcAbs + sep)) {
    return jsonError(400, '不能把文件夹移动到它自己里面')
  }
  if (await fs.stat(target).then(() => true).catch(() => false)) {
    return jsonError(409, `目标位置已存在同名条目：${basename(target)}`)
  }

  try {
    try {
      await fs.rename(srcAbs, target)
    } catch (err) {
      if (!isExdev(err)) throw err
      // 跨设备：先复制过去再删源（rename 不支持跨卷）
      await fs.cp(srcAbs, target, { recursive: true })
      await fs.rm(srcAbs, { recursive: true, force: true })
    }
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, `移动失败：${message}`)
  }
  return Response.json({ path: relative(workspace.path, target).split(sep).join('/') })
}
