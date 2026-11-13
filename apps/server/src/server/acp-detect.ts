/**
 * 扫 PATH 上已装的 ACP agent（只读探测）。
 *
 * 两个调用方共用这一份：`GET /api/acp/detect`（设置页「一键添加」）与项目助手的
 * `detect_acp_agents` 工具。**候选清单只写在这里** —— 参数写错的表现是「用户点了添加、
 * 一发消息就报未知参数」，所以每条 `args` 都必须是该 CLI 真实存在的 ACP 入口，
 * 改之前先确认。
 */
import { spawn } from 'node:child_process'
import type { DetectedAcpAgent } from '@fizz/contracts/agent-api'

/**
 * 已知 ACP agent 的候选清单：命令在 PATH 上命中才列出，用户点「添加」才落库。
 *
 * ⚠️ `args` 必须是**该 CLI 真实存在的 ACP 入口**。这里只判「命令装没装」，判不了
 * 「参数对不对」，猜错的表现是用户点了添加、一发消息就报未知参数（或进程直接退出）。
 * 现已核实的口径：
 * - Gemini CLI：`gemini --acp`（早年的 `--experimental-acp` 已弃用）；
 * - Copilot CLI：`copilot --acp`（public preview，缺省就是 stdio）；
 * - opencode：子命令 `opencode acp`。
 *
 * **Codex 没有 `codex --acp` 这个开关**（曾经猜过、后已移除）：Codex CLI 本体不实现
 * ACP，官方路径是 adapter —— `codex-acp`（`npm i -g @zed-industries/codex-acp` 后的
 * 二进制名），它内部用 `codex -c model_provider=acp` 起 Codex（那是配置覆盖，不是 ACP
 * 模式）。所以这块只探 `codex-acp`：装了 codex 但没装 adapter 的用户不会看到候选，
 * 这是对的 —— 那种组合起不来 ACP。
 */
const ACP_CANDIDATES: Array<Omit<DetectedAcpAgent, 'path'>> = [
  { name: 'Codex CLI', command: 'codex-acp', args: [] },
  { name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { name: 'Claude Agent', command: 'claude-agent-acp', args: [] },
  { name: 'Copilot', command: 'copilot', args: ['--acp'] },
  { name: 'opencode', command: 'opencode', args: ['acp'] },
  { name: 'Pi', command: 'pi-acp', args: [] }
]

function probePath(command: string): Promise<string | null> {
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    const child = spawn(isWin ? 'where' : 'which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const first = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      resolve(code === 0 && first ? first : null)
    })
  })
}

/** 逐个探测候选命令；返回命中的那些（带解析到的绝对路径） */
export async function detectAcpAgents(): Promise<DetectedAcpAgent[]> {
  const found: DetectedAcpAgent[] = []
  for (const candidate of ACP_CANDIDATES) {
    const path = await probePath(candidate.command)
    if (path) found.push({ ...candidate, path })
  }
  return found
}
