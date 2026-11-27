// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { McpPicker } from "@fizz/agent-kit/features/chat/McpPicker";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";

/**
 * 会话级 MCP 多选：**输入框上方工具条**里的扳手 pill（与「浏览器」并排 —— 两者同属
 * 「给这一轮装能力」；原先它挂在输入框右侧那排 pill 里，与「选择模型」相邻）。
 *
 * 语义：**这个会话允许用哪几个 MCP server**。默认一个都不选（存量会话天然如此），
 * 选中的会在下一轮对话被接进工具集 —— 未选的不起进程（见 `app/api/chat/route.ts`）。
 * 选「全不选」等价于清空；勾选后即时持久化到会话（刷新 / 重进都在）。
 *
 * 这不是「配置启停」：设置 → MCP 里配好 server 就有，这里只做**按会话挑**。
 * 控件本身在 `McpPicker`（定时任务表单也用同一颗）—— 这里只负责把 `app` 里的数据灌进去。
 */
export function McpSelect({ app }: { app: AgentApp }) {
  return (
    <McpPicker
      servers={app.mcpServers}
      value={app.mcpServerIds}
      onChange={app.setMcpServerIds}
      disabled={app.streaming || (!app.activeConversationId && app.creatingConversation)}
    />
  );
}
