/**
 * 常见外部 ACP agent 的预设清单（图标见 `shared/components/AcpAgentIcon`）。
 *
 * 来源：codeg 的内置注册表（`src-tauri/src/acp/registry.rs` 的 `AcpAgentMeta`）。
 * 这里只保留 fizz 用得到的三样：**展示名、启动命令、启动参数**。
 *
 * ⚠️ `args` 必须是该 CLI 真实存在的 ACP 入口。改之前先确认：猜错的表现是
 * 「点了添加、一发消息就报未知参数」，而设置页看不出任何异常。
 * 其中 opencode / pi / gemini / codex / claude-agent 这几条与
 * `apps/server/src/server/acp-detect.ts` 的探测口径保持一致。
 *
 * 预设**不会自动落库**：设置页把它们列出来，点一下只是把默认命令与参数
 * 填进新增表单，用户仍可改参数再保存（`AcpAgentConfig` 的真源永远是用户自己存的那份）。
 */
import type { AcpAgentType } from '@fizz/acp'

export interface AcpAgentPreset {
  /** 稳定标识，同时也是图标的键（`AcpAgentIcon` 按它对图标） */
  id: string
  /** 展示名（产品名，不翻译） */
  name: string
  /** 默认启动命令（PATH 可解析名；Windows 的 .cmd 由 @fizz/acp 自己包 cmd.exe） */
  command: string
  /** 默认启动参数 */
  args: string[]
  /** 会话里的模式 UI 语义；缺省 = generic（不显示模式 UI） */
  type?: AcpAgentType
}

export const ACP_AGENT_PRESETS: AcpAgentPreset[] = [
  { id: 'claude_code', name: 'Claude Code', command: 'claude-agent-acp', args: [] },
  { id: 'codex', name: 'Codex CLI', command: 'codex-acp', args: [] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { id: 'open_claw', name: 'OpenClaw', command: 'openclaw', args: ['acp'] },
  { id: 'open_code', name: 'OpenCode', command: 'opencode', args: ['acp'], type: 'opencode' },
  { id: 'cline', name: 'Cline', command: 'cline', args: ['--acp'] },
  { id: 'hermes', name: 'Hermes Agent', command: 'hermes', args: ['acp'] },
  { id: 'code_buddy', name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'] },
  { id: 'kimi_code', name: 'Kimi Code', command: 'kimi', args: ['acp'] },
  { id: 'pi', name: 'Pi', command: 'pi-acp', args: [], type: 'pi' },
  { id: 'grok', name: 'Grok', command: 'grok', args: ['agent', 'stdio'] },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', args: ['acp'] },
  { id: 'deepseek', name: 'DeepSeek Harness', command: 'deepseek-acp', args: [] },
  { id: 'qoder', name: 'Qoder', command: 'qoder', args: ['--acp'] },
  { id: 'antigravity', name: 'Google Antigravity', command: 'agy_acp_server', args: [] },
  { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli', args: ['acp'] },
  { id: 'zcode', name: 'ZCode', command: 'zcode-acp-server', args: ['server'] },
  { id: 'trae', name: 'TRAE CLI', command: 'traecli', args: ['acp', 'serve'] },
  { id: 'command_code', name: 'Command Code', command: 'command-code', args: ['acp'] },
  { id: 'minimax_code', name: 'MiniMax Code', command: 'mcode', args: ['acp'] }
]

/**
 * 命令的可执行文件名：去目录、去 Windows 的 `.exe/.cmd/.bat`、转小写。
 * 配置里既可能是 `gemini`，也可能是 `C:\Users\x\AppData\Roaming\npm\gemini.cmd`。
 */
export function acpCommandBasename(command: string): string {
  const file = command.trim().split(/[\\/]/).pop() ?? ''
  return file.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/**
 * 按命令找预设。**只看命令、不看参数**：用户可能改过启动参数（比如给 Gemini
 * 加 `--skip-trust`），但它仍然是同一个 agent，图标与「已添加」标记不该因此丢掉。
 */
export function findAcpPreset(command: string): AcpAgentPreset | null {
  const base = acpCommandBasename(command)
  if (!base) return null
  return ACP_AGENT_PRESETS.find((preset) => preset.command.toLowerCase() === base) ?? null
}
