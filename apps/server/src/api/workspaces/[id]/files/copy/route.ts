import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { resolveInside } from '@fizz/contracts/workspace'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
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
 * 预检，超了直接拒，别等 `fs.cp` 拷一半才失败把磁盘写满。
 */
const MAX_COPY_BYTES = 512 * 1024 * 1024

/** 递归估算体积，**超限即提前返回 true**（不再往下走，省得为一个大目录全扫一遍） */
async function exceedsSize(dir: string, limit: number): Promise<boolean> {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const d of dirents) {
      const abs = join(current, d.name)
      if (d.isDirectory()) {
        stack.push(abs)
        continue
      }
      const stat = await fs.stat(abs).catch(() => null)
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
async function freeTargetPath(target: string): Promise<string> {
  const exists = async (p: string): Promise<boolean> =>
    fs.stat(p).then(() => true).catch(() => false)
  if (!(await exists(target))) return target
  const dir = dirname(target)
  const base = basename(target)
  const ext = extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let i = 1; i <= 999; i++) {
    const candidate = join(dir, `${stem} 副本${i === 1 ? '' : ` ${i}`}${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  // 999 个副本还没腾出空位：挂时间戳兜底（真到这一步说明在拿脚本刷接口）
  return join(dir, `${stem} 副本 ${Date.now()}${ext}`)
}

/** `.git` / `.fizz` 不能进也不能出：粘一个 .git 副本出来和把它们删了一样危险 */
function reservedHit(rel: string): string | null {
  const hit = rel.split('/').filter(Boolean).find((s) => s === '.git' || s === '.fizz')
  return hit ?? null
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
  const body = await parseJsonBody<{ path?: string; dest?: string }>(request)
  // ⚠️ 判**类型**而不是真值：`dest: ''` 是合法值，意思是「粘到工作区根目录」
  // （根目录没有名字可传，只能传空串）。用 `!body.dest` 会把根目录误判成缺字段。
  if (typeof body?.path !== 'string' || typeof body.dest !== 'string') {
    return jsonError(400, '缺少 path 或 dest')
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
  if (!srcRel) return jsonError(400, '不能复制工作区根目录')
  const reserved = reservedHit(srcRel) ?? reservedHit(relative(workspace.path, destDirAbs).split(sep).join('/'))
  if (reserved) return jsonError(400, `「${reserved}」是受保护的目录，不能复制`)

  const srcStat = await fs.stat(srcAbs).catch(() => null)
  if (!srcStat) return jsonError(404, '要复制的文件或文件夹不存在')
  if (!(await fs.stat(destDirAbs).catch(() => null))?.isDirectory()) {
    return jsonError(400, '目标文件夹不存在')
  }

  const target = join(destDirAbs, basename(srcAbs))
  /*
   * 只拦「复制进自己的子树」（会无限递归）。`target === srcAbs`（原地粘贴）是
   * **合法**的 —— 那正是「复制完当场粘到同一目录」，交给下面的加后缀逻辑处理。
   */
  if (srcStat.isDirectory() && target.startsWith(srcAbs + sep)) {
    return jsonError(400, '不能把文件夹复制到它自己里面')
  }
  const finalTarget = await freeTargetPath(target)
  if (srcStat.isDirectory() && (await exceedsSize(srcAbs, MAX_COPY_BYTES))) {
    return jsonError(400, '目录过大（超过 512MB），暂不支持复制')
  }
  if (srcStat.size > MAX_COPY_BYTES) {
    return jsonError(400, `文件过大（${(srcStat.size / 1048576).toFixed(1)} MB），暂不支持复制`)
  }

  try {
    // recursive 对文件同样适用（直接拷过去）；文件夹则整棵子树复制
    await fs.cp(srcAbs, finalTarget, { recursive: true })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, `复制失败：${message}`)
  }
  return Response.json({ path: relative(workspace.path, finalTarget).split(sep).join('/') })
}
