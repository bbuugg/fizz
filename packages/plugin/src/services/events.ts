/**
 * 事件总线服务：`ctx.events` 的实体。
 *
 * 之所以还要它（而不是只留 `ctx.on` / `ctx.emit`）：插件想「声明依赖事件能力」时可以
 * `inject: ['events']`，也可以在配置里被换掉（测试时给个记录用的假总线）。
 * 行为完全委托给 Context —— 事件沿 Context 树**向上冒泡**（子层注册的监听器先触发，
 * 再到父层），这样 App 层能统一监听所有 turn 的事件。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose, Listener } from '../types'

export class EventsService extends Service {
  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'events'
  }

  /** 监听事件；返回 disposer（随 Context 卸载自动回收，无需手动调） */
  on(name: string, listener: Listener): Dispose {
    return this.ctx.on(name, listener)
  }

  /** 一对多广播，不收集返回值 */
  emit(name: string, ...args: unknown[]): void {
    this.ctx.emit(name, ...args)
  }

  /**
   * 安全广播：单个监听器抛错只记日志，不中断其余监听器，也不把异常抛回调用方。
   * 长驻的会话状态钩子用它分发（见 `Context.emitSafe`）。
   */
  emitSafe(name: string, ...args: unknown[]): void {
    this.ctx.emitSafe(name, ...args)
  }

  /**
   * 拦截型钩子：监听器签名 `(...args, next)`，可读 / 改参数再 `next(...)` 继续，
   * 或直接返回自己的结果**中断链路**（不再往下走）。
   */
  waterfall<T>(name: string, args: unknown[], fallback: (...a: unknown[]) => T): T {
    return this.ctx.waterfall(name, args, fallback)
  }

  /** 收集型：返回第一个「非 undefined」的监听器结果 */
  bail<T>(name: string, ...args: unknown[]): T | undefined {
    return this.ctx.bail<T>(name, ...args)
  }
}