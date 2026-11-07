/**
 * 会话路由：列表（无消息）/ 创建。
 *
 * 列表默认不带消息体（消息可能很大，列表只要元信息）。
 * 桌面端引导加载需要全文，用 ?full=1 让服务端返回含完整消息的会话全集。
 */
import { randomUUID } from 'node:crypto'
import { isRemoteWorkspace } from '@fizz/contracts/types'
import { abortAcpTurn, createAcpSession } from '@fizz/acp'
import { domain } from '@/lib/server/state'
import { ensurePiConfirmExtension } from '@/lib/server/acp-extension'
import {
  conversationCreateFields,
  type ConversationCreateBody
} from '@/lib/server/conversation-create-fields'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get('full') === '1') {
    return Response.json(domain.listConversationsFull())
  }
  return Response.json(domain.listConversations())
}

export async function POST(request: Request) {
  /**
   * 请求体字段的取舍**只在 `conversationCreateFields` 一处**。
   *
   * 以前这里内联了一份 `parseJsonBody<{...}>` 类型，漏掉 `mcpServerIds` /
   * `browserSettings` 两个字段 —— 草稿页勾的 MCP 与开的浏览器传到服务端后被直接丢掉，
   * 落库的会话是「全不选 + 关」，下次清单刷新就把界面覆盖回去。
   */
  const input = await parseJsonBody<ConversationCreateBody>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  if (input.kind === 'collab' && input.backend === 'acp') {
    return jsonError(400, '多智能体协作会话只支持内置 Agent，不支持 ACP 后端')
  }

  /**
   * 归属解析：
   *
   * - 给了 `workspaceId` → 必须是登记过的项目；
   * - **没给**（输入框下方「不选项目」直接发消息）→ 当场建一个**临时工作区**，目录
   *   `<数据目录>/conversations/<会话 id>`，会话绑上去。会话的 `workspaceId` 落库后
   *   不可改，所以「没选项目」只能在创建这一刻兑现，不能事后补绑。
   */
  const id = input.id ?? randomUUID()
  let workspace = input.workspaceId ? domain.getWorkspace(input.workspaceId) : undefined
  if (input.workspaceId && !workspace) return jsonError(400, '工作区不存在，请先创建工作区')
  if (!workspace) {
    try {
      workspace = await domain.ensureScratchWorkspace(id)
    } catch (err) {
      const { status, message } = describeError(err)
      return jsonError(status, message)
    }
  }
  const workspaceId = workspace.id
  /**
   * 目录被删 / 被移走：登记表里还在，但建会话必然落空（要往目录里建 `.fizz/conversation/`，
   * 会话跑起来也要它）。**所有新建入口共用这一处**（侧栏按钮 / 命令面板 / 快捷键 /
   * 空白页写回）—— 前端的禁用只是体验，这里才是真拦。
   *
   * `dirMissing` 是巡检（30s 一轮）给的结论，快但可能慢半拍，所以这里**自己再 stat 一次**
   * 做权威判定：目录刚被删、巡检还没跑到的那几秒里也能立刻拒掉。
   * `path` 为空的虚拟工作区（「任务」/「项目助手」）没有目录概念，跳过。
   */
  const remote = isRemoteWorkspace(workspace)
  if (remote) {
    // 远端目录不能在本机 stat：「目录在不在」只认巡检给的结论（SFTP 探测，连不上不置位）。
    // 这里不额外连一次 SSH —— 建会话本身不等同于要用远端，连不上应该由本轮对话明确报错。
    if (workspace.dirMissing) {
      return jsonError(400, `远端工作区目录不存在：${workspace.path}（可能已被删除或移动）`)
    }
    if (input.backend === 'acp') {
      return jsonError(400, '远端工作区首期不支持外部 Agent（ACP），请改用内置 Agent')
    }
  } else if (workspace.path && !(await domain.isWorkspaceDirAvailable(workspace.path))) {
    return jsonError(400, `工作区目录不存在：${workspace.path}（可能已被删除或移动）`)
  }

  /**
   * ACP 会话：**先 `session/new` 再落库**。
   *
   * 新建时就要把 agent 侧的 sessionId 与它广告的档位绑定到会话，所以这里先建真的 agent 会话；
   * 失败（命令不存在 / 不是 ACP agent / agent 报错）一律**不留会话**，并把已 spawn 的进程收掉。
   *
   * ⚠️ **带 `acpSessionId` 的例外**（导入既有会话）：那是把 agent 侧已经存在的会话绑到本地，
   * 不能再 `session/new`（会另造一个新会话、把导入的那个丢掉）—— 直接走下面的普通落库分支。
   */
  if (input.backend === 'acp' && !input.acpSessionId) {
    // 工作区存在性与「目录还在不在」上面已经查过，这里只剩 ACP 自己的要求：
    // 外部 agent 要一个真实 cwd 才能起进程 —— path 为空的虚拟工作区直接拒
    const workspacePath = workspace.path
    if (!workspacePath) return jsonError(400, 'ACP 会话需要绑定到有目录的工作区')
    let agent
    try {
      agent = domain.resolveAcpAgent(input.configId ?? '')
    } catch (err) {
      const { status, message } = describeError(err)
      return jsonError(status, message)
    }
    // pi 的权限询问要靠扩展：**在 session/new 之前**装进项目（pi 是启动时加载扩展的）。
    // 已存在同名文件则跳过；装不上也不挡住建会话（最坏是 pi 照旧不问）。
    ensurePiConfirmExtension(agent, workspacePath)
    try {
      const ready = await createAcpSession({
        agent,
        conversationId: id,
        workspacePath
      })
      const conversation = domain.saveConversation({
        ...conversationCreateFields(input),
        id,
        workspaceId,
        // agent 侧真建出来的那个盖过请求体（含 configId / sessionId / 广告的档位）
        backend: 'acp',
        configId: agent.id,
        acpSessionId: ready.sessionId,
        ...(ready.modes ? { acpModes: ready.modes } : {}),
        ...(ready.thoughtLevel ? { acpThoughtLevel: ready.thoughtLevel } : {})
      })
      return Response.json({ ...conversation, messageCount: conversation.messages.length })
    } catch (err) {
      // 建会话失败 / 落库失败：把已 spawn 的 agent 进程收掉，别留孤儿进程
      abortAcpTurn(agent.id, id)
      const { status, message } = describeError(err)
      return jsonError(status, message)
    }
  }

  try {
    const conversation = domain.saveConversation({
      ...conversationCreateFields(input),
      id,
      workspaceId
    })
    return Response.json({ ...conversation, messageCount: conversation.messages.length })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

