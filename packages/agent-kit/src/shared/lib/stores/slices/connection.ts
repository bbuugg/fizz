/**
 * 连接 slice：JWT 连接状态 + 底层 API 客户端 + 连上 / 断开。
 *
 * `api` 实例按 token 缓存（同一个 token 永远拿到同一个实例，身份稳定，
 * 可以安全地进 memo / effect 依赖）；断开连接清掉**所有** slice 的现场。
 */
import { createApi, normalizeServerBase, type AgentApi, type Connection } from '@fizz/agent-client/api'
import { loadConnection, saveConnection } from '@fizz/agent-client/web-host'
import { clearActiveConversationId, saveActiveWorkspaceId } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import type { StateCreator } from 'zustand'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'

/**
 * api 实例缓存：同一个「服务端地址 + token」复用同一个客户端（createApi 每次都会重挂 401 钩子）。
 *
 * ⚠️ 缓存键必须带上 `serverBase`：`serverBase` 在 `createApi` 里定格，只按 token 比会让
 * 「换了服务端地址但 token 恰好相同」继续打旧地址（手机端在登录页改了服务地址、
 * 或独立 vite 工程手动改 `VITE_FIZZ_SERVER_URL` 后最典型）。同一地址的 token 不变时
 * 仍然复用，401 钩子不会被重复挂。
 */
let apiCache: { key: string; api: AgentApi } | null = null
function apiForConnection({ token, serverBase }: Connection): AgentApi {
  const normalizedBase = normalizeServerBase(serverBase)
  const key = `${normalizedBase ?? ''}\n${token}`
  if (apiCache?.key === key) return apiCache.api
  const api = createApi({
    token,
    ...(normalizedBase ? { serverBase: normalizedBase } : {})
  })
  apiCache = { key, api }
  return api
}

export interface ConnectionSlice {
  connection: Connection | null
  /** 底层 API 客户端（按当前连接取，未连接 = null）。任务 / 文件 / git 等域都从这里拿 */
  getApi: () => AgentApi | null
  /** 登录（先拿候选连接做一次 health 探测，成功才落连接） */
  connect: (next: Connection) => Promise<boolean>
  /** 断开：清连接 + 清所有会话现场 / 列表 / 队列，退回登录页 */
  disconnect: () => void
}

export const createConnectionSlice: StateCreator<AgentStore, [], [], ConnectionSlice> = (
  set,
  get
) => ({
  connection: loadConnection(),

  getApi: () => {
    const { connection } = get()
    return connection ? apiForConnection(connection) : null
  },

  connect: async (next): Promise<boolean> => {
    const token = next.token.trim()
    // 缺省 = 同源；独立 vite 工程 / Capacitor 本地 `www` 会带上绝对地址
    const serverBase = normalizeServerBase(next.serverBase)
    const connection: Connection = { token, ...(serverBase ? { serverBase } : {}) }
    // 登录阶段的 401（密码错）别触发全局登出：这里用空回调盖掉
    const candidate = createApi(connection, undefined, () => {})
    try {
      await candidate.health()
    } catch (err) {
      set({ error: `连不上服务端：${err instanceof Error ? err.message : String(err)}` })
      return false
    }
    saveConnection(connection)
    set({ connection, error: null })
    return true
  },

  disconnect: () => {
    saveConnection(null)
    // 断开连接：现场也一并清掉，免得下次连上别的服务端还去恢复不存在的 id。
    // ⚠️ 会话这一项要**连键一起抹掉**（不是写空串）：写空串等于「用户明确要空态」，
    // 会把下次登录的兜底恢复（退到该工作区最新一条会话）一起关掉 —— 登出不是那个意思。
    saveActiveWorkspaceId(null)
    clearActiveConversationId()
    // 待发送队列（按会话隔离）一并清掉，别残留到下次登录
    get().clearAllLocalState()
    set({
      connection: null,
      health: null,
      /**
       * ⚠️ `error` 必须一起清。它是**工作台那一轮**的错误（「未授权：请重新登录」「连不上
       * 服务端」…），而登录页的 `useErrorToast` 读的就是它 —— 不清就会跟着用户飘到登录页上，
       * 变成一条常驻（`duration: Infinity`）的、和当前这一屏无关的报错。
       */
      error: null,
      models: [],
      workspaces: [],
      conversations: [],
      conversationsLoaded: false,
      // 主机清单与它同一次刷新：重连后要重新等一遍，别拿上一个服务端的主机直接当已加载
      hostsLoaded: false,
      skills: null,
      activeWorkspaceId: null,
      activeConversationId: null
    })
  }
})
