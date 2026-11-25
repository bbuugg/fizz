/**
 * @fizz/acp：ACP（Agent Client Protocol）客户端，TS 源码直接导出
 * （与 contracts / git 同一模式）。
 *
 * 把外部 agent 进程（Claude Code、Codex、Gemini CLI 等）按 ACP 协议接成与内置
 * ai-sdk 后端同款的事件流：会话常驻连接、审批透传、模型 / 模式切换、transcript 重放。
 */
export * from './types'
export * from './acp'
export * from './protocol'
