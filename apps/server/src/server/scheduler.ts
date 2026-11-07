/**
 * 定时任务调度器（进程内 cron）：到点自动起会话。
 *
 * ## 演进：为什么从 BullMQ + Redis 换回进程内 cron
 *
 * BullMQ 那版（原 `lib/server/queue.ts`）把调度投影存进 Redis，换来的是「进程重启
 * 调度器还在」；代价是**必须养一个 Redis** —— 而定时任务的真源本来就在 JsonStore 里
 * （状态全在磁盘），单进程部署下 Redis 没有提供任何 JsonStore 给不了的东西，反而
 * 多了一个「Redis 没起来定时任务就不跑」的依赖。现在换回单进程调度：
 * - **cron → 15 秒轮询**：cron 的最小单位是分钟，15 秒的检查间隔精度足够；
 *   用 `cron-parser` 的 `prev()` 判「这个触发时刻是否落在本轮窗口内」，表达式语法
 *   与校验路由、旧 BullMQ 都是同一套；
 * - **at（一次性）→ setTimeout**：到点精确触发一次；服务重启后按 JsonStore 里的
 *   `lastTriggeredAt === undefined` 重新武装，错过到点时刻的（服务当时没开）立即补跑。
 *
 * ## 持久化与重启语义
 *
 * 状态真源是 JsonStore（`triggerDomain`）：一次性任务靠 `lastTriggeredAt` 保证只跑一次
 * （标记在会话建出来时就落盘，见 `processFire`）；cron 任务本身无状态，重启后从
 * 「调度器启动时刻」开始判定 —— **启动前错过的 cron 轮次不补跑**（与旧 Redis 版
 * 「服务停机期间的到点作业丢失」口径一致，避免重启后突然冒出一批过期的会话）。
 *
 * ## 并发
 *
 * 并发上限 3（与旧 BullMQ worker 的 `concurrency: 3` 一致）：多个定时任务同时到点时
 * 在内存里排队，单个会话跑几分钟也不堵死别的。
 */
import { randomUUID } from 'node:crypto'
import { parseExpression } from 'cron-parser'
import { isRemoteWorkspace, type TaskTrigger } from '@fizz/contracts/types'
import { domain, triggerDomain } from './state'
import { refreshPluginModels } from './plugin-models'

/** cron 轮询间隔：cron 最小单位是分钟，15 秒精度足够，且空转成本只是几次表达式解析 */
const TICK_MS = 15_000
/** 并发上限：同时最多 3 轮触发会话在跑，其余排队 */
const CONCURRENCY = 3
/** 无人值守会话里等用户答复的最长时间（提问没人答就按「跳过」放行，别把槽位挂死） */
const UNATTENDED_WAIT_MS = 10 * 60 * 1000

/** 一次触发的结果：记录到日志里，能看出这轮跑出了哪个会话 */
export interface TriggerFireResult {
  conversationId?: string
  finishReason?: string
  skipped?: string
}

interface AtTimer {
  /** 武装时的目标时刻：定时任务被改到别的时刻 → 旧定时器作废重建 */
  at: number
  timer: NodeJS.Timeout
}

interface SchedulerState {
  started: boolean
  /** 调度器启动时刻：cron 只补跑这之后的轮次（见文件头「重启语义」） */
  startedAt: number
  tickTimer?: NodeJS.Timeout
  atTimers: Map<string, AtTimer>
  /** 已派发过的 cron 触发时刻（同一分钟内多次 tick 去重） */
  lastCronFire: Map<string, number>
  /** 正在跑的触发会话数 */
  running: number
  /** 并发满时排队的派发任务 */
  pending: Array<() => void>
}

const GLOBAL_KEY = '__FIZZ_TRIGGER_SCHEDULER__'

function s(): SchedulerState {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as SchedulerState | undefined
  if (existing) return existing
  const state: SchedulerState = {
    started: false,
    startedAt: 0,
    atTimers: new Map(),
    lastCronFire: new Map(),
    running: 0,
    pending: []
  }
  ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = state
  return state
}

// ---------------------------------------------------------------------------
// 派发（并发上限 + 内存排队）
// ---------------------------------------------------------------------------

/** 并发没满就立即跑，满了排队；槽位释放时按先进先出补位 */
function dispatch(state: SchedulerState, run: () => Promise<unknown>): void {
  const start = (): void => {
    state.running++
    run()
      .catch(() => {}) // processFire 内部已打日志，这里只兜住不让派发链断掉
      .finally(() => {
        state.running--
        const next = state.pending.shift()
        if (next) next()
      })
  }
  if (state.running < CONCURRENCY) start()
  else state.pending.push(start)
}

// ---------------------------------------------------------------------------
// 派发后做什么 —— 不起容器，起会话（与旧 queue.ts 的 processFire 一致）
// ---------------------------------------------------------------------------

/**
 * 触发会话「拿什么跑」—— 后端 + 配置（+ 可选的模型）。
 *
 * 两种后端的语义差别很大，所以做成判别联合而不是「一堆可选字段」：
 * - `builtin`：配置 = `AiModelConfig.id`，模型**必选**（不存在「配置默认模型」）；
 * - `acp`：配置 = `AcpAgentConfig.id`，模型可省（省 = agent 自己的默认，与手动会话
 *   的「跟随 agent 默认」同一套）。
 */
type HeadlessTarget =
  | { backend: 'builtin'; configId: string; modelId: string }
  | { backend: 'acp'; configId: string; modelId?: string }

/**
 * 从模板取「拿什么跑」：**必须是显式选过的**（表单里选的，或 `create_task_trigger` 从当轮
 * 继承下来的）。不存在「清单第一份 / 配置默认」的隐式回退 —— 回退等于替用户换一个模型跑，
 * 而定时任务无人值守，跑错了旁边没人当场看见（与 `domain.resolveModelConfig` 同一口径）。
 * 配置 / agent 被删时也只报一句点名的人话，不拿别的顶上。
 *
 * `acp` 的 `modelId` 是 agent 广告的模型值，**允许失效**：agent 升级后清单会变，那时只打
 * 一行警告、按 agent 默认跑 —— 它本来就是可选绑定（省了就是默认），拒跑反而会让一条
 * 好好的任务突然不再工作。
 */
function resolveHeadlessTarget(trigger: TaskTrigger): HeadlessTarget {
  const { backend, configId, modelId } = trigger.template
  // 存量记录没有 backend 字段 = 那时只支持内置模型
  if (backend === 'acp') {
    if (!configId) {
      throw new Error(`定时任务「${trigger.name}」还没有选择外部 Agent：请编辑它，选好之后再启用`)
    }
    let agent
    try {
      agent = domain.resolveAcpAgent(configId)
    } catch {
      throw new Error(`定时任务「${trigger.name}」绑定的外部 Agent 已被删除：请编辑它重新选择`)
    }
    if (modelId && !(agent.models ?? []).some((m) => m.value === modelId)) {
      console.warn(
        `[triggers] 定时任务「${trigger.name}」绑定的模型「${modelId}」不在外部 Agent「${agent.name}」当前暴露的清单里，本次按 agent 默认跑`
      )
      return { backend: 'acp', configId }
    }
    return { backend: 'acp', configId, ...(modelId ? { modelId } : {}) }
  }

  if (!configId || !modelId) {
    throw new Error(`定时任务「${trigger.name}」还没有选择模型：请编辑它，选好模型后再启用`)
  }
  const config = domain.listModels().find((m) => m.id === configId)
  if (!config) {
    throw new Error(`定时任务「${trigger.name}」绑定的模型配置已被删除：请编辑它重新选择模型`)
  }
  if (!config.models.some((m) => m.id === modelId)) {
    throw new Error(
      `定时任务「${trigger.name}」绑定的模型「${modelId}」不在配置「${config.name}」里（可能已被删）：请重新选择模型`
    )
  }
  return { backend: 'builtin', configId, modelId }
}

/** `processFire` 的派发来源：面板上点「立即运行」时要绕过「已停用 / 一次性已跑过」两道闸 */
interface ProcessFireOptions {
  /**
   * 手动运行：跳过「已停用」与「一次性已经触发过」两道闸，
   * **其余校验（模型 / external agent / 工作区 / 权限）一条不少**。
   */
  manual?: boolean
}

async function processFire(
  triggerId: string,
  options: ProcessFireOptions = {}
): Promise<TriggerFireResult> {
  // 无头任务也可能绑插件注册的模型：解析前刷新一次
  await refreshPluginModels()
  const trigger = triggerDomain.getTrigger(triggerId)
  if (!trigger) return { skipped: '定时任务已删除' }
  if (!trigger.enabled && !options.manual) return { skipped: '定时任务已停用' }
  // 一次性任务的第二道闸（第一道在 armAtTriggers 的武装条件上）。
  //
  // 旧版把 markTriggered 放在 `await run.done` 之后，于是「进程在会话跑一半时被杀掉」
  // 这条路径上：lastTriggeredAt 永远没落 → 重启后又触发一次 → **重复触发**。
  // 标记前移到「会话建出来」那一刻堵住这个窗口；重启后按 lastTriggeredAt 武装的
  // armAtTriggers 是另一道闸，两道都留。
  if (!options.manual && trigger.at !== undefined && trigger.lastTriggeredAt !== undefined) {
    return { skipped: '一次性任务已经触发过' }
  }

  // 模型先校验：没选 / 被删的任务在这里就拒跑，不往下建临时工作区（否则每轮都
  // 在数据目录里留一个空目录，还得靠用户自己发现「怎么什么都没跑」）
  const target = resolveHeadlessTarget(trigger)

  /**
   * 权限档：表单里选的那个，**缺省仍是完全访问**（无人值守的默认答案 —— 没有人在旁边
   * 点确认）。`confirm` 会被原样带下去，但它是「等不到人就拒绝」：`guardWrite` 拿不到
   * 答复按 fail-closed 处理，这轮会「什么都没干」地结束。表单里选它时已有醒目提示，
   * 这里只补一条服务端日志，方便事后对账，**不替用户改档**。
   *
   * ACP 后端的等价物是会话上的 `acpPermissionMode`（agent 自己发权限请求）：`full` 才
   * 自动放行（`allow`），其余档一律 `confirm` —— 无人值守时那就是「等 10 分钟然后拒绝」，
   * 所以下面额外打一条警告。
   */
  const permissionMode = trigger.template.permissionMode ?? 'full'
  if (permissionMode === 'confirm') {
    console.warn(
      `[triggers] 定时任务「${trigger.name}」用的是确认档，但无人值守没有审批人：写操作会被拒绝`
    )
  }
  if (target.backend === 'acp' && permissionMode !== 'full') {
    console.warn(
      `[triggers] 定时任务「${trigger.name}」跑的是外部 Agent，但权限档是「${permissionMode}」：agent 发来的权限请求等不到人答复，超时后会被拒绝`
    )
  }

  /**
   * 工作区解析：绑了就落在绑的那个；**没绑（或绑的那个已被删）就当场建一个临时工作区**
   * —— 与「新建会话时不选工作区」同一套（`ensureScratchWorkspace`：目录在
   * `<数据目录>/conversations/<会话 id>`，带 `scratch` 标记、不进项目列表）。
   *
   * 临时工作区按**会话 id** 命名，所以会话 id 得先定下来（`saveConversation` 接受显式 id）。
   * 每次触发都是一个新目录 —— 定时任务之间不共享状态，正是「从零干一遍」的语义。
   *
   * 绑的工作区**已经在库里找不到**（老数据 / 手工改过库 / 删除时漏了级联）时退化成临时
   * 工作区、只打一行警告，不抛错：抛错的表现就是「这条定时任务从此再也不动，而且没人看得见」。
   * 正常删项目走的是 `deleteWorkspace` 的级联（绑在它上面的定时任务一起清掉），不会走到这儿。
   */
  const conversationId = randomUUID()
  let workspace = trigger.workspaceId ? domain.getWorkspace(trigger.workspaceId) : undefined
  if (!workspace && trigger.workspaceId) {
    console.warn(
      `[triggers] 定时任务「${trigger.name}」绑的工作区已不存在（${trigger.workspaceId}），本次改用临时工作区`
    )
  }
  /**
   * 绑的工作区**还在登记表里、目录却没了**（被删 / 被移走 / 换了位置）：拒跑。
   *
   * 这里**不**退化到临时工作区 —— 绑项目就是为了在那个仓库里干活，退化等于让它在空目录里
   * 「跑成功」：产物落在别处，用户看到的是「跑完了但什么都没变」，比不跑更难查。
   * 也不静默放行到 `startTurn`：那时错误发生在会话深处，只是又一个看不到的失败。
   *
   * 与新建会话（`POST /api/conversations`）同一条判据、同一句人话；`path` 为空的虚拟工作区
   * 没有目录概念，跳过。抛出去由 `fireTrigger` 的 catch 记日志 —— 任务保持原样，等用户修好。
   */
  // 远端工作区首期不支持定时任务：无人值守时无法给出「主机不可达」的交互反馈，
  // 静默失败比明确拒绝更难查。明确报错，任务保持原样等用户改绑本机工作区。
  if (workspace && isRemoteWorkspace(workspace)) {
    throw new Error(
      `定时任务「${trigger.name}」绑定的工作区在远端主机上：首期不支持定时任务，请改绑本机工作区`
    )
  }
  if (workspace?.path && !(await domain.isWorkspaceDirAvailable(workspace.path))) {
    throw new Error(
      `定时任务「${trigger.name}」绑定的工作区目录不存在：${workspace.path}（可能已被删除或移动）：请编辑它重新选择工作区`
    )
  }
  workspace ??= await domain.ensureScratchWorkspace(conversationId)
  // 外部 Agent 要一个真实 cwd 才能起进程（与 chat-turn 同一条判据）：虚拟工作区
  // （`path` 为空）在这里就拒跑，别等建完会话再 400
  if (target.backend === 'acp' && !workspace.path) {
    throw new Error(`定时任务「${trigger.name}」绑定的工作区没有目录，不能用外部 Agent（ACP 需要目录）`)
  }

  // ⚠️ 动态 import：调度器会被构建配置当普通模块打包，绝不能在顶层把 内置 /
  // agent 编排那一大串拖进启动路径 —— 只有真的要跑会话了才加载。
  const { startTurn, releaseUnattendedWaits } = await import('./chat-turn')

  const conversation = domain.saveConversation({
    id: conversationId,
    workspaceId: workspace.id,
    title: trigger.name,
    /**
     * ⚠️ 打上「还没被点开过」：定时任务是**自己到点冒出来的**，用户不会正盯着它 ——
     * 侧栏在会话行 + 它所属的工作区名上点红点，点开即清
     * （`openConversation` → `POST /api/conversations/:id/seen`）。
     */
    unseen: true,
    // 后端跟着模板走（`acp` = 外部 agent 进程）：会话建好就锁定 agent，与手动会话一样
    backend: target.backend,
    configId: target.configId,
    ...(target.modelId ? { modelId: target.modelId } : {}),
    /**
     * ACP 会话的权限答复策略：只有「完全访问」才自动放行 agent 发来的权限请求 ——
     * 无人值守时没人能点那张卡，`confirm` 会一路等到 10 分钟超时再拒绝（见上面的警告）。
     * 内置模型（内置）没有这个字段，它的等价物是本轮传下去的 `permissionMode`。
     */
    ...(target.backend === 'acp'
      ? { acpPermissionMode: permissionMode === 'full' ? ('allow' as const) : ('confirm' as const) }
      : {}),
    // 模板里选的 MCP 挂在会话上（与手动会话同一套：chat-turn 按会话的 mcpServerIds 接工具）；
    // 已删除的 id 由 chat-turn 按现存配置剔掉，这里不必校验
    ...(trigger.template.mcpServerIds?.length
      ? { mcpServerIds: trigger.template.mcpServerIds }
      : {}),
    // 浏览器工具（跑在**服务端**，不依赖用户面前的窗口）：模板里选了就落到会话上，
    // 之后 chat-turn 与手动会话走完全同一条装配路径。没选 = 会话上不写，按常量默认（关）走。
    ...(trigger.template.browserSettings
      ? { browserSettings: trigger.template.browserSettings }
      : {})
  })
  /**
   * 「已经触发过」的标记在这里落，**不**等 `run.done`。
   *
   * 一次性 `at` 任务的语义是「到点跑一次」，它必须只发生一次：标记晚落一步，
   * 进程在会话跑一半时被杀就会留下「标记没落 + 会话已建」的窗口，重启后重复触发。
   * cron 不受影响（armAtTriggers 只对 `at` 看 lastTriggeredAt），而这一次会话本身也
   * 已经在库里、能看到 —— 就算这一轮没跑完，痕迹也留得住。
   */
  triggerDomain.markTriggered(trigger.id, conversation.id)

  const text =
    trigger.template.prompt?.trim() || '（定时任务没有填写需求，请汇报当前工作区状态）'
  const started = await startTurn({
    conversationId: conversation.id,
    text,
    backend: target.backend,
    configId: target.configId,
    ...(target.modelId ? { modelId: target.modelId } : {}),
    permissionMode
  })
  if (!started.ok) throw new Error(started.message)
  const run = started.run

  // 无人值守兜底：agent 用 ask_followup_question 提问是「无限期等人」的 —— 定时把
  // 挂起的提问按「跳过」放行（confirm 自带 10 分钟超时，不归这里管）。
  const followupTimer = setTimeout(() => releaseUnattendedWaits(run.requestId), UNATTENDED_WAIT_MS)
  // 别让这个定时器把进程钉住
  followupTimer.unref?.()

  // run 由 chat-run 托管，与 SSE 连接无关 —— 这里只等它跑完
  await run.done

  console.log(
    `[triggers] 定时任务「${trigger.name}」起了会话 ${conversation.id}（finishReason: ${run.finishReason ?? '?'}）`
  )
  return {
    conversationId: conversation.id,
    ...(run.finishReason ? { finishReason: run.finishReason } : {})
  }
}

/**
 * 派发一次触发（cron 到点 / at 到点）：不等待会话跑完 —— 一轮可能几分钟，调度器的
 * 下一次 tick 不该被它堵住。失败只打日志：定时任务没有「作业重试」语义，
 * 失败重试 = 再烧一遍 token 拿同一个结果（与旧 BullMQ 的 `attempts: 1` 同口径）。
 */
export function fireTrigger(triggerId: string): void {
  const state = s()
  dispatch(state, () =>
    processFire(triggerId).catch((err: unknown) => {
      console.error(`[triggers] 定时任务 ${triggerId} 执行失败：`, err instanceof Error ? err.message : err)
    })
  )
}

/**
 * 手动「立即运行」：与 `fireTrigger` 同一条派发队列（同样不等待会话跑完），
 * 区别只有 `manual: true` —— 跳过「已停用 / 一次性已跑过」两道闸，其余校验照旧。
 *
 * 停用的任务手动跑一次是**合理需求**（先试跑再启用）；一次性任务跑过之后再跑一次
 * 也由用户自己点的，不算「重复触发」。
 */
export function fireTriggerNow(triggerId: string): void {
  const state = s()
  dispatch(state, () =>
    processFire(triggerId, { manual: true }).catch((err: unknown) => {
      console.error(
        `[triggers] 定时任务 ${triggerId} 手动执行失败：`,
        err instanceof Error ? err.message : err
      )
    })
  )
}

// ---------------------------------------------------------------------------
// cron 轮询与 at 武装
// ---------------------------------------------------------------------------

/**
 * cron 一轮检查：对每条启用的 cron 任务，算「上一个应触发时刻」，落在
 * 「调度器启动之后、且还没派发过」就触发。
 */
function tickCron(state: SchedulerState): void {
  const now = new Date()
  const liveCronIds = new Set<string>()
  for (const trigger of triggerDomain.listTriggers()) {
    if (!trigger.enabled || !trigger.cron) continue
    liveCronIds.add(trigger.id)
    let prev: number
    try {
      prev = parseExpression(trigger.cron, { currentDate: now }).prev().getTime()
    } catch (err) {
      // 校验路由已经拦过非法表达式，这里只剩「手工改库」的脏数据：跳过即可
      console.error(`[triggers] 定时任务 ${trigger.id} 的 cron 解析失败：`, err)
      continue
    }
    // 启动前的轮次不补跑（重启语义见文件头）；lastCronFire 去重同一分钟内的多次 tick
    if (prev < state.startedAt) continue
    if ((state.lastCronFire.get(trigger.id) ?? Number.NEGATIVE_INFINITY) >= prev) continue
    state.lastCronFire.set(trigger.id, prev)
    console.log(`[triggers] cron 到点：${trigger.name}（${trigger.cron}）`)
    fireTrigger(trigger.id)
  }
  // 清掉已删除 / 停用 / 改成 at 的定时任务的去重记录，别让 Map 涨个不停
  for (const id of state.lastCronFire.keys()) {
    if (!liveCronIds.has(id)) state.lastCronFire.delete(id)
  }
}

/**
 * at 任务的定时器对账：真源在 JsonStore，这里只维护内存里的 setTimeout 投影。
 * - 已删除 / 停用 / 已触发过 / 时刻改了 → 旧定时器清掉；
 * - 该武装没武装的 → 补上；目标时刻已过的（服务当时没开）立即补跑一次。
 * 幂等：重复调用只做必要的增删，多调无害（CRUD 后 / 启动时 / 每次 tick 各调一处）。
 */
function armAtTriggers(state: SchedulerState): void {
  const valid = new Map<string, number>()
  for (const trigger of triggerDomain.listTriggers()) {
    if (trigger.enabled && trigger.at !== undefined && trigger.lastTriggeredAt === undefined) {
      valid.set(trigger.id, trigger.at)
    }
  }
  for (const [id, entry] of state.atTimers) {
    if (valid.get(id) !== entry.at) {
      clearTimeout(entry.timer)
      state.atTimers.delete(id)
    }
  }
  for (const [id, at] of valid) {
    if (state.atTimers.has(id)) continue
    const timer = setTimeout(
      () => {
        state.atTimers.delete(id)
        console.log(`[triggers] 一次性任务到点：${triggerDomain.getTrigger(id)?.name ?? id}`)
        fireTrigger(id)
      },
      Math.max(0, at - Date.now())
    )
    // 别让这个定时器把进程钉住（CLI / 测试里跑完就该能退出）
    timer.unref?.()
    state.atTimers.set(id, { at, timer })
  }
}

/**
 * 定时任务写库后调一次：立刻把 at 定时器对齐（cron 本来就每 tick 读库，无需对账）。
 * 幂等且不抛错 —— 非法数据按「跳过」处理，不该把 CRUD 路由带崩。
 */
export function syncTriggers(): void {
  try {
    armAtTriggers(s())
  } catch (err) {
    console.error('[triggers] 定时任务同步失败：', err)
  }
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/**
 * 启动调度器。**幂等**（重复调用只生效一次）。
 *
 * 由服务端入口的后台启动段调用（桌面端 = 进程内后端装配，独立服务 = index.ts）：
 * 定时触发的语义本来就包含「服务开着就会自己跑」，不能依赖有人打开浏览器。
 */
export function startTriggerScheduler(): void {
  const state = s()
  if (state.started) return
  state.started = true
  state.startedAt = Date.now()
  armAtTriggers(state)
  tickCron(state)
  state.tickTimer = setInterval(() => {
    try {
      tickCron(state)
      armAtTriggers(state)
    } catch (err) {
      console.error('[triggers] 调度轮询失败：', err)
    }
  }, TICK_MS)
  // 别让这个定时器把进程钉住
  state.tickTimer.unref?.()
  console.log(`[triggers] 调度器已启动（进程内 cron，tick ${TICK_MS / 1000}s，并发 ${CONCURRENCY}）`)
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 停止调度器。**幂等**（没起过就是空转），退出钩子专用。
 *
 * 停掉 tick 与全部 at 定时器；排队的派发直接丢弃（记一条日志）—— 退出路径上
 * `abortAllRuns` 已经中止了在跑的会话，排队的那几轮本来也不该再开新会话。
 * 在跑的会话等至多 `graceMs`：正常它们已收到 abort、很快就收尾。
 */
export async function stopTriggerScheduler(graceMs = 3_000): Promise<void> {
  const state = s()
  if (state.tickTimer) {
    clearInterval(state.tickTimer)
    state.tickTimer = undefined
  }
  for (const { timer } of state.atTimers.values()) clearTimeout(timer)
  state.atTimers.clear()
  state.started = false
  if (state.pending.length) {
    console.warn(`[triggers] 丢弃 ${state.pending.length} 个排队的触发`)
    state.pending.length = 0
  }
  const deadline = Date.now() + graceMs
  while (state.running > 0 && Date.now() < deadline) {
    await delay(100)
  }
}
