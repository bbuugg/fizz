/**
 * 插件日志的**出口**（`setPluginLogSink`）。
 *
 * 这条测试防的是「日志只进 console」这类回归：打包后的桌面端没有控制台，插件侧一旦
 * 退回纯 console，「通知为什么没发出去」就再也查不到（实测踩过：企微通知失败只有一行
 * `console.warn`，界面上既没消息也没报错）。三件事要钉住：
 * 1. `info` / `warn` / `error` 都进出口，`debug` 不进（太吵）；
 * 2. 路径是 Context 名字链路（不然日志面板里分不清是谁写的）；
 * 3. 出口自己抛错**不能**冒回插件 —— 日志的职责是记录，不是阻断。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger, setPluginLogSink, type PluginLogRecord } from './logger'

afterEach(() => {
  setPluginLogSink(null)
  vi.restoreAllMocks()
})

/** 收下所有日志的假出口 */
function collect(): PluginLogRecord[] {
  const out: PluginLogRecord[] = []
  setPluginLogSink((record) => out.push(record))
  return out
}

describe('Logger 的日志出口', () => {
  it('info / warn / error 都进出口，带 Context 名字链路', () => {
    const records = collect()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const app = new Logger('app')
    const plugin = app.extend('企业微信通知')
    plugin.info('[wecom] 已推送「会话完成」通知')
    plugin.warn('[wecom] 待确认通知发送失败：', 'errcode 45009')
    plugin.error('[wecom] 炸了')

    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error'])
    expect(records[0]?.path).toBe('app:企业微信通知')
    expect(records[1]?.args).toEqual(['[wecom] 待确认通知发送失败：', 'errcode 45009'])
  })

  it('debug 只留在 console，不进出口', () => {
    const records = collect()
    vi.spyOn(console, 'debug').mockImplementation(() => {})

    new Logger('app').debug('细粒度流水')

    expect(records).toEqual([])
  })

  it('出口抛错不影响调用方（日志不能把业务带崩）', () => {
    setPluginLogSink(() => {
      throw new Error('日志面板写不进去')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => new Logger('app').warn('会话收尾失败')).not.toThrow()
  })

  it('没装出口时行为不变（只 console）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => new Logger('app').warn('hello')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[plugin:app]', 'hello')
  })
})
