/**
 * 插件 RPC：**前端半拿数据的唯一通道**（`ctx.rpc` 的实体）。
 *
 * ## 为什么需要它（而不是让插件自己注册 HTTP 路由）
 *
 * dsh 那种「插件在宿主进程里注册 `/api/<name>/*`」的方案在 fizz 不成立，有两个硬原因：
 * - 宿主半（`packages/plugin`）**完全没有 webServer 服务**，也不知道自己跑在 HTTP 后面；
 * - 三端同源是硬约束：web 走 `fetch`、desktop 走 **IPC 桥**（没有端口、没有 token）、
 *   安卓走 Capacitor。插件自己拼 URL 会在 desktop 上直接失效。
 *
 * 所以数据通道只有一条：前端 `POST /api/plugins/rpc {pluginId, method, payload}` →
 * 服务端把该插件挂上 → 分发到它注册的方法。三端共用，鉴权和日志也复用同一条链路。
 *
 * ## 边界（都是 fail-closed）
 *
 * - 方法名必须显式注册（没注册就是 404，不存在「反射调用任意导出」）；
 * - 只传 JSON（payload 体积在路由层限死），**不能传函数 / 流**；
 * - 一个插件最多 64 个方法；重名注册直接抛错（不是覆盖 —— 覆盖会让「谁把 handler 顶掉了」
 *   变成随机行为）。
 */
import { Service } from '../service'
import type { Dispose } from '../types'

/** 方法名：与插件 id 同级的安全字符集（会出现在 URL 之外的 JSON 里） */
const METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 每个插件的方法上限 */
const MAX_METHODS = 64

/** 一次调用的上下文（由服务端路由填） */
export interface RpcCallContext {
  /** 当前项目根目录（项目级插件分流用；全局调用时缺省） */
  workspacePath?: string
  /** 调用方 id（前端固定是 `'surface'`；日志里能区分来源） */
  origin?: string
}

/**
 * 方法实现。`payload` 是前端原样传上来的 JSON（可能不合法，**自己验**）；
 * 返回值必须是可 JSON 序列化的东西（函数 / Buffer 会被序列化成 `{}` / `{"type":"Buffer"}`，
 * 别指望服务端替你转）。
 */
export type RpcHandler = (payload: unknown, call: RpcCallContext) => unknown | Promise<unknown>

export class RpcService extends Service {
  get name(): string {
    return 'rpc'
  }

  private readonly handlers = new Map<string, RpcHandler>()

  /**
   * 注册一个方法。返回的 disposer 会绑到**发起注册的插件 fiber** 上
   * （`ctx.effect(...)` 里调用就随插件卸载回收）。
   */
  handle(method: string, handler: RpcHandler): Dispose {
    const key = typeof method === 'string' ? method.trim() : ''
    if (!METHOD_RE.test(key)) {
      throw new Error(`RPC 方法名不合法：「${method}」（要匹配 [A-Za-z0-9][A-Za-z0-9._-]*）`)
    }
    if (typeof handler !== 'function') throw new Error(`RPC 方法「${key}」的处理器必须是函数`)
    if (this.handlers.has(key)) throw new Error(`RPC 方法「${key}」重复注册`)
    if (this.handlers.size >= MAX_METHODS) throw new Error(`RPC 方法最多 ${MAX_METHODS} 个`)
    this.handlers.set(key, handler)
    return this.bind(() => {
      // 只在还指向自己时才删：卸载顺序不保证，别人的同名方法不该被连带清掉
      if (this.handlers.get(key) === handler) this.handlers.delete(key)
    })
  }

  /** 已注册的方法名（设置页 / 排障用） */
  methods(): string[] {
    return [...this.handlers.keys()].sort()
  }

  /**
   * 分发一次调用。
   *
   * 抛错的口径：**方法不存在**抛一条带方法名的错误（路由层映射成 404），
   * 处理器自己抛的错原样透出（路由层映射成 400 并把消息回给前端 —— 插件作者写
   * 「请先配置 API key」这类话，用户要能直接看到）。
   */
  async invoke(method: string, payload: unknown, call: RpcCallContext = {}): Promise<unknown> {
    const key = typeof method === 'string' ? method.trim() : ''
    const handler = this.handlers.get(key)
    if (!handler) {
      const known = this.methods()
      throw new Error(
        known.length
          ? `插件没有注册 RPC 方法「${key}」（已注册：${known.join(', ')}）`
          : `插件没有注册任何 RPC 方法（请求的是「${key}」）`
      )
    }
    return await handler(payload, call)
  }
}
