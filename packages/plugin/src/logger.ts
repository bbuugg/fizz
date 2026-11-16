/**
 * 极简 Logger：插件日志统一带 `[plugin:<路径>]` 前缀，路径是 Context 名字链路。
 *
 * 刻意不做日志级别过滤 —— 这一层只需要「谁的日志」可辨认，级别与落盘交给上层。
 *
 * ## 为什么除了 console 还要一条 sink（`setPluginLogSink`）
 *
 * 只写 console 的话，**打包后的桌面端根本看不到**：Electron 主进程没有控制台窗口。
 * 而插件日志恰恰是「通知为什么没发出去」这类问题的唯一线索 —— 实测踩过：企业微信通知
 * 插件发送失败只 `console.warn`，界面上既没有消息也没有报错，排查只能靠猜。
 *
 * 所以这里留一个**由宿主注入**的出口：服务端启动时把 `appLog` 接进来（见
 * `apps/server/src/server/plugin-log-sink.ts`），日志面板的「插件」页就能看到。
 *
 * 三条约束：
 * - **不能在这里 import `@fizz/workspace`**：`packages/plugin` 是能力底座（`agent` /
 *   `workspace` 反过来依赖它），包边界规则禁掉了这条反向依赖（`scripts/check-boundaries.mjs`）。
 *   所以是「宿主把出口塞进来」，不是「插件框架去读应用日志」。
 * - **出口可选**：没注入时行为与从前逐字节一致（只 console），浏览器侧 / 单测不受影响。
 * - **出口抛错必须吞掉**：日志写不出去不能反过来把插件或会话拖垮。
 */

/** 会进应用日志的级别（`debug` 只留在 console：太吵，且从不是「为什么没生效」的答案） */
export type PluginLogLevel = 'info' | 'warn' | 'error'

/** 一条插件日志（给宿主的原始形态：参数不做格式化，怎么展示由出口决定） */
export interface PluginLogRecord {
  level: PluginLogLevel
  /** Context 名字链路，如 `conversation-hooks:ws-1:企业微信通知` */
  path: string
  args: unknown[]
}

export type PluginLogSink = (record: PluginLogRecord) => void

let sink: PluginLogSink | null = null

/**
 * 注入 / 摘除日志出口（`null` = 摘除）。宿主启动时调一次即可。
 *
 * 后注入的覆盖前一个 —— 一个进程只有一个应用日志，不需要多播。
 */
export function setPluginLogSink(next: PluginLogSink | null): void {
  sink = next
}

/** 交给出口；出口自己坏了只吞掉，绝不让日志把业务带崩 */
function forward(level: PluginLogLevel, path: string, args: unknown[]): void {
  if (!sink) return
  try {
    sink({ level, path, args })
  } catch {
    /* 日志出口失败不抛：它的职责是记录，不是阻断 */
  }
}

export class Logger {
  constructor(
    private readonly label: string,
    private readonly parent?: Logger
  ) {}

  /** 完整路径，如 `app:turn:builtin-file-tools` */
  private path(): string {
    return this.parent ? `${this.parent.path()}:${this.label}` : this.label
  }

  /** 只进 console：排查用的细粒度流水，不该刷进界面日志面板 */
  debug(...args: unknown[]): void {
    console.debug(`[plugin:${this.path()}]`, ...args)
  }

  info(...args: unknown[]): void {
    console.info(`[plugin:${this.path()}]`, ...args)
    forward('info', this.path(), args)
  }

  warn(...args: unknown[]): void {
    console.warn(`[plugin:${this.path()}]`, ...args)
    forward('warn', this.path(), args)
  }

  error(...args: unknown[]): void {
    console.error(`[plugin:${this.path()}]`, ...args)
    forward('error', this.path(), args)
  }

  /** 派生子 logger（名字追加一层），如 `ctx.logger.extend('mcp')` */
  extend(label: string): Logger {
    return new Logger(label, this)
  }
}
