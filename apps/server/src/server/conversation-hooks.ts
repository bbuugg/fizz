/**
 * 会话状态钩子的**长驻插件宿主**。
 *
 * ## 为什么不能复用 turn context 上的 hooks
 *
 * `buildAgentSetup` 每轮现建一个 turn context，`runAgent` 收尾就 dispose；ACP 会话与
 * 容器型会话甚至不走那条装配。而「一轮开始 / 结束 / 在等审批 / 在等回答」是产品层面的
 * 会话状态，必须跨轮次、跨后端存在。于是这里按**工作区**建长驻 context，只提供
 * `hooks`（+ 有目录时的 `workspace`），插件的 `ctx.inject(['hooks'], …)` 那一半在
 * 这里注册监听器。
 *
 * ## 事件从哪来
 *
 * 不碰 chat-turn / ACP / 容器各自的调用点，直接订阅全局 `eventBus` 的 `'event'`
 * （`emitServerEvent` 是它们共同的唯一出口）。SSE 事件已经覆盖三条后端，桥接在这里
 * 等于只维护一份映射。
 *
 * ## 三个必须处理的细节
 *
 * 1. **同步事件、异步宿主**：`emitServerEvent` 是同步的，插件发现 / 加载是异步的。
 *    事件先入队，宿主建好再分发，不能丢。
 * 2. **同一工作区串行**：保证 `started → confirm → resolved → finished` 的顺序；
 *    并发分发会让通知先报「跑完了」再报「等你确认」。
 * 3. **监听器抛错隔离**：走 `emitSafe` —— 一个通知插件写坏不能影响别的插件，更不能
 *    反向打断会话收尾。
 *
 * ## 失效
 *
 * 指纹（插件源码 + 启用态 + 设置值）变了就在下一次事件时重建；安装 / 卸载 / 启停 /
 * 保存设置后调 `invalidateConversationHooks` 当场 dispose，不必等下一轮对话。
 */

import {
  HooksService,
  WorkspaceService,
  createAppContext,
  type Context
} from '@fizz/plugin'
import { loadPlugins } from '@fizz/plugin/loader'
import { appLog } from '@fizz/workspace'
import type { ServerEvent } from '@fizz/contracts/types'
import {
  conversationHookDispatch,
  type ConversationHookWorkspace
} from './conversation-hook-events'
import { discoverServerPlugins, pluginFingerprint, withRuntimeConfig } from './plugin-roots'
import { domain, eventBus } from './state'

interface HostEntry {
  /** 插件源码 + 启用态 + 设置值的指纹；变了就重建 */
  fingerprint: string
  ctx: Context
}

interface QueuedHook {
  hook: string
  payload: unknown
  workspacePath?: string
}

interface Lane {
  events: QueuedHook[]
  task: Promise<void> | null
}

interface Registry {
  started: boolean
  listener?: (event: ServerEvent) => void
  /** key = workspaceId（'' = 没有工作区的会话） */
  hosts: Map<string, HostEntry>
  /** 同一 key 的并发构建共用一次（多个事件同时到时不要各建一份） */
  pending: Map<string, Promise<HostEntry | null>>
  /** 同一 key 的分发队列（串行保证事件顺序） */
  lanes: Map<string, Lane>
}

const GLOBAL_KEY = '__FIZZ_CONVERSATION_HOOKS__'

/** 宿主注册表挂 globalThis：与 `state.ts` 同一理由（跨加载器只能有一份） */
function registry(): Registry {
  const holder = globalThis as Record<string, unknown>
  const existing = holder[GLOBAL_KEY] as Registry | undefined
  if (existing) return existing
  const state: Registry = {
    started: false,
    hosts: new Map(),
    pending: new Map(),
    lanes: new Map()
  }
  holder[GLOBAL_KEY] = state
  return state
}

/**
 * 从事件解析会话所属工作区。
 *
 * 远端工作区**不把 path 交给插件发现**：`workspacePath` 是远端 POSIX 路径，拿去本机
 * `readdir` 只会扫错目录（与每轮对话「远端不加载项目级 / 用户级插件」同一口径）。
 * 工作区 id / 名字仍然给插件，通知文案里需要它们。
 */
function workspaceFor(event: ServerEvent): ConversationHookWorkspace | undefined {
  if (!('conversationId' in event)) return undefined
  const conversation = domain.getConversation(event.conversationId)
  if (!conversation) return undefined
  const workspace = domain.getWorkspace(conversation.workspaceId)
  if (!workspace) return undefined
  return {
    id: workspace.id,
    name: workspace.name,
    ...(!workspace.remote && workspace.path ? { path: workspace.path } : {})
  }
}

async function buildHost(key: string, workspacePath?: string): Promise<HostEntry | null> {
  try {
    const descriptors = await discoverServerPlugins({
      ...(key ? { workspaceId: key } : {}),
      ...(workspacePath ? { workspacePath } : {})
    })
    const enabled = descriptors.filter((item) => item.enabled)
    const fingerprint = await pluginFingerprint(enabled)
    const cached = registry().hosts.get(key)
    if (cached && cached.fingerprint === fingerprint) return cached

    const ctx = createAppContext(`conversation-hooks:${key || 'global'}`)
    ctx.set('hooks', new HooksService(ctx))
    if (workspacePath) {
      const workspace = key ? domain.getWorkspace(key) : undefined
      ctx.set(
        'workspace',
        new WorkspaceService(ctx, { path: workspacePath, name: workspace?.name })
      )
    }

    /*
     * 只挂启用过的插件。这里**刻意不提供** tools / ui / prompt 等服务：会话钩子宿主
     * 只负责通知，插件的工具 / 设置那半应当留在 turn context 与 inspect context。
     * 插件用 `ctx.inject(['hooks'], …)` 声明依赖即可 —— 依赖不齐的顶层写法不会在这里生效。
     */
    const { loaded, errors } = await loadPlugins(withRuntimeConfig(enabled))
    for (const err of errors) {
      appLog.warn('plugin', `会话钩子插件加载失败（已跳过）：${err}`)
    }
    for (const item of loaded) {
      try {
        ctx.plugin(item.plugin, item.config)
      } catch (err) {
        appLog.warn(
          'plugin',
          `会话钩子插件挂载失败（已跳过）：${item.id}`,
          err instanceof Error ? err.stack ?? err.message : String(err)
        )
      }
    }

    // 构建期间服务被停掉：不留一份没人回收的 context
    if (!registry().started) {
      await ctx.dispose().catch(() => {})
      return null
    }

    const entry: HostEntry = { fingerprint, ctx }
    registry().hosts.set(key, entry)
    // 先换上新宿主，再回收旧的：期间到达的事件会落到新宿主上，不会撞到正在 dispose 的
    if (cached) await cached.ctx.dispose().catch(() => {})
    return entry
  } catch (err) {
    appLog.warn(
      'plugin',
      '会话钩子宿主构建失败（本次事件跳过）',
      err instanceof Error ? err.stack ?? err.message : String(err)
    )
    return null
  }
}

function ensureHost(key: string, workspacePath?: string): Promise<HostEntry | null> {
  const state = registry()
  const inflight = state.pending.get(key)
  if (inflight) return inflight
  const task = buildHost(key, workspacePath).finally(() => {
    state.pending.delete(key)
  })
  state.pending.set(key, task)
  return task
}

async function drain(key: string, lane: Lane): Promise<void> {
  while (lane.events.length) {
    const batch = lane.events.splice(0)
    const workspacePath = batch.find((item) => item.workspacePath)?.workspacePath
    const host = await ensureHost(key, workspacePath)
    if (!host) continue
    for (const item of batch) {
      if (host.ctx.disposed) break
      // emitSafe：单个监听器抛错只记日志，不影响同批的其它插件
      host.ctx.hooks.emitSafe(item.hook, item.payload)
    }
  }
}

function enqueue(dispatch: ReturnType<typeof conversationHookDispatch>): void {
  if (!dispatch) return
  const state = registry()
  const key = dispatch.workspaceId
  let lane = state.lanes.get(key)
  if (!lane) {
    lane = { events: [], task: null }
    state.lanes.set(key, lane)
  }
  lane.events.push({
    hook: dispatch.hook,
    payload: dispatch.payload,
    ...(dispatch.workspacePath ? { workspacePath: dispatch.workspacePath } : {})
  })
  if (!lane.task) {
    lane.task = drain(key, lane).finally(() => {
      lane.task = null
      if (!lane.events.length && state.lanes.get(key) === lane) state.lanes.delete(key)
    })
  }
}

/** 启动：订阅全局事件总线（幂等）。由 `background.ts` 在服务启动时调。 */
export function startConversationHooks(): void {
  const state = registry()
  if (state.started) return
  state.started = true
  const listener = (event: ServerEvent): void => {
    try {
      const workspace = workspaceFor(event)
      enqueue(conversationHookDispatch(event, workspace))
    } catch (err) {
      // 桥接本身不能反向打断会话：事件已经发出去了，这里只记一条
      appLog.warn(
        'plugin',
        '会话事件分发失败（本次跳过）',
        err instanceof Error ? err.stack ?? err.message : String(err)
      )
    }
  }
  state.listener = listener
  eventBus.on('event', listener)
}

/** 停止：退订并回收全部长驻宿主（退出 / 桌面端停后端时调，幂等）。 */
export async function stopConversationHooks(): Promise<void> {
  const state = registry()
  if (state.listener) {
    eventBus.off('event', state.listener)
    state.listener = undefined
  }
  state.started = false
  state.lanes.clear()
  const entries = [...state.hosts.values()]
  state.hosts.clear()
  await Promise.all(entries.map((entry) => entry.ctx.dispose().catch(() => {})))
}

/**
 * 作废长驻宿主。
 *
 * - 传 `workspaceId`：只作废那个工作区的宿主（项目级插件变更）；
 * - 不传：作废**全部**（内置 / 用户级插件是所有工作区共用的，改一个影响所有）。
 *
 * 平时靠指纹在下一事件时自动重建；安装 / 卸载 / 启停 / 保存设置后主动调一下，
 * 用户不必等下一轮对话才看到变化。
 */
export async function invalidateConversationHooks(workspaceId?: string): Promise<void> {
  const state = registry()
  const keys = workspaceId ? [workspaceId] : [...state.hosts.keys()]
  const entries: HostEntry[] = []
  for (const key of keys) {
    const entry = state.hosts.get(key)
    if (!entry) continue
    state.hosts.delete(key)
    entries.push(entry)
  }
  await Promise.all(entries.map((entry) => entry.ctx.dispose().catch(() => {})))
}
