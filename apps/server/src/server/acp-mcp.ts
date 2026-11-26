/** 会话选中的 MCP → ACP 连接配置。完整凭据只在服务端传给外部 agent。 */
import type { AcpMcpServer } from '@fizz/acp'
import { normalizeMcpTransport, type McpServerConfig } from '@fizz/mcp/types'

export function acpMcpServers(
  servers: McpServerConfig[],
  mcpServerIds: string[] = []
): AcpMcpServer[] {
  const chosen = new Set(mcpServerIds)
  return servers.filter((server) => chosen.has(server.id)).flatMap((server): AcpMcpServer[] => {
    const type = normalizeMcpTransport(server.transport)
    if (type === 'stdio') {
      const command = server.command?.trim()
      if (!command) return []
      return [{
        type,
        name: server.name,
        command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
      }]
    }
    const url = server.url?.trim()
    if (!url) return []
    return [{
      type,
      name: server.name,
      url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
    }]
  })
}
