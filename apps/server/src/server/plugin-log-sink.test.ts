/**
 * 插件日志 → 应用日志的出口（`plugin-log-sink`）。
 *
 * 这条链路是「通知为什么没发出去」唯一可见的线索：插件侧 `ctx.logger.warn(...)` 只有接上
 * 出口，才会出现在日志面板的「插件」页。这里锁死三件事：
 *
 * 1. 级别原样透传（`info` / `warn` / `error`），scope 固定 `plugin`；
 * 2. 正文带 `[plugin:<路径>]` 前缀，多余参数进 `detail`（多行折叠）；
 * 3. 参数格式化**绝不抛**（`Error` 取栈、循环引用退回 `String()`）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Logger } from '@fizz/plugin'
import { appLog } from '@fizz/workspace'
import { installPluginLogSink } from './plugin-log-sink'

beforeAll(async () => {
  await appLog.init(mkdtempSync(join(tmpdir(), 'fizz-plugin-log-')))
  installPluginLogSink()
})

/** 取最后一条应用日志（每次断言只看刚写进去的那条） */
const last = () => appLog.list().at(-1)!

describe('插件日志出口', () => {
  it('warn：级别、scope、路径前缀、detail 都对得上', () => {
    const log = new Logger('conversation-hooks:ws-1').extend('企业微信通知')
    log.warn('[wecom] 测试告警', 'detail-1')

    const entry = last()
    expect(entry.scope).toBe('plugin')
    expect(entry.level).toBe('warn')
    expect(entry.message).toBe('[plugin:conversation-hooks:ws-1:企业微信通知] [wecom] 测试告警')
    expect(entry.detail).toBe('detail-1')
  })

  it('info / error 也进（级别不降级）', () => {
    const log = new Logger('app:turn')
    log.info('开始处理')
    expect(last()).toMatchObject({ scope: 'plugin', level: 'info', message: '[plugin:app:turn] 开始处理' })
    expect(last().detail).toBeUndefined()

    log.error('发送失败')
    expect(last()).toMatchObject({ level: 'error', message: '[plugin:app:turn] 发送失败' })
  })

  it('多个参数按行拼进 detail；Error 取栈而不是 [object Object]', () => {
    const log = new Logger('wecom')
    log.warn('推送失败', new Error('45009 频率超限'), { status: 400 })

    const entry = last()
    expect(entry.message).toBe('[plugin:wecom] 推送失败')
    const lines = entry.detail!.split('\n')
    expect(lines[0]).toContain('45009 频率超限')
    // Error 的栈是多行，所以「下一个参数」落在最后一行
    expect(lines.at(-1)).toBe('{"status":400}')
  })

  it('循环引用不抛（格式化是兜底路径的最后一环）', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => new Logger('wecom').warn('怪参数', cyclic)).not.toThrow()
    expect(last().message).toBe('[plugin:wecom] 怪参数')
  })

  it('debug 不进应用日志（太吵，且从不是「为什么没生效」的答案）', () => {
    const before = appLog.list().length
    new Logger('wecom').debug('流水')
    expect(appLog.list().length).toBe(before)
  })
})
