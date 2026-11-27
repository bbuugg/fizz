/** SSH 终端助手：文件与命令绑定远端 backend，和用户的交互式终端分离。 */
import { fileToolsPlugin, type AgentAssembly } from '@fizz/agent'
import type { AgentToolOptions } from '@fizz/tools'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'

export interface TerminalAssistantDeps {
  hostLabel: string
  backend: WorkspaceBackend
  options: Omit<AgentToolOptions, 'backend' | 'includeTools'>
}

export function buildTerminalAssistantInstructions(hostLabel: string, cwd: string): string {
  return [
    '你是 Fizz 的 SSH 终端助手，负责排查和操作绑定的远端主机。',
    `执行目标：${hostLabel}。默认工作目录：${cwd}。`,
    '文件工具 read / write / edit / glob / grep 全部作用于这台远端主机，bash 经独立 SSH exec 通道执行。',
    '约定：',
    '- 用户眼前的终端是独立的交互式 shell：你不能读取它的屏幕、向它输入命令或发送按键。不要声称看到了终端输出。',
    '- 绝对路径指远端文件系统；相对路径基于上述默认目录。可按需访问 /etc、/var/log 等目录，权限由远端 SSH 账号决定。',
    '- 每条 bash 命令独立执行，不继承用户终端或上一次命令的 cd、export、虚拟环境、sudo 状态；用 workdir 指定目录，初始化与实际命令放在同一次调用。',
    '- 优先用 read / glob / grep 读取和搜索，用 write / edit 修改文件；修改已有文件前先 read，避免覆盖用户刚做的修改。',
    '- 先查看状态再修改；执行命令前简要说明目的，删除、重启服务、修改配置前说明影响。遵守工具权限审批。',
    '- 有依赖的操作按顺序执行，确认上一条命令结果后再继续；以工具返回的实际输出和退出状态为依据。',
    '- 使用非交互命令：例如 top -b -n 1、tail -n 100；不要启动 vim / less / 交互式 sudo。需要提权时用 sudo -n，失败就说明原因。',
    '- 长构建、安装、持续服务可用 run_in_background，任务日志与取消入口在后台任务面板。已转后台的命令不会因为关闭面板或本轮结束而停止。',
    '- 不负责项目、模型、MCP、ACP 等全局配置管理，这类请求请用户去项目助手。',
    '- 用简洁的中文回复。'
  ].join('\n')
}

export function buildTerminalAssistantAssembly(deps: TerminalAssistantDeps): AgentAssembly {
  return {
    instructions: buildTerminalAssistantInstructions(deps.hostLabel, deps.backend.root),
    plugins: [{
      plugin: fileToolsPlugin(deps.backend.root, {
        ...deps.options,
        backend: deps.backend,
        includeTools: ['read', 'write', 'edit', 'glob', 'grep', 'bash']
      })
    }]
  }
}
