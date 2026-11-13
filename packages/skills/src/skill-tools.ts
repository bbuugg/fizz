/**
 * 技能（Agent Skills 约定：目录 + `SKILL.md`）。
 *
 * 技能内容本身在磁盘上（由主进程 `services/ai/skills.ts` 扫描），这里只负责
 * 「让模型用得上」的两件事：
 * 1. `buildSkillsPromptSection` —— 系统提示词里的**技能清单**（只有名称 + 描述，
 *    省 token），并约定「相关时先读说明再动手」；
 * 2. `buildReadSkillTool` —— `read_skill` 工具，按名字把 SKILL.md 正文读进来，
 *    也可以读技能目录内的其它文件。
 *
 * 这就是 Anthropic Agent Skills 的**渐进式披露**：清单常驻提示词、正文按需加载。
 * 自己做而不用 provider 原生能力，是因为原生技能只有官方 Anthropic / OpenAI 有
 * （且要求在托管沙箱里跑、技能包得先上传），本项目大量使用 openai-compatible 兼容网关。
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { resolveInside } from '@fizz/contracts/workspace'
import { tr } from '@fizz/i18n'

/** 技能清单文件名（扫描逻辑在 skills-scan.ts，这里只做转出方便调用方） */
export { SKILL_FILE } from './skills-scan'
/** 单次读取技能的字符上限（SKILL.md 正常都很小，这是防御 `file` 参数读到大文件） */
const MAX_SKILL_CHARS = 100_000
/** 技能目录清单里最多列多少项 */
const MAX_LIST_ENTRIES = 60

/** 一个可用技能（主进程扫描结果的投影，与 @shared/types.SkillInfo 结构兼容） */
export interface AgentSkill {
  id: string
  name: string
  description: string
  /** 技能目录绝对路径 */
  dir: string
  /** SKILL.md 绝对路径 */
  file: string
}

/** 技能目录的顶层清单：让模型一眼看到有哪些脚本 / 参考资料 */
async function listSkillEntries(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      return ad === bd ? a.name.localeCompare(b.name) : ad - bd
    })
    return entries
      .slice(0, MAX_LIST_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  } catch {
    return []
  }
}

async function readSkillText(abs: string): Promise<string> {
  const buf = await fs.readFile(abs)
  if (buf.includes(0)) throw new Error(`不能以文本方式读取：${basename(abs)}`)
  const text = buf.toString('utf8')
  return text.length > MAX_SKILL_CHARS
    ? `${text.slice(0, MAX_SKILL_CHARS)}\n…（内容过长，已截断，共 ${text.length} 字符）`
    : text
}

/** 按名字（或目录名）找技能；找不到时给出可用清单，方便模型纠正 */
function findSkill(skills: AgentSkill[], name: string): AgentSkill {
  const key = name.trim().toLowerCase()
  const hit =
    skills.find((s) => s.name.toLowerCase() === key) ??
    skills.find((s) => basename(s.dir).toLowerCase() === key) ??
    skills.find((s) => s.name.toLowerCase().includes(key) && key.length > 0)
  if (hit) return hit
  throw new Error(
    `没有名为「${name}」的技能。可用技能：${skills.map((s) => s.name).join('、') || '（无）'}`
  )
}

/**
 * `read_skill`：读取某个技能的说明（默认 SKILL.md 本身）。
 *
 * 技能目录通常在工作区之外（用户级 / Claude 兼容目录），工作区的 read 够不着，
 * 所以单独给一个工具 —— 它的读写范围被限制在**已发现的技能目录**内。
 */
export function buildReadSkillTool(skills: AgentSkill[]): ToolSet {
  return {
    read_skill: tool({
      description:
        '读取某个技能的完整说明（SKILL.md 正文）。系统提示词里列出了可用技能与它们的用途；判断任务与某个技能相关时，先调用本工具读说明，再按说明里的步骤执行。也可以用 file 参数读技能目录内的其它文件（如 references/xxx.md、scripts/xxx.mjs）。',
      inputSchema: z.object({
        name: z.string().describe('技能名称（系统提示词里列出的名字）'),
        file: z
          .string()
          .optional()
          .describe('技能目录内的相对路径；缺省读 SKILL.md 本身')
      }),
      execute: async ({ name, file }) => {
        const skill = findSkill(skills, name)
        const abs = file ? resolveInside(skill.dir, file) : skill.file
        let content: string
        try {
          content = await readSkillText(abs)
        } catch (err) {
          if (file) {
            throw new Error(
              `读取技能内文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`
            )
          }
          throw err
        }

        const entries = await listSkillEntries(skill.dir)
        const header = [
          `技能：${skill.name}`,
          `用途：${skill.description}`,
          `目录：${skill.dir}`,
          entries.length ? `目录内容：${entries.join('、')}` : '',
          file
            ? `（以下为技能内文件 ${file} 的内容）`
            : '（以下为 SKILL.md 全文，请按其中的步骤执行）'
        ]
          .filter(Boolean)
          .join('\n')
        return `${header}\n\n${content}`
      }
    })
  }
}

/**
 * 系统提示词里的技能段落：只列名称 + 描述，正文交给 `read_skill` 按需加载。
 * 没有技能时返回空串（调用方直接拼接即可）。
 */
export function buildSkillsPromptSection(skills: AgentSkill[]): string {
  if (skills.length === 0) return ''
  return tr(
    [
      '## 可用技能（Skills）',
      '用户在本机安装了一些技能，每个技能是一份带步骤的说明（可能还带脚本与参考资料）：',
      ...skills.map((s) => `- ${s.name}：${s.description}`),
      '使用约定：',
      '- 判断任务与某个技能相关时，**先调用 read_skill 读它的完整说明，再严格按说明执行**；不要凭技能名猜做法；',
      '- 技能说明里提到的脚本 / 参考资料，用 read_skill 的 file 参数读取，或用 bash 以绝对路径执行；',
      '- 技能与当前任务无关时不要提及，也不要在正文里罗列技能清单。'
    ].join('\n'),
    [
      '## Available skills',
      'The user installed skills on this machine. Each skill is a step-by-step guide (possibly with scripts and references):',
      ...skills.map((s) => `- ${s.name}: ${s.description}`),
      'Conventions:',
      '- When a task relates to a skill, **first call read_skill to read its full instructions, then follow them strictly**; do not guess from the name;',
      '- Read scripts/references mentioned by a skill with read_skill’s file parameter, or run them via bash with an absolute path;',
      '- Do not mention skills unrelated to the current task and do not list them in the reply.'
    ].join('\n')
  )
}
