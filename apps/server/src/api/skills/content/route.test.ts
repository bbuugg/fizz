/**
 * 防回归：`/api/skills/content` 只允许读「本次扫描扫出来的那份 SKILL.md」。
 *
 * 技能 id 恰好就是 SKILL.md 的绝对路径 —— 只要有人图省事写成
 * `readFile(new URL(request.url).searchParams.get('id'))`，这条路就成了任意文件读取。
 * 第二条用例（id 指向磁盘上真实存在的文件、但不在扫描结果里）就是拦这个的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/server/skill-roots', () => ({ listServerSkills: mock.list }))
vi.mock('@/lib/server/state', () => ({
  domain: { listWorkspaces: () => [{ id: 'ws', path: '/workspace' }] }
}))
vi.mock('@/app/api/_lib/auth', () => ({
  jsonError: (status: number, error: string) => Response.json({ error }, { status })
}))
vi.mock('node:fs/promises', () => ({ readFile: mock.read }))
import { GET } from './route'

const SKILL_FILE = '/home/u/.agents/skills/demo/SKILL.md'
const skill = {
  id: SKILL_FILE,
  name: 'demo',
  description: '演示技能',
  dir: '/home/u/.agents/skills/demo',
  file: SKILL_FILE,
  source: 'agents',
  root: '/home/u/.agents/skills'
}

const get = (id?: string) =>
  GET(
    new Request(
      `http://localhost/api/skills/content${id === undefined ? '' : `?id=${encodeURIComponent(id)}`}`
    )
  )

beforeEach(() => {
  vi.resetAllMocks()
  mock.list.mockResolvedValue({
    skills: [skill],
    roots: [],
    settings: { disabled: [], extraDirs: [] }
  })
  mock.read.mockResolvedValue('# demo\n')
})

describe('技能内容路由', () => {
  it('扫到的技能返回 SKILL.md 原文', async () => {
    const res = await get(SKILL_FILE)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: SKILL_FILE, file: SKILL_FILE, content: '# demo\n' })
    expect(mock.read).toHaveBeenCalledWith(SKILL_FILE, 'utf8')
  })

  it('没扫到的 id 一律 404，不按路径去读文件', async () => {
    const res = await get('/home/u/secret.txt')
    expect(res.status).toBe(404)
    expect(mock.read).not.toHaveBeenCalled()
  })

  it('缺少 id 时 400，且不扫盘', async () => {
    expect((await get()).status).toBe(400)
    expect(mock.list).not.toHaveBeenCalled()
  })
})
