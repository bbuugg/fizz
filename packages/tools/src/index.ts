/**
 * @fizz/tools：内置 Agent 工具集，TS 源码直接导出（与 contracts / git 同一模式）。
 *
 * 四块内容：
 * - `tools.ts` —— 文件读写 / 命令执行工具（路径安全靠 contracts/workspace，
 *   技能读取靠 @fizz/skills，破坏性操作走注入的审批回调）；
 * - `edit-match.ts` —— edit_file 的容错匹配（行尾 / 缩进 / 空白 / 转义 / 行号前缀逐档退让）；
 * - `ask-followup.ts` —— `ask_followup_question` 提问工具（transport 无关，
 *   由调用方注入答复通道）；
 * - `web-fetch.ts` —— 联网抓取（Playwright 渲染 + turndown 转 Markdown，
 *   两者都走动态 import，没装时给可读错误）；
 * - `output-log.ts` —— 超预算的 **execute_command / web_fetch 输出**把**全文**落进工作区的
 *   `.fizz/tool-output/`（返回相对路径 + 全文行数 + 本次返回哪几行）；续读不靠专用工具，
 *   模型用本来就有的 `read_file`（offset/limit 按行翻）或 `search_files`（关键词检索）——
 *   早先那套 `read_log` 工具已移除，理由见该文件顶部。其余工具靠自己的分页参数，不走这里。
 * - `ansi.ts` —— 命令输出的 ANSI 转义清洗（颜色 / 清行 / OSC 超链接）。命令是经管道跑
 *   却仍带颜色（`npm run` 注入 `FORCE_COLOR`），工具结果与后台任务日志都要先过它。
 * - `git-read.ts` —— `git_read`：只读 git 视图（status / diff / log / show）。**刻意不给**
 *   写仓库的动作（checkout / add / commit …），也不进 `buildAgentTools` 的 all ——
 *   它只服务没有 execute_command 的 subagent（父 agent 要看 diff 自己跑 git，那边有审批）。
 * - `project-tools.ts` —— 项目管理工具组（创建 / 列出 / 打开 / 删除项目与 worktree），
 *   服务能力经 deps 注入，普通会话与项目助手共用；
 * - `model-tools.ts` —— 模型配置工具组（配置的列 / 增 / 改 / 删、从上游拉模型清单、
 *   配置下模型条目的增 / 改 / 删）。**只挂给全局 AI 助手**，与 project-tools 共用
 *   `guardMutation` 的审批口径；
 * - `mcp-tools.ts` —— MCP 配置工具组（server 的列 / 增 / 改 / 删 + 连上列它的工具）。
 *   同样**只挂给全局 AI 助手**：它只写配置，让 MCP 生效仍然是会话级勾选；
 * - `playwright-browsers.ts` —— 打包态（Electron）下把 playwright 指到随包分发的
 *   chromium（`extraResources` 拷进来的 headless shell），dev / server / cli 不受影响。
 */
export * from './tools'
export * from './edit-match'
export * from './ask-followup'
export * from './web-fetch'
export * from './screenshot'
export * from './output-log'
export * from './ansi'
export * from './git-read'
export * from './project-tools'
export * from './model-tools'
export * from './mcp-tools'
export * from './playwright-browsers'
export * from './browser'
