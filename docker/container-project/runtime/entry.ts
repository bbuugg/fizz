/**
 * 容器内运行时的 **bundle 入口**。
 *
 * 只 re-export 容器里真正需要的那几样 —— 这不是为了好看：vite 库模式按**可达性**打包，
 * 多导出一项就可能把宿主专用的东西（Electron 相关、浏览器面板、MCP 客户端）拖进镜像。
 * 所以这里**逐条列**，不写 `export * from '@fizz/agent'`。
 *
 * 产物：同目录的 `runtime.mjs`（构建命令见根 `build:runtime`）。
 * 容器内 `agent-host.mjs` 直接 `import('./runtime.mjs')`。
 */

/** 单轮对话编排（引擎 agent + 流事件适配）—— 容器内 agent 的心脏 */
export { runAgent, rawToolsPlugin } from '@fizz/agent'

/** 内置文件 / 命令工具集（带路径安全与审批）；`root` 传容器内的 `/workspace` */
export { buildAgentTools } from '@fizz/tools'

/** 联网抓取（容器里也允许 agent 上网查东西） */
export { buildWebFetchTool } from '@fizz/tools'

/** 追问用户（宿主把它的闸挂在 SSE 帧上，见 `agent-host.mjs`） */
export { buildAskFollowupTool, ASK_FOLLOWUP_TOOL } from '@fizz/tools'

/**
 * 按白名单**裁剪并校验**工具集（`CONTAINER_AGENT_TOOL_KEYS`）。
 *
 * 容器里不用 `includeTools` 那种「选择性构建」：文件类工具来自 `buildAgentTools`、
 * 联网来自 `buildWebFetchTool`、追问来自 `buildAskFollowupTool`，三份各自成型后在
 * 这里合并过滤 —— 缺一个白名单键 `filterToolSet` 会**当场抛错**（不是静默少一个工具）。
 */
export { filterToolSet } from '@fizz/tools'

/** 工具白名单（宿主与容器**共用一份**，避免两边名单漂移） */
export { CONTAINER_AGENT_TOOL_KEYS } from '@fizz/contracts/types'

/** 上下文窗口解析（按会话选中的模型解析好传进 `runAgent`，压缩阈值与宿主同一口径） */
export { resolveContextWindow } from '@fizz/contracts/types'

/** 上下文窗口没配时的环境变量兜底（`FIZZ_CONTEXT_BUDGET`，与 `runAgent` 同源） */
export { defaultContextWindowFromEnv } from '@fizz/agent'

/** 容器内协议版本（宿主握手时比对） */
export { CONTAINER_PROTOCOL_VERSION } from '@fizz/contracts/types'
