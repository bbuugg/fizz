/**
 * @fizz/skills 的领域类型：技能扫描结果、根目录信息与用户设置。
 * 类型真源在本包，前端一律 `import type` 引用。
 */

/**
 * 技能来源：
 * - `builtin`：**随产品分发**的内置技能根（`<仓库根/安装目录>/skills`，带 `builtin-skills.json`
 *   标记），对所有项目生效；启停与其他来源共用同一份全局设置；
 * - `workspace`：`<项目>/.fizz/skills`，只对该项目生效；
 * - `user`：`~/.fizz/skills`；`agents`：`~/.agents/skills`（跨智能体共享）；
 * - `custom`：用户在设置页手动添加的目录。
 *
 * ⚠️ **不再单独扫 `~/.claude/skills`**：那是 skills CLI 给 Claude Code 铺的一份软链目录
 * （每个技能链到 `~/.agents/skills/<name>`），扫它只会把同一批技能再列一遍。跨智能体共享
 * 目录已经覆盖了它们，用户真要指别处就走 `custom`。
 */
export type SkillSource = 'builtin' | 'workspace' | 'user' | 'agents' | 'custom'

/** 一个已发现的技能（磁盘就是唯一真源，这里只是扫描结果的投影） */
export interface SkillInfo {
  /** 技能 id：SKILL.md 的绝对路径（唯一、稳定；启停状态按它记） */
  id: string
  name: string
  description: string
  /** 技能目录绝对路径 */
  dir: string
  /** SKILL.md 绝对路径 */
  file: string
  source: SkillSource
  /** 来源根目录（设置页按它分组 / 打开） */
  root: string
}

/** 一个技能根目录的扫描情况（UI 用来显示「扫了哪些地方」） */
export interface SkillRootInfo {
  source: SkillSource
  dir: string
  /** 目录是否存在（不存在的目录不会自动创建） */
  exists: boolean
  /** 该根目录下发现多少个技能 */
  count: number
}

/** 技能的用户配置：启停 + 额外根目录（技能内容在磁盘上，这里只记用户的选择） */
export interface SkillSettings {
  /** 被停用的技能 id —— 默认全开，新加的技能自动生效 */
  disabled: string[]
  /** 额外技能根目录（绝对路径） */
  extraDirs: string[]
}

/** `skills:list` 的返回体：一次拿全，免得 UI 分几次请求 */
export interface SkillListResult {
  skills: SkillInfo[]
  roots: SkillRootInfo[]
  settings: SkillSettings
}

/**
 * 单个技能的 SKILL.md 原文（设置页「技能」列表点开一行的 Markdown 预览用）。
 *
 * `content` 是**磁盘原文**（含 frontmatter），不做解析 —— 预览要让人看到文件里
 * 到底写了什么，列表里的 name / description 已经是解析过的投影了。
 */
export interface SkillDocResult {
  /** 技能 id（SKILL.md 的绝对路径，与 `SkillInfo.id` 同一份） */
  id: string
  /** SKILL.md 绝对路径 */
  file: string
  /** SKILL.md 全文 */
  content: string
}
