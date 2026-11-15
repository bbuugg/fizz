/**
 * **容器视角**的技能清单（宿主发给容器的那一份）。
 *
 * 宿主侧的技能发现（`skill-roots.ts`）会把五类来源都算进来，容器里能读到的只有四类：
 *
 * - 内置（`/app/skills`，镜像 `COPY skills` 进来的）；
 * - 项目内（`/workspace/.fizz/skills`，随工作区挂载）；
 * - 用户级（`~/.fizz/skills` → `/fizz-skills/user`）与跨智能体共享（`~/.agents/skills` →
 *   `/fizz-skills/agents`）：**由 `lifecycle.ts` 只读挂载**（见 `skill-mounts.ts`）。
 *
 * 「用户自加目录」（`custom`）**没有挂载** —— 把它的路径直接发下去等于给模型一份
 * 「读得到名字、读不到内容」的清单：`skill` 会照着 `path` 去读，容器里那个文件不存在。
 *
 * 两处兜底（都是「宁可不发，也不发一条读不到的路径」）：
 *
 * 1. 用户级那两个来源只有在这个容器**确实挂了**的时候才发（`mountedDirs` 由 `doStart`
 *    现读带出来）—— 升级前建的、还在跑的旧容器没有那些挂载；
 * 2. 挂载目录里的技能**可能是 junction / 软链**（skills CLI 装的常常如此），真实路径落在
 *    挂载点之外时容器里那条链接是断的 —— 这种跳过并打日志。
 *
 * ⚠️ 路径断言（`assertContainerSkillPaths`）是刻意放在**组装之后立刻**跑的：一旦哪天有人
 * 把别的来源也放进清单，失败会当场发生（并发下一轮之前），而不是变成容器里一次「读不到文件」。
 */
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import { filterEnabled, type SkillInfo, type SkillSource } from '@fizz/skills'
import { listServerSkills } from '../skill-roots'
import { domain } from '../state'
import { CONTAINER_AGENTS_SKILLS_DIR, CONTAINER_USER_SKILLS_DIR } from './skill-mounts'

/** 镜像内置技能根在容器里的位置（`runtime.Dockerfile` 的 `COPY skills /app/skills`） */
export const CONTAINER_BUILTIN_SKILLS_DIR = '/app/skills'
/** 项目内技能在容器里的位置（宿主 `<项目>/.fizz/skills` 就在挂载点 `/workspace` 下） */
export const CONTAINER_PROJECT_SKILLS_DIR = '/workspace/.fizz/skills'

/** 允许出现在容器内清单里的路径前缀（其余一律拒绝） */
export const CONTAINER_SKILL_ROOTS: readonly string[] = [
  CONTAINER_BUILTIN_SKILLS_DIR,
  CONTAINER_PROJECT_SKILLS_DIR,
  CONTAINER_USER_SKILLS_DIR,
  CONTAINER_AGENTS_SKILLS_DIR
]

/**
 * 哪些来源进容器 → 对应的容器内根目录。
 *
 * 缺席的来源（`custom`）就是**不进容器**的那一类：它没有挂载，容器里不存在。
 */
const CONTAINER_ROOT_OF: Partial<Record<SkillSource, string>> = {
  builtin: CONTAINER_BUILTIN_SKILLS_DIR,
  workspace: CONTAINER_PROJECT_SKILLS_DIR,
  user: CONTAINER_USER_SKILLS_DIR,
  agents: CONTAINER_AGENTS_SKILLS_DIR
}

/**
 * 靠**挂载**才存在的来源 → 挂载点。这几个来源要求容器真的挂了才能发（见文件头第 1 条），
 * 并且要额外过一遍「真实路径没跑出挂载点」的检查（第 2 条）。
 */
const MIRRORED_ROOT_OF: Partial<Record<SkillSource, string>> = {
  user: CONTAINER_USER_SKILLS_DIR,
  agents: CONTAINER_AGENTS_SKILLS_DIR
}

/** 容器内可用的一项技能；`path` = **容器内** SKILL.md 的绝对路径（`skill` 靠它锚定） */
export interface ContainerSkill {
  name: string
  description: string
  path: string
}

/**
 * 每条 `path` 必须以容器内某个技能根开头，否则**当场抛错**。
 *
 * 不做「过滤掉不合法项」—— 静默丢一条技能与静默发一条读不到的技能都是同一种病：
 * 用户看到清单少了一样东西但没有任何解释。
 */
export function assertContainerSkillPaths(skills: { path: string }[]): void {
  for (const skill of skills) {
    const ok = CONTAINER_SKILL_ROOTS.some(
      (root) => skill.path === root || skill.path.startsWith(`${root}/`)
    )
    if (!ok) {
      throw new Error(
        `技能路径不是容器内路径：${skill.path}（必须以 ${CONTAINER_SKILL_ROOTS.join(' 或 ')} 开头）` +
          '—— 容器里没有这个文件，模型会读不到内容'
      )
    }
  }
}

/** 宿主绝对路径 → 容器内绝对路径（一律 POSIX 分隔符：宿主 Windows 上 `relative` 给的是反斜杠） */
function toContainerPath(containerRoot: string, root: string, file: string): string {
  const rel = relative(root, file)
    .split(/[\\/]/)
    .filter(Boolean)
    .join('/')
  return rel ? `${containerRoot}/${rel}` : containerRoot
}

/** `file` 是否真的在 `root` 里面（Windows 下大小写不敏感） */
function isUnder(root: string, file: string): boolean {
  const norm = (path: string): string =>
    process.platform === 'win32' ? path.toLowerCase() : path
  const base = norm(root).replace(/[\\/]+$/, '')
  const target = norm(file)
  return (
    target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`)
  )
}

/**
 * 这个技能在容器里读得到吗（只看「有没有跑出挂载点」）。
 *
 * 为什么需要：`~/.agents/skills/<name>` 常常是指向别处的 junction / 软链（skills CLI 装的
 * 就是），而 bind mount 只搬目录内容、**不搬链接目标** —— 容器里那条链接指向一个不存在的
 * 宿主路径。`realpath` 之后不在挂载点里就说明属于这种。
 */
async function readableInMount(skill: SkillInfo): Promise<boolean> {
  try {
    const [root, file] = await Promise.all([realpath(skill.root), realpath(skill.file)])
    return isUnder(root, file)
  } catch {
    // 断链 / 没权限：宿主上就 broken，容器里更读不到
    return false
  }
}

/**
 * 某个容器型项目在容器内可用的技能清单（已启用 + 只留容器内读得到的来源 + 路径改写 + 断言）。
 *
 * `mountedDirs` = 这个容器**确实挂上了**的容器内目录（`doStart` 现读带出来）；不传按
 * 「什么都没挂」处理 —— 老容器上宁可少几条技能，也不给模型一条读不到的路径。
 *
 * 工作区不存在 / 不是容器型项目时返回空清单（调用方在前置校验里已经拦过，这里只是不抛错）。
 */
export async function containerSkillList(
  workspaceId: string,
  mountedDirs: readonly string[] = []
): Promise<ContainerSkill[]> {
  const ws = domain.getWorkspace(workspaceId)
  if (!ws) return []
  const { skills, settings } = await listServerSkills(ws.path)
  const picked: ContainerSkill[] = []
  for (const skill of filterEnabled(skills, settings)) {
    const containerRoot = CONTAINER_ROOT_OF[skill.source]
    if (!containerRoot) continue
    if (MIRRORED_ROOT_OF[skill.source]) {
      // 容器里没挂这个目录：发下去模型也读不到
      if (!mountedDirs.includes(containerRoot)) continue
      // 挂载目录里的 junction / 软链：真实路径跑出挂载点 → 容器里是断链
      if (!(await readableInMount(skill))) {
        console.warn(
          `[container-skill] 跳过技能「${skill.name}」：${skill.file} 的真实路径不在 ${skill.root} 内` +
            '（多半是 junction / 软链指向别处），容器里读不到'
        )
        continue
      }
    }
    picked.push({
      name: skill.name,
      description: skill.description,
      path: toContainerPath(containerRoot, skill.root, skill.file)
    })
  }
  assertContainerSkillPaths(picked)
  return picked
}
