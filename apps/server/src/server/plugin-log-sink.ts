/**
 * 把插件日志接进**应用日志**（日志面板的「插件」页）。
 *
 * ## 为什么需要这一步
 *
 * `@fizz/plugin` 的 `Logger` 只写 `console`，而打包后的桌面端主进程**没有控制台窗口** ——
 * 于是插件侧的一切异常（「企业微信通知发送失败」「MCP 起不来」）在界面上完全不可见，
 * 表现是「点了没反应、也没有报错」。这里补上那条出口。
 *
 * ## 为什么是「宿主注入」而不是让 Logger 直接 import
 *
 * `packages/plugin` 是能力底座，`agent` / `workspace` 反过来依赖它；包边界规则
 * （`scripts/check-boundaries.mjs` 的 plugin 那条）禁掉了 `plugin → workspace` 的反向值依赖。
 * 所以由服务端（本来就同时依赖两边）把 `appLog` 塞进 `setPluginLogSink`。
 *
 * ## 格式约定
 *
 * 一条日志 → 一条应用日志：第一个参数当正文，其余拼进 `detail`（多行折叠展示）。
 * 字符串原样用；`Error` 取 `stack`（没有就取 `message`）；其余 `JSON.stringify`
 * 失败时退回 `String()` —— **格式化本身绝不能抛**，它是兜底路径的最后一环。
 *
 * ⚠️ 幂等：重复调用只会覆盖同一个出口（`setPluginLogSink` 是单槽）。
 */
import { appLog, type AppLogLevel } from '@fizz/workspace'
import { setPluginLogSink, type PluginLogRecord } from '@fizz/plugin'

/** 单个参数 → 可读文本（见文件头的格式约定） */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 一条插件日志 → `appLog` 的 `(scope, level, message, detail)` */
function toAppLog(record: PluginLogRecord): void {
  const parts = record.args.map(textOf)
  const message = `[plugin:${record.path}] ${parts[0] ?? ''}`.trim()
  const detail = parts.slice(1).join('\n')
  const level: AppLogLevel = record.level
  appLog.log('plugin', level, message, detail || undefined)
}

/** 装上出口（服务端启动时在 `appLog.init` 之后调一次） */
export function installPluginLogSink(): void {
  setPluginLogSink(toAppLog)
}
