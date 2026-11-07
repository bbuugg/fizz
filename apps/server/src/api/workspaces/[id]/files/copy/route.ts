import { extname, sep } from 'node:path'
import { domain } from '@/lib/server/state'
import {
  copyWithinWorkspace,
  reservedSegment,
  workspaceFilesBackend
} from '@/lib/workspace-files'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

/**
 * 复制工作区里的文件 / 文件夹到**指定父目录**。
 * POST /api/workspaces/:id/files/copy   body: { path, dest }
 * 返回新条目的相对路径（`dest` 是父目录；目标名默认与源同名，撞名时自动加「副本」后缀）。
 *
 * `dest: ''` = 工作区根目录。同目录原地粘贴也是合法操作（复制完当场粘一下），
 * 服务端会落成「xxx 副本」—— 详见 `freeTargetPath`。
 *
 * 体积上限 512MB（超过多半是误选 node_modules 这类目录）：先走一遍不落盘的
 * 预检，超了直接拒，别等拷一半才失败把磁盘写满。
 *
 * 文件系统操作一律走 `WorkspaceBackend`：本地是 fs.cp，远端工作区是 SFTP + `cp -a`
 * （见 `copyWithinWorkspace`），路径语义两边一致。
 */
const MAX_COPY_BYTES = 512 * 1024 * 1024

/** 递归估算体积，**超限即提前返回 true**（不再往下走，省得为一个大目录全扫一遍） */
async function exceedsSize(
  backend: WorkspaceBackend,
  dirAbs: string,
  limit: number
): Promise<boolean> {
  let total = 0
  const stack = [dirAbs]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await backend.readDir(current).catch(() => [])
    for (const entry of entries) {
      const abs = backend.join(current, entry.name)
      if (entry.type === 'dir') {
        stack.push(abs)
        continue
      }
      const stat = await backend.stat(abs).catch(() => null)
      total += stat?.size ?? 0
      if (total > limit) return true
    }
  }
  return false
}

/**
 * 目标已存在时找个不撞名的位置：`a.txt` → `a 副本.txt` → `a 副本 2.txt`；
 * 目录同理（`src` → `src 副本`，后缀加在最后一段）。返回的路径保证不存在。
 *
 * 为什么自动改名而不是回 409：文件管理器的复制粘贴都是这么处理的，而且
 * 「复制完当场粘到同一目录」是最常用的手势 —— 为它弹个错反而是坏体验。
 * 真要覆盖的话，粘贴后用编辑器改内容另存就行（复制语义本来就不覆盖）。
 */
async function freeTargetPath(backend: WorkspaceBackend, target: string): Promise<string> {
  const exists = async (p: string): Promise<boolean> => (await backend.stat(p).catch(() => null)) !== null
  if (!(await exists(target))) return target
  const dir = backend.dirname(target)
  const base = backend.basename(target)
  const ext = extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let i = 1; i <= 999; i++) {
    const candidate = backend.join(dir, `${stem} 副本${i === 1 ? '' : ` ${i}`}${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  // 999 个副本还没腾出空位：挂时间戳兜底（真到这一步说明在拿脚本刷接口）
  return backend.join(dir, `${stem} 副本 ${Date.now()}${ext}`)
}

/** 路径分隔符跟着 backend 走：本地 Windows 是 `\`，远端 POSIX 是 `/` */
function sepOf(backend: WorkspaceBackend): string {
  return backend.kind === 'remote' ? '/' : sep
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const backend = workspaceFilesBackend(workspace)
  const body = await parseJsonBody<{ path?: string; dest?: string }>(request)
  // ⚠️ 判**类型**而不是真值：`dest: ''` 是合法值，意思是「粘到工作区根目录」
  // （根目录没有名字可传，只能传空串）。用 `!body.dest` 会把根目录误判成缺字段。
  if (typeof body?.path !== 'string' || typeof body.dest !== 'string') {
    return jsonError(400, '缺少 path 或 dest')
  }

  let srcAbs: string
  let destDirAbs: string
  try {
    srcAbs = backend.resolve(body.path)
    destDirAbs = backend.resolve(body.dest ?? '')
  } catch {
    return jsonError(403, '路径越界')
  }
  const srcRel = backend.rel(srcAbs)
  if (!srcRel) return jsonError(400, '不能复制工作区根目录')
  // `.git` / `.fizz` 不能进也不能出：粘一个 .git 副本出来和把它们删了一样危险
  const reserved = reservedSegment(srcRel) ?? reservedSegment(backend.rel(destDirAbs))
  if (reserved) return jsonError(400, `「${reserved}」是受保护的目录，不能复制`)

  const srcStat = await backend.stat(srcAbs)
  if (!srcStat) return jsonError(404, '要复制的文件或文件夹不存在')
  const destStat = await backend.stat(destDirAbs)
  if (!destStat || destStat.type !== 'dir') {
    return jsonError(400, '目标文件夹不存在')
  }

  const target = backend.join(destDirAbs, backend.basename(srcAbs))
  /*
   * 只拦「复制进自己的子树」（会无限递归）。`target === srcAbs`（原地粘贴）是
   * **合法**的 —— 那正是「复制完当场粘到同一目录」，交给下面的加后缀逻辑处理。
   */
  if (srcStat.type === 'dir' && target.startsWith(srcAbs + sepOf(backend))) {
    return jsonError(400, '不能把文件夹复制到它自己里面')
  }
  const finalTarget = await freeTargetPath(backend, target)
  if (srcStat.type === 'dir' && (await exceedsSize(backend, srcAbs, MAX_COPY_BYTES))) {
    return jsonError(400, '目录过大（超过 512MB），暂不支持复制')
  }
  if (srcStat.size > MAX_COPY_BYTES) {
    return jsonError(400, `文件过大（${(srcStat.size / 1048576).toFixed(1)} MB），暂不支持复制`)
  }

  try {
    await copyWithinWorkspace(backend, srcAbs, finalTarget)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, `复制失败：${message}`)
  }
  return Response.json({ path: backend.rel(finalTarget) })
}
