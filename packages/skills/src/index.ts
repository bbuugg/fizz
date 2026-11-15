/**
 * @fizz/skills：技能系统，TS 源码直接导出（与 contracts / git 同一模式）。
 *
 * 三块内容：
 * - `skills-scan.ts` —— 技能文档（SKILL.md）解析与多根扫描（纯文件操作）；
 * - `skill-tools.ts` —— 渐进披露：提示词里的技能清单段落 + `skill` 工具；
 * - `skills.ts` —— server 端技能发现（工作区 / 用户目录 / 全局设置过滤）。
 */
export * from './types'
export * from './skills-scan'
export * from './skill-tools'
export * from './skills'
