/**
 * 单个技能的 SKILL.md 原文：设置页「技能」列表点一行 → 弹窗里做 Markdown 预览。
 *
 * ⚠️ **只认扫描结果里的 id**，不拿请求参数当路径用：技能 id 恰好就是 SKILL.md 的
 * 绝对路径，若直接 `readFile(id)`，这条路就是「任意文件读取」。所以每次请求都按
 * `GET /api/skills` 同一口径重扫一遍，扫到的那份 `file` 才是唯一允许读的路径。
 */
import { readFile } from 'node:fs/promises'
import type { SkillDocResult } from '@fizz/skills'
import { listServerSkills } from '@/lib/server/skill-roots'
import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id')?.trim()
  if (!id) return jsonError(400, '缺少技能 id')

  const workspace = domain.listWorkspaces()[0]
  const { skills } = await listServerSkills(workspace?.path)
  const skill = skills.find((s) => s.id === id)
  // 扫不到就是一种「已被移走」：别回落到按路径读，点「刷新」重扫即可
  if (!skill) return jsonError(404, '没扫到这个技能（可能已被移走，点「刷新」重新扫描）')

  try {
    const content = await readFile(skill.file, 'utf8')
    return Response.json({ id: skill.id, file: skill.file, content } satisfies SkillDocResult)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonError(500, `读取 SKILL.md 失败：${message}`)
  }
}
