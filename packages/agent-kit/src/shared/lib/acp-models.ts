/**
 * 「这个 ACP agent 的模型清单还要不要拉」。
 *
 * 判据是 `models` **字段在不在**，不是长度：空数组代表「探测过，它确实没有可选模型」，
 * 再探只会白起一次外部 agent 进程（一次探测 = spawn 一个 CLI + 一次会话握手）。
 * 只有字段缺失（新加的 agent / 没加载过的老数据）才需要拉。
 */
export function needsAcpModelLoad(agent: { models?: readonly unknown[] } | null | undefined): boolean {
  return agent != null && agent.models === undefined
}

/**
 * 模型清单加载失败：`message` 是给人看的一行结论；`detail` 只在 ACP 进程启动失败时
 * 才有（完整命令 / 工作目录）。选择器只显示 message，detail 放 title 供排查。
 */
export interface AcpModelLoadError {
  message: string
  detail?: string
}
