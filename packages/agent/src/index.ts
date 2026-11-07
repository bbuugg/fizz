/**
 * @fizz/agent：对话编排层，TS 源码直接导出（与 contracts / tools 等同一模式）。
 *
 * 四块内容：
 * - `agent.ts` —— 单轮编排（runAgent），工具集与技能来自
 *   `@fizz/tools` / `@fizz/skills`，确认走注入的审批回调；
 * - `prompt.ts` —— 系统提示词组装、历史消息转换（toModelMessages）、流事件适配；
 * - `project-doc.ts` —— 工作区根目录项目约束文档（AGENTS.md / CLAUDE.md）读盘与提示词段落；
 * - `models-probe.ts` —— 上游 provider 模型清单探测（设置页用）。
 * - `subagents.ts` —— 子任务（supervisor 模式）：只读 explorer / reviewer 与派活工具。
 * - `collab.ts` —— 多智能体协作编排器：@ 点名 / 广播判定、SendMessage 投递、状态快照。
 */
export * from './agent'
export * from './prompt'
export * from './plugins'
export * from './project-doc'
export * from './models-probe'
export * from './context'
export * from './subagents'
export * from './collab'
