/**
 * 定时任务的创建逻辑 —— **唯一真源**。
 *
 * 两个入口都走这里,免得默认值 / 落库后对账各写一份:
 * - HTTP:`POST /api/task-triggers`(界面里的「定时任务」表单);
 * - 工具:`create_task_trigger` 等一组(项目管理助手 / 会话里的模型调用)。
 *
 * 写库之后必须 `syncTriggers()`(`./scheduler`):调度器内存里的 at 定时器是定时任务记录的
 * **投影**,库里改了就要立刻对齐 —— 15 秒一次的 tick 也会对账,这里只是让改动即时生效。
 */
import { randomUUID } from 'node:crypto'
import { parseExpression } from 'cron-parser'
import { isRemoteWorkspace, type AgentWorkspace, type TaskTrigger, type TaskTriggerInput } from '@fizz/contracts/types'
import type {
  TaskTriggerCreateInput,
  TaskTriggerCreateResult,
  TaskTriggerSummary,
  TaskTriggerUpdateInput
} from '@fizz/tools'
import { triggerDomain, domain } from './state'
import { syncTriggers } from './scheduler'

/**
 * cron 校验:交给 cron-parser(与调度器用的是同一套语法)真解析一遍,
 * 表达式非法(字段越界 / 语法不认识)当场打回,而不是等到调度器 tick 时才炸。
 */
export function isValidCron(expr: string): boolean {
  try {
    parseExpression(expr)
    return true
  } catch {
    return false
  }
}

/**
 * 定时任务绑的工作区必须「记录还在 + **目录还在**」。
 *
 * 与新建会话(`POST /api/conversations`)同一套判据 —— 工作区只在 `addWorkspace` 那一刻
 * stat 过磁盘,之后目录被删 / 被移走,登记记录照旧在(`workspace-health` 的巡检只给界面
 * 打 `dirMissing` 红标,**不拦任何写入**)。会话是用户在面前手动建的,那边一拦就有人看见;
 * 定时任务无人值守,建的时候不拦,就只能在到点那一刻于调度器深处炸掉 —— 用户看到的只是
 * 「这条任务从此不动,也不知道为什么」。
 *
 * 不绑工作区(每次触发自动建临时工作区)不归这里管:那条路不依赖任何用户目录。
 */
export async function requireUsableTriggerWorkspace(workspaceId: string): Promise<AgentWorkspace> {
  const ws = domain.getWorkspace(workspaceId)
  if (!ws) throw new Error(`项目不存在:${workspaceId}`)
  // 远端工作区首期不支持定时 / 触发（与调度器同一判据，错误必须在保存时就看得见）
  if (isRemoteWorkspace(ws)) {
    throw new Error('远端工作区首期不支持定时任务，请改用本机工作区或「每次运行自动创建」')
  }
  // `path` 为空的虚拟工作区(「任务」/「项目助手」)没有目录概念,跳过
  if (ws.path && !(await domain.isWorkspaceDirAvailable(ws.path))) {
    throw new Error(
      `工作区目录不存在:${ws.path}(可能已被删除或移动),请重新选择工作区或改用「每次运行自动创建」`
    )
  }
  return ws
}

/**
 * 按入参算出要落库的记录。`existing` 有值 = 更新那一条,保留它的 id / createdAt
 * 与调度器写的回执(lastTriggeredAt / lastConversationId …)。
 */
export function buildTriggerRecord(body: TaskTriggerInput, existing?: TaskTrigger): TaskTrigger {
  return {
    id: existing?.id ?? randomUUID(),
    // 不传 = 不绑工作区(每次触发自动建临时工作区)。这里用条件展开而不是 `?? existing`,
    // 因为「解绑」是一条合法改动:更新时把值改成空必须能真的清掉。
    ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    name: body.name.trim(),
    ...(body.cron ? { cron: body.cron.trim() } : {}),
    ...(body.at !== undefined ? { at: body.at } : {}),
    // 模板原样存:权限档也在里面(缺省由调度器回落到 full,见 TaskTriggerTemplate)
    template: body.template ?? { prompt: '' },
    // 已触发过的一次性任务不给「重新启用」机会(否则改一下就再跑一遍),其余按入参来,默认启用
    enabled:
      existing?.at !== undefined && existing.lastTriggeredAt !== undefined
        ? false
        : (body.enabled ?? true),
    createdAt: existing?.createdAt ?? Date.now(),
    ...(existing?.lastTriggeredAt !== undefined
      ? { lastTriggeredAt: existing.lastTriggeredAt }
      : {}),
    ...(existing?.lastConversationId !== undefined
      ? { lastConversationId: existing.lastConversationId }
      : {}),
    // ⚠️ 历史会话 id 必须原样带走：编辑一条任务（改名 / 换时间表 / 改需求）不该把
    // 「它跑过哪些会话」这份索引清空 —— 那正是管理页里唯一能回看历史的入口。
    ...(existing?.conversationIds?.length
      ? { conversationIds: existing.conversationIds }
      : {}),
    ...(existing?.lastTaskId !== undefined ? { lastTaskId: existing.lastTaskId } : {})
  }
}

/** 落库 + 让调度器投影立刻对齐,返回存下来的那条 */
export function saveTriggerAndSync(trigger: TaskTrigger): TaskTrigger {
  const saved = triggerDomain.saveTrigger(trigger)
  syncTriggers()
  return saved
}

/** 本地时间的人话(给模型看的,别让它自己按 UTC 解释) */
function localTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 下一次触发时刻的人话。enabled 才可能触发;cron 交给 cron-parser 算(与调度器同一套)。
 * 返回 undefined = 已停用 / 已过期 / 表达式算不出来。
 */
function nextRunText(trigger: TaskTrigger): string | undefined {
  if (!trigger.enabled) return undefined
  if (trigger.cron) {
    try {
      return localTime(parseExpression(trigger.cron).next().toDate().getTime())
    } catch {
      return undefined
    }
  }
  if (trigger.at !== undefined) return localTime(trigger.at)
  return undefined
}

/** 记录 → 工具侧创建 / 更新结果(同一形状,免得两处各拼一遍) */
function triggerResult(saved: TaskTrigger): TaskTriggerCreateResult {
  const nextRunAt = nextRunText(saved)
  return {
    id: saved.id,
    name: saved.name,
    workspaceId: saved.workspaceId,
    ...(saved.cron ? { cron: saved.cron } : {}),
    ...(saved.at !== undefined ? { at: saved.at } : {}),
    enabled: saved.enabled,
    ...(nextRunAt ? { nextRunAt } : {})
  }
}

/** 记录 → 工具侧清单摘要(与 triggerResult 相比多了 prompt / 上次触发) */
function triggerSummary(trigger: TaskTrigger): TaskTriggerSummary {
  const nextRunAt = nextRunText(trigger)
  return {
    id: trigger.id,
    name: trigger.name,
    workspaceId: trigger.workspaceId,
    prompt: trigger.template.prompt ?? '',
    ...(trigger.cron ? { cron: trigger.cron } : {}),
    ...(trigger.at !== undefined ? { at: trigger.at } : {}),
    enabled: trigger.enabled,
    ...(trigger.lastTriggeredAt !== undefined ? { lastTriggeredAt: trigger.lastTriggeredAt } : {}),
    ...(trigger.lastConversationId !== undefined
      ? { lastConversationId: trigger.lastConversationId }
      : {}),
    ...(nextRunAt ? { nextRunAt } : {})
  }
}

/**
 * 项目工具 `create_task_trigger` 的实现:校验 + 落库。
 *
 * `target`(模型配置 / 模型)由调用方从**当前这一轮**继承下来 —— 触发会话要用的模型不该让
 * 模型自己挑(见 ProjectToolsDeps.triggers 的注释)。
 */
export async function createTaskTriggerFromTool(
  input: TaskTriggerCreateInput,
  target?: { configId: string; modelId: string }
): Promise<TaskTriggerCreateResult> {
  // 与 HTTP 入口同源:工作区记录在 + 目录也在,否则这条任务到点必炸
  const ws = await requireUsableTriggerWorkspace(input.workspaceId)
  const name = input.name?.trim()
  const prompt = input.prompt?.trim()
  if (!name) throw new Error('任务名不能为空')
  if (!prompt) throw new Error('需求原文(触发时发给 agent 的话)不能为空')
  const cron = input.cron?.trim()
  if (!cron && input.at === undefined) throw new Error('需要 cron 或 at 其中之一(没有触发时间就不会被调度)')
  if (cron && input.at !== undefined) throw new Error('cron 与 at 只能给一个')
  if (cron && !isValidCron(cron)) {
    throw new Error('cron 表达式不合法(5 段:分 时 日 月 周,如 0 9 * * *)')
  }
  if (input.at !== undefined && input.at <= Date.now()) {
    throw new Error(`at 必须是未来的时刻,收到的是 ${localTime(input.at)}(已过去)`)
  }
  // 模型必须由调用方（当前这一轮）带下来：缺了就是一条「到点就报错」的任务，
  // 不拿清单第一份顶上（见 scheduler 的 `resolveHeadlessTarget`）
  if (!target) {
    throw new Error('当前助手没有绑定模型，无法创建定时任务：请先在助手面板选择模型')
  }

  const saved = saveTriggerAndSync(
    buildTriggerRecord({
      workspaceId: ws.id,
      name,
      ...(cron ? { cron } : {}),
      ...(input.at !== undefined ? { at: input.at } : {}),
      template: {
        prompt,
        // 工具这条入口只出现在项目管理助手里（内置 Agent），所以后端写死 内置；
        // 外部 Agent（ACP）只能在「定时任务」表单里选（见 TriggerEditDialog）
        backend: 'builtin',
        configId: target.configId,
        modelId: target.modelId
      },
      enabled: true
    })
  )

  return triggerResult(saved)
}

/** 项目工具 `list_task_triggers` 的实现:列全部,或只看某个项目的 */
export function listTaskTriggersForTool(workspaceId?: string): TaskTriggerSummary[] {
  return triggerDomain.listTriggers(workspaceId).map(triggerSummary)
}

/**
 * 项目工具 `update_task_trigger` 的实现:只改传入的字段,其余沿用原记录。
 *
 * `id` / `createdAt` 与调度器写的回执(lastTriggeredAt / lastConversationId …)都由
 * `buildTriggerRecord(body, existing)` 保留 —— 与 HTTP 更新是同一条路,模型改不坏记录。
 */
export function updateTaskTriggerFromTool(input: TaskTriggerUpdateInput): TaskTriggerCreateResult {
  const existing = triggerDomain.getTrigger(input.id)
  if (!existing) throw new Error(`定时任务不存在:${input.id}`)

  const name = input.name?.trim() ?? existing.name
  if (!name) throw new Error('任务名不能为空')
  const prompt = input.prompt?.trim() ?? existing.template.prompt
  if (!prompt) throw new Error('需求原文(触发时发给 agent 的话)不能为空')

  const cron = input.cron?.trim()
  const changingSchedule = cron !== undefined || input.at !== undefined
  if (cron && input.at !== undefined) throw new Error('cron 与 at 只能给一个')
  if (cron && !isValidCron(cron)) {
    throw new Error('cron 表达式不合法(5 段:分 时 日 月 周,如 0 9 * * *)')
  }
  if (input.at !== undefined && input.at <= Date.now()) {
    throw new Error(`at 必须是未来的时刻,收到的是 ${localTime(input.at)}(已过去)`)
  }
  // 排程:显式给了就整段换掉(给 cron 即去 at,反之亦然),没给就沿用旧的
  const nextCron = changingSchedule ? cron : existing.cron
  const nextAt = changingSchedule ? input.at : existing.at
  if (!nextCron && nextAt === undefined) {
    throw new Error('需要 cron 或 at 其中之一(没有触发时间就不会被调度)')
  }

  const saved = saveTriggerAndSync(
    buildTriggerRecord(
      {
        workspaceId: existing.workspaceId,
        name,
        ...(nextCron ? { cron: nextCron } : {}),
        ...(nextAt !== undefined ? { at: nextAt } : {}),
        template: { ...existing.template, prompt },
        enabled: input.enabled ?? existing.enabled
      },
      existing
    )
  )
  return triggerResult(saved)
}

/** 项目工具 `delete_task_trigger` 的实现:只删规则,不动它已经起出来的会话 */
export function deleteTaskTriggerFromTool(id: string): void {
  if (!triggerDomain.getTrigger(id)) throw new Error(`定时任务不存在:${id}`)
  triggerDomain.deleteTrigger(id)
  syncTriggers()
}

/** 项目工具 `set_task_trigger_enabled` 的实现:启停并让调度器投影立刻对齐 */
export function setTaskTriggerEnabledFromTool(id: string, enabled: boolean): TaskTriggerSummary {
  const existing = triggerDomain.getTrigger(id)
  if (!existing) throw new Error(`定时任务不存在:${id}`)
  // 与 buildTriggerRecord 同一条判据:已触发过的一次性任务不给「再启用」机会,否则改一下就又跑一遍
  if (enabled && existing.at !== undefined && existing.lastTriggeredAt !== undefined) {
    throw new Error('这是一条已触发过的一次性任务,不能再启用;要再跑一次请改一个未来的触发时刻。')
  }
  const saved = saveTriggerAndSync({ ...existing, enabled })
  return triggerSummary(saved)
}