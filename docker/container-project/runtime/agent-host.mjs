/**
 * 容器型项目镜像内的 **agent 控制面**（容器那一半）。
 *
 * 方向是**宿主 → 容器**：这里起一个 HTTP 服务（容器内 `:8080`，宿主从
 * `127.0.0.1:<分配端口>` 连它），宿主当客户端。为什么不是反过来（像 `agent-flow` 的
 * bridge 那样容器写盘 / 宿主读盘）：容器型项目的对话是**实时双向**的 —— 要问用户审批、
 * 要能中途「停止」，poll 文件要多绕两跳（见 spec §3.2）。
 *
 * 四条路由：
 * - `GET  /health`          —— 握手（版本核对 / envId / 挂载点）
 * - `POST /runs`            —— 起一轮（响应是 SSE，帧见下）
 * - `POST /runs/:id/answer` —— 用户对审批 / 追问的答复
 * - `POST /runs/:id/abort`  —— 中止（必须能打断 `await`，见下）
 *
 * 帧（`data:` 行的 JSON，宿主逐条转发进 `ChatStreamFrame` 那条通道）：
 * `{ type:'event', event }`（AgentStreamEvent）/ `{ type:'confirm-request', confirm }` /
 * `{ type:'followup-request', id, request }` / `{ type:'done', result }`。
 *
 * ⚠️ **本文件是独立 mjs、不在 `@fizz/*` 的构建里**，所以：
 *  - 它**不能** `import '@fizz/...'`，只 `import` 同目录的 `runtime.mjs`（bundle 产物）
 *    与 Node 内置模块；
 *  - `PROTOCOL_VERSION` 只能是与 `@fizz/contracts` 的 `CONTAINER_PROTOCOL_VERSION`
 *    **同值的字面量** —— 改一处必须改两处（宿主握手时会比对，不一致直接报重建容器）。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  runAgent,
  rawToolsPlugin,
  buildAgentTools,
  buildWebFetchTool,
  buildAskFollowupTool,
  filterToolSet,
  resolveContextWindow,
  defaultContextWindowFromEnv,
  CONTAINER_AGENT_TOOL_KEYS
} from './runtime.mjs'

/** 容器内监听端口（宿主侧由 `docker run -p 127.0.0.1:<分配>:8080` 映射过来） */
const PORT = Number(process.env.PORT ?? 8080)
/** 运行环境 id（各 env Dockerfile 的 `ENV FIZZ_CONTAINER_ENV=<id>` 设进来） */
const ENV_ID = process.env.FIZZ_CONTAINER_ENV ?? 'unknown'
/** ⚠️ 必须与 `@fizz/contracts` 的 `CONTAINER_PROTOCOL_VERSION` 同值 */
const PROTOCOL_VERSION = 1
/** 工作区挂载点（固定，不用环境变量传三遍） */
const WORKSPACE = '/workspace'
/** SSE 心跳间隔：宿主侧那条 fetch 是长连接，HTTP 空闲超时会把它掐断（同 server 的 15s 心跳） */
const HEARTBEAT_MS = 15_000

/**
 * 正在跑的那些 run（`runs` 表按 runId 寻址，答复 / 中止都命中它）。
 *
 * 每个：`{ runId, res, controller, pendingConfirms, pendingFollowups, finished, heartbeat }`。
 * 一轮结束（正常 / 出错 / 中止）就**从表里删掉** —— 宿主那边一轮一个 runId，不会复用。
 */
const runs = new Map()

// ---------- 小工具 ----------

/** 统一的 JSON 应答 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 读请求体（上限 64MB —— 历史消息带附件 base64 时不小） */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}

/** 容器内路径（一定 POSIX）取目录部分 */
function dirOf(path) {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : '/'
}

/**
 * 往 SSE 连接写一帧。
 *
 * 已结束（`finished`）之后一律不写：`done` 帧发完可能还有人试图补一帧，
 * 那种写入在已 `end()` 的响应上只会抛错。
 */
function writeFrame(run, frame) {
  if (run.finished || !run.res) return
  try {
    run.res.write(`data: ${JSON.stringify(frame)}\n\n`)
  } catch {
    // 连接已断：这一轮的收尾由 `res` 的 close 兜底（abort），不在这里重复处理
  }
}

// ---------- 路由：GET /health ----------

/**
 * 宿主握手用。
 *
 * 宿主拿到 `protocolVersion` 与自己的常量比对（不一致 = 镜像是旧版，报「请重建容器」），
 * 并确认 `workspace` 是约定的挂载点。
 */
function handleHealth(_req, res) {
  sendJson(res, 200, { ok: true, envId: ENV_ID, protocolVersion: PROTOCOL_VERSION, workspace: WORKSPACE })
}

// ---------- 路由：POST /runs ----------

/**
 * 组装这一轮的「静态部分」（系统提示词 + 工具集）。
 *
 * 三份现成工具合并后按 `CONTAINER_AGENT_TOOL_KEYS` 白名单过滤并注册为内置插件；缺键立即抛错，
 * 所以「宿主以为给了、容器实际没有」这种漂移在起跑那一刻就暴露。
 *
 * 提示词由宿主组装好整份传下来（服务端只有这一份口径），这里不重新拼。
 */
function makeAssembly(body, requestConfirm, ask, commandStops) {
  const skills = (body.skills ?? []).map((skill) => ({
    id: skill.path,
    name: skill.name,
    description: skill.description,
    dir: dirOf(skill.path),
    file: skill.path
  }))
  const tools = filterToolSet(
    {
      ...buildAgentTools(WORKSPACE, {
        permissionMode: body.permissionMode,
        // 权限档容器内是快照：**中途切档由宿主那一层修正**（见 turn.ts 的 confirmFromContainer）
        getPermissionMode: () => body.permissionMode,
        requestConfirm,
        skills,
        /**
         * 单条命令停止：宿主 `POST /api/chat/command/stop` 打不到容器里的进程，
         * 必须由这里把 `toolCallId → stop()` 登记出来，再经 `/runs/:id/command-stop` 调用。
         * 不登记的话，工具卡上的停止钮对容器型项目就是空成功（`{stopped:false}`）。
         */
        onCommandStart: (toolCallId, stop) => commandStops.set(toolCallId, stop),
        onCommandEnd: (toolCallId) => commandStops.delete(toolCallId)
      }),
      // web_fetch 同样接这张停止表（抓卡住的站点不该逼用户中止整轮）
      ...buildWebFetchTool(WORKSPACE, {
        onStart: (toolCallId, stop) => commandStops.set(toolCallId, stop),
        onEnd: (toolCallId) => commandStops.delete(toolCallId)
      }),
      ...buildAskFollowupTool({ ask }, body.runId)
    },
    [...CONTAINER_AGENT_TOOL_KEYS]
  )
  return {
    instructions: String(body.systemPrompt ?? ''),
    plugins: [{ plugin: rawToolsPlugin('container:tools', tools, { origin: 'builtin' }) }]
  }
}

/**
 * 起容器里的一轮。
 *
 * ⚠️ 审批 / 追问是**挂起等答复**：答复从 `POST /runs/:id/answer` 进来 resolve。
 * 收尾必须把它们全部 settle（见下面的 `finally`），否则这一轮永远卡在等答复上
 * —— 「挂起 → 广播 → 用户答 → resolve」这套里，每个出口都要 settle 是本仓库的硬约束。
 */
async function handleRuns(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    sendJson(res, 400, { error: `请求体不是合法 JSON：${describeError(err)}` })
    return
  }
  if (body?.protocolVersion !== PROTOCOL_VERSION) {
    sendJson(res, 400, {
      error: `容器内运行时版本不匹配（请求 ${body?.protocolVersion ?? '未知'} / 容器 ${PROTOCOL_VERSION}）`
    })
    return
  }
  const runId = typeof body.runId === 'string' ? body.runId : ''
  if (!runId) {
    sendJson(res, 400, { error: '缺少 runId' })
    return
  }
  if (runs.has(runId)) {
    sendJson(res, 409, { error: `runId 已在跑：${runId}` })
    return
  }

  const controller = new AbortController()
  const run = {
    runId,
    res: null,
    controller,
    /** 容器挂起的审批：id → resolve(approved) */
    pendingConfirms: new Map(),
    /** 容器挂起的追问：id → resolve(answer | null) */
    pendingFollowups: new Map(),
    /** 正在跑的命令：toolCallId → stop()（`/runs/:id/command-stop` 用） */
    commandStops: new Map(),
    finished: false,
    heartbeat: null
  }
  runs.set(runId, run)

  // 开 SSE：先回一条注释，客户端（宿主）拿到响应头就知道通道通了
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': ok\n\n')
  run.res = res
  run.heartbeat = setInterval(() => {
    if (!run.finished) {
      try {
        res.write(': ping\n\n')
      } catch {
        // 写不动了：`res` 的 close 事件会兜底 abort
      }
    }
  }, HEARTBEAT_MS)

  /** 容器向宿主发出的审批请求 */
  const requestConfirm = (reqConfirm) =>
    new Promise((resolve) => {
      const id = randomUUID()
      run.pendingConfirms.set(id, resolve)
      writeFrame(run, {
        type: 'confirm-request',
        confirm: {
          id,
          toolCallId: reqConfirm.toolCallId,
          toolName: reqConfirm.toolName,
          command: reqConfirm.command
        }
      })
    })

  /** 容器向宿主发问（宿主弹卡，答完回填） */
  const ask = (request) =>
    new Promise((resolve) => {
      const id = randomUUID()
      run.pendingFollowups.set(id, resolve)
      writeFrame(run, { type: 'followup-request', id, request })
    })

  let assembly
  try {
    assembly = makeAssembly(body, requestConfirm, ask, run.commandStops)
  } catch (err) {
    // 工具集过滤失败（白名单漂移）属于部署事故：如实报出去，别让这一轮静默少工具
    clearInterval(run.heartbeat)
    writeFrame(run, { type: 'done', result: { finishReason: 'error', error: describeError(err) } })
    run.finished = true
    runs.delete(runId)
    res.end()
    return
  }

  const model = body.model ?? {}
  const contextWindow = resolveContextWindow(
    model.contextWindows,
    model.model,
    defaultContextWindowFromEnv()
  )

  /** 这一轮完成的信号：`runAgent` 自己返回，或 abort 抢先（`undefined` = 被 abort 打断） */
  const agentPromise = runAgent({
    // 容器里的会话恒定绑定 `/workspace`（global 作用域没有意义：容器本来就是一个工作区）
    scope: { kind: 'workspace', workspace: { id: runId, name: ENV_ID, path: WORKSPACE } },
    history: Array.isArray(body.history) ? body.history : [],
    evidenceHistory: Array.isArray(body.evidenceHistory) ? body.evidenceHistory : undefined,
    // 压缩检查点的复用键（宿主每轮传同一个会话 id）：不传就每轮重摘要一次
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
    /**
     * 宿主上一轮落盘的检查点。容器**不持久化任何东西**（连密钥都不落盘，更别说摘要），
     * 所以这里必须由宿主带回来 —— 不带的话容器一重启（换镜像 / docker restart），
     * 内存里的 `autoSummaryCache` 就没了，这一轮会把整段历史重新摘要一次。
     */
    ...(body.autoSummarySeed && typeof body.autoSummarySeed === 'object'
      ? { autoSummarySeed: body.autoSummarySeed }
      : {}),
    model,
    // 装配完全由 `assemble` 决定（提示词由宿主给全）；skills / projectDoc 不再参与装配
    skills: [],
    permissionMode: body.permissionMode,
    requestConfirm,
    // 装配产物在起跑前定稿：白名单漂移必须在开流前报错，而不是等模型请求回来
    assemble: () => assembly,
    contextWindow,
    signal: controller.signal,
    onEvent: (event) => writeFrame(run, { type: 'event', event }),
    /**
     * 交接文档的三帧都靠**显式回调**转发（`runAgent` 不会把压缩事件走 `onEvent`）：
     * 少了 start / delta 这两条，容器型项目就看不到「正在压缩」的流式文档，
     * 只剩一条结束通知。宿主收到后原样进 `ChatStreamFrame` 通道，前端一条链路都不用改。
     */
    onContextCompactionStart: (info) =>
      writeFrame(run, { type: 'event', event: { type: 'context-compaction-start', ...info } }),
    onContextCompactionDelta: (info) =>
      writeFrame(run, { type: 'event', event: { type: 'context-compaction-delta', ...info } }),
    onContextCompressed: (info) => writeFrame(run, { type: 'event', event: { type: 'context-compressed', ...info } }),
    /**
     * 刚落下检查点：交给宿主持久化（容器不写盘）。宿主落盘后下一轮当 seed 送回来，
     * 所以这条帧丢了只会让下一轮多一次摘要调用，不会影响正确性 —— 但仍要发：
     * 「容器重启一次就整段重摘要」正是缺了它。
     */
    onAutoSummary: (entry) => writeFrame(run, { type: 'auto-summary', entry }),
    onMidTurnSummary: (entry) => writeFrame(run, { type: 'mid-turn-summary', entry })
  }).catch((err) => ({ finishReason: 'error', error: describeError(err) }))

  const aborted = new Promise((resolve) => {
    if (controller.signal.aborted) resolve(undefined)
    else controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })

  // 客户端（宿主）断开 = 这一轮没人要了：abort 掉（安全性网，正常结束时会先走到 finally）
  res.on('close', () => {
    if (!run.finished) controller.abort()
  })

  let result
  try {
    /**
     * ⚠️ **必须 `Promise.race`**：`runAgent` 可能正 `await` 在模型流上，仅置 abort 标志
     * 不保证它立刻醒（与 ACP 那个坑同源）。abort 先赢时这里直接收尾，不再等 agentPromise
     * —— 它自己会因 abortSignal 结束（`catch` 已吞掉拒绝，不会有 unhandled rejection）。
     */
    result = await Promise.race([agentPromise, aborted])
    if (result === undefined) result = { finishReason: 'aborted' }
  } catch (err) {
    result = { finishReason: 'error', error: describeError(err) }
  } finally {
    // 收尾：把挂起的一切 settle 掉（**绝不能留挂起的 Promise**），停心跳，发 done，关连接
    for (const resolve of run.pendingConfirms.values()) resolve(false)
    run.pendingConfirms.clear()
    for (const resolve of run.pendingFollowups.values()) resolve(null)
    run.pendingFollowups.clear()
    clearInterval(run.heartbeat)
    // ⚠️ 顺序：`done` 帧必须**先写**、再置 `finished`（writeFrame 对已 finished 的 run 直接返回）
    writeFrame(run, { type: 'done', result })
    run.finished = true
    runs.delete(runId)
    res.end()
  }
}

// ---------- 路由：POST /runs/:id/answer ----------

/**
 * 用户对审批（`kind: 'confirm'`）或追问（`kind: 'followup'`）的答复。
 *
 * 找不到挂起项（重复投递 / 已经超时收尾）**不报错**：这一轮可能刚好结束了，
 * 静默忽略比回 500 让宿主重试更稳（宿主那侧发失败本来也只记日志）。
 */
async function handleAnswer(req, res, id) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    sendJson(res, 400, { error: `请求体不是合法 JSON：${describeError(err)}` })
    return
  }
  const run = runs.get(id)
  if (!run) {
    sendJson(res, 200, { ok: false, reason: 'no-such-run' })
    return
  }
  if (body?.kind === 'confirm') {
    const resolve = run.pendingConfirms.get(body.id)
    if (resolve) {
      run.pendingConfirms.delete(body.id)
      resolve(Boolean(body.approved))
    }
  } else if (body?.kind === 'followup') {
    const resolve = run.pendingFollowups.get(body.id)
    if (resolve) {
      run.pendingFollowups.delete(body.id)
      resolve(body.answer ?? null)
    }
  }
  sendJson(res, 200, { ok: true })
}

// ---------- 路由：POST /runs/:id/abort ----------

function handleAbort(_req, res, id) {
  const run = runs.get(id)
  if (!run) {
    sendJson(res, 200, { ok: false, reason: 'no-such-run' })
    return
  }
  run.controller.abort()
  sendJson(res, 200, { ok: true })
}

// ---------- 路由：POST /runs/:id/command-stop ----------

/**
 * 停掉这一轮里正在跑的那条命令（工具卡上的停止钮）。
 *
 * 和 `/abort` 的区别：只杀命令、不动这一轮 —— 模型会收到「已中止」的工具结果并继续。
 * 找不到 `toolCallId`（命令刚好自己结束 / 重复投递）**不报错**：宿主那侧按
 * `{stopped:false}` 静默处理即可，和宿主本地的 `run.commandStops` 同语义。
 */
async function handleCommandStop(req, res, id) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    sendJson(res, 400, { error: `请求体不是合法 JSON：${describeError(err)}` })
    return
  }
  const run = runs.get(id)
  if (!run) {
    sendJson(res, 200, { stopped: false, reason: 'no-such-run' })
    return
  }
  const toolCallId = typeof body?.toolCallId === 'string' ? body.toolCallId : ''
  const stop = toolCallId ? run.commandStops.get(toolCallId) : undefined
  if (!stop) {
    sendJson(res, 200, { stopped: false })
    return
  }
  run.commandStops.delete(toolCallId)
  stop()
  sendJson(res, 200, { stopped: true })
}

// ---------- 分发 ----------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (req.method === 'GET' && path === '/health') return handleHealth(req, res)

    // `/runs/<id>/answer`、`/runs/<id>/abort`、`/runs/<id>/command-stop`：id 是宿主 encodeURIComponent 过的
    const match = /^\/runs\/([^/]+)\/(answer|abort|command-stop)$/.exec(path)
    if (req.method === 'POST' && match) {
      const id = decodeURIComponent(match[1])
      if (match[2] === 'answer') return handleAnswer(req, res, id)
      if (match[2] === 'command-stop') return handleCommandStop(req, res, id)
      return handleAbort(req, res, id)
    }
    if (req.method === 'POST' && path === '/runs') return handleRuns(req, res)

    sendJson(res, 404, { error: `未知路由：${req.method} ${path}` })
  } catch (err) {
    sendJson(res, 500, { error: describeError(err) })
  }
})

// ⚠️ 绑 `0.0.0.0` 而不是 `127.0.0.1`：宿主是通过 docker 的端口映射连进来的，
/// 容器内绑回环的话映射过去连不上。宿主侧那条 `-p 127.0.0.1:<port>:8080` 才是「只暴露本机」
// 的那道闸。
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[fizz-container] agent 控制面已监听 :${PORT}（envId=${ENV_ID} protocol=${PROTOCOL_VERSION}）`)
})
