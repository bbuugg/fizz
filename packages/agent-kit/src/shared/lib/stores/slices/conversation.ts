/**
 * 兼容桶：对话 slice 的实现已按分层拆到 `./conversation/` 目录
 * （types / storage / state / reconnect / internals / actions），
 * 这里只做转发，既有 import 路径与导出面完全不变。
 */
export * from "./conversation/index";
