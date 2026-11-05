/**
 * 「脚手架」：给工作区新建一份**模板文件**（技能 SKILL.md / 项目约束 AGENTS.md）。
 *
 * 目前**没有界面入口**（斜线命令 `/create-skill` 已移除）；保留这条服务端能力。
 * 它要在**磁盘上真的造出文件**，而不是把一段提示词塞进输入框让模型自己去建 ——
 * 后者多一轮往返，且模型可能建到别的地方去。
 *
 * ⚠️ **`/init` 已经不在这里了**：AGENTS.md 的价值全在正文（每轮全文注入的硬约束），
 * 这里只能给一份空小节模板，用户拿到手发现是空骨架。现在 `/init` 改由模型读项目后
 * 自己写（提示词见 `slash-commands.ts` 的 `INIT_PROMPT`）。`kind: 'agents'` 这条分支
 * 保留给直接调 API 的场景（要一份能立刻落盘的空骨架时仍有用），别再把 `/init` 接回来。
 *
 * 三条硬约束（与 `plugin-create.ts` 同一套立场）：
 * 1. **已存在一律 409，绝不覆盖**。这些文件是要被人接着手写的，起手就覆盖等于毁数据；
 *    要改就开编辑器改，那是用户明确的动作。
 * 2. **`mkdir` 中间目录**。技能落在 `.fizz/skills/<名字>/SKILL.md`，两层目录通常不存在，
 *    而 `writeWorkspaceFile` 那条路只 `fs.writeFile`、不 mkdir（那是对的：写文件不该
 *    顺手造目录）。
 * 3. **落点用 `resolveInside` 兜一遍**。名字是用户输入，即使服务端已校验过形状，
 *    也不该让它有机会拼出越界路径。
 *
 * ⚠️ 技能落 `.fizz/skills/`（**项目级**）而不是 `~/.fizz/skills/`（用户级）：这是
 * 「在这个项目里加一个技能」的语义，跟着项目走；用户级要留给设置页那套目录管理。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveInside } from '@fizz/contracts/workspace'
import { WORKSPACE_CONFIG_DIR } from '@fizz/contracts/workspace-config'
// ⚠️ 从包**根**引，不要引子路径：`@fizz/agent` 只导出了 `.`（见其 package.json 的
// exports），写 `@fizz/agent/project-doc` 会在解析期就挂掉。`PROJECT_DOC_NAMES` 必须
// 与 `readProjectDoc` 共用同一份常量 —— 落点与读取位置不一致的话，这个技能就是
// 「建出来了但永远读不到」。
import { PROJECT_DOC_NAMES } from '@fizz/agent'
import type { FsScaffoldInput, FsScaffoldResult } from '@fizz/contracts/agent-api'
import { domain } from './state'

/** 脚手架失败一律带 HTTP 状态码（路由层直接照着转响应） */
export class ScaffoldError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message)
    this.name = 'ScaffoldError'
  }
}

/**
 * 技能目录名的合法形状：ASCII 小写字母开头，只含小写字母 / 数字 / `-` / `_`。
 *
 * 刻意要求小写：技能目录名同时是**技能的默认名**（`SKILL.md` 没有 frontmatter `name`
 * 时退回目录名，见 `skills-scan.ts` 的 `readSkillDir`），而它会进系统提示词、也会被
 * `read_skill` 当参数用 —— 混进空格 / 中文 / 大写会让提示词难读、工具调用容易拼错。
 * 允许 `-` 与 `_` 是因为社区技能目录两种写法都有（`web-fetch` / `web_fetch`）。
 */
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]*$/

/** 技能名长度上限（目录名 + frontmatter 的 name，够用了） */
const MAX_SKILL_NAME = 64

/** description 的长度上限（与扫描侧的 `MAX_DESCRIPTION` 同量级，超了也会被截） */
const MAX_SKILL_DESC = 400

/**
 * 把 description 收拾成能安全放进 frontmatter 的**单行**值。
 *
 * 两个坑，都在「解析器不报错、结果静默变了」那一类：
 * - **换行**：`parseSkillDoc` 按行扫 frontmatter，描述里断行等于后面的行被当垃圾丢掉。
 * - **`---`**：它是 frontmatter 的结束标记，出现在值里会把 frontmatter 提前闭合 ——
 *   后果是整份 SKILL.md 退化成「没有 frontmatter 的普通文档」，技能名退回目录名、
 *   描述退回正文首段，用户看不出哪里错了。
 *
 * 所以：折成单行 + 引号包裹（顺带覆盖了值里带 `:` / `#` 的情况，那两个本身 YAML
 * 合法但会让朴素的单行 `key: value` 解析器读歪）。`parseSkillDoc` 会剥掉这对引号。
 */
function sanitizeFrontmatter(raw: string): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  return one ? `"${one.replace(/"/g, "'")}"` : ''
}

/** 校验并规范化技能目录名；不合法时抛 400 并说明为什么 */
export function skillDirName(raw: string | undefined): string {
  const name = (raw ?? '').trim()
  if (!name) throw new ScaffoldError(400, '要给技能起个名字')
  if (name.length > MAX_SKILL_NAME) {
    throw new ScaffoldError(400, `技能名太长（${name.length} 字符），上限 ${MAX_SKILL_NAME}`)
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new ScaffoldError(
      400,
      `技能名「${name}」不合法：要用小写字母开头，只含小写字母 / 数字 / - / _（如 web-fetch、git_review）`
    )
  }
  return name
}

/**
 * SKILL.md 的模板。
 *
 * `description` 是这份文件里**唯一必须写好**的字段：系统提示词只放名称 + 描述，
 * 正文由模型调 `read_skill` 按需读。所以模板在 frontmatter 上给了带日期的样例，
 * 并在正文开头点名「描述写清『什么时候用』」—— 这正是 `skills-scan.ts` 与
 * `skill-tools.ts` 提示词段落反复强调的那件事。
 */
function skillTemplate(name: string, description: string): string {
  const desc = sanitizeFrontmatter(description) || 'TODO：一句话说清这个技能做什么、什么时候用'
  return `---
name: ${name}
description: ${desc}
---

# ${name}

<!--
这个文件是写给 AI 看的。系统提示词里只放「名称 + 描述」，正文要模型调 read_skill
才读进来 —— 所以 description 决定了这个技能会不会被用上，写清「什么时候该用它」，
别只写「它是什么」。
-->

## 什么时候用

（模型判断要不要加载这个技能的依据。写触发场景，别写功能罗列。）

## 怎么做

（步骤 / 命令 / 代码块。这一段是技能正文的核心，写具体到可照做。）

## 参考资料

（可选：references/ 下的文件用 read_skill 的 file 参数读。）
`
}

/**
 * AGENTS.md 的模板（**空骨架**，`/init` 已不走它，见文件头）。
 *
 * 形状刻意贴着「**规则在场、复盘按需**」这个分层（也就是本仓库现在自己的做法）：
 * 顶上先声明本文档只写每轮都在场的硬约束，踩坑复盘指向别处。正文里的占位小节按
 * 「验证 / 架构 / 硬约束 / 环境」分，与本仓库一致 —— 照抄一个已经跑通的骨架，
 * 比给一个空文件让用户自己想结构要靠谱。
 *
 * 但它终究是空的：AGENTS.md 每轮全文注入，空小节等于白占 token。走 `/init` 时请用
 * 模型生成的那份（`INIT_PROMPT`），这里只在「要一个占位文件、内容自己填」时用。
 */
function agentsTemplate(projectName: string): string {
  return `# ${projectName} 项目约束

本文档是**每轮对话都要在场**的项目规则，只写「必须一直遵守的约束」。

踩坑的详细复盘（触发信号 / 根因 / 验证脚本）建议另开目录（如 \`docs/notes/\`），
**不注入上下文**——遇到具体症状时按需读。

**写新条目的规矩**：能一句话说清的约束写在这里；需要复盘才能理解的另建文件。

---

## 验证纪律

（怎么算验证过了、哪些验证默认不做。）

## 架构

（目录 / 包各自的职责，以及新增代码该放哪。）

## 硬约束

（违反就会静默出错的那些规则，一条一行。）

## 环境速查

（构建命令、原生依赖、平台差异。）
`
}

/** 落盘：mkdir 中间目录 + `wx` 写（已存在则 EEXIST，绝不覆盖） */
async function writeNew(abs: string, content: string, existsHint: string): Promise<void> {
  await mkdir(join(abs, '..'), { recursive: true })
  try {
    await writeFile(abs, content, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ScaffoldError(409, existsHint)
    throw err
  }
}

/**
 * 按 kind 造一份模板文件。
 *
 * `workspaceId` 而不是直接给路径：工作区路径是**权限边界**（服务端登记的那份），
 * 让调用方传绝对路径就等于让它能往任意目录写。
 */
export async function scaffoldFile(
  workspaceId: string,
  input: FsScaffoldInput
): Promise<FsScaffoldResult> {
  const workspace = domain.getWorkspace(workspaceId)
  if (!workspace) throw new ScaffoldError(404, `项目不存在：${workspaceId}`)
  if (!workspace.path) {
    throw new ScaffoldError(400, `项目「${workspace.name}」没有磁盘目录，放不了文件`)
  }

  if (input.kind === 'skill') {
    const name = skillDirName(input.name)
    // 相对路径先拼再 resolveInside：越界在这里就会抛，不会带着 ../ 落到盘上
    const rel = `${WORKSPACE_CONFIG_DIR}/skills/${name}/SKILL.md`
    const abs = resolveInside(workspace.path, rel)
    await writeNew(
      abs,
      skillTemplate(name, (input.description ?? '').slice(0, MAX_SKILL_DESC)),
      `技能「${name}」已经存在（${abs}）。换个名字，或直接编辑那个 SKILL.md。`
    )
    return {
      path: rel,
      abs,
      note: '**下一轮对话**生效（系统提示词每轮现扫技能目录）—— 去设置 →「技能」刷新列表就能看到它。'
    }
  }

  // kind === 'agents'：工作区根目录，与 readProjectDoc 的读取位置严格对齐
  const rel = PROJECT_DOC_NAMES[0]
  const abs = resolveInside(workspace.path, rel)
  await writeNew(
    abs,
    agentsTemplate(workspace.name),
    `${rel} 已经存在（${abs}）。要改就直接编辑它 —— 这个文件正是靠被全文注入起作用的。`
  )
  return {
    path: rel,
    abs,
    note: '**下一轮对话**生效（每轮现读一次，不用重启）。它会被全文注入系统提示词，所以只写硬约束。'
  }
}