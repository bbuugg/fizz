/**
 * 这条测试在防什么回归：
 *
 * `POST /api/prefs` 是**唯一**的偏好写入口，请求体来自各端、可能是旧版本客户端或手改的
 * JSON。归一化一旦出错，用户配好的重试次数 / 步数上限会被悄悄换成默认值 —— 表现是
 * 「设置里明明填了 8，跑起来还是 2」，而且没有报错可查（本项目最常见的坑）。
 *
 * 所以这里钉住三件事：
 * 1. 不认识的 key 不进库（防止有人把任意 localStorage key 塞进 CoreData）；
 * 2. **非法值丢弃**而不是回落默认（`maxRetries: NaN` 不该把原来的 5 冲成 2）；
 * 3. 默认值与升级前各模块读侧的回落一致（`gitTreeView` 是 `!== '0'` 即树状、`wordWrap`
 *    默认 on、`scrollback` 默认 5000），否则没设置过的用户升级后行为会变。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFS,
  PREF_KEYS,
  isPrefKey,
  normalizePref,
  normalizePrefs,
  normalizePrefsPatch
} from './prefs'

describe('normalizePrefsPatch（写入口）', () => {
  it('只收白名单里的 key', () => {
    const patch = normalizePrefsPatch({
      'fizz.web.maxRetries': '8',
      // 任意 localStorage key 不能借这个接口进 CoreData
      'fizz.web.sidebarWidth': '320',
      'fizz.debug.sse': '1'
    })
    expect(patch).toEqual({ 'fizz.web.maxRetries': '8' })
  })

  it('非法值直接丢弃，不回落默认值', () => {
    const patch = normalizePrefsPatch({
      'fizz.web.maxRetries': 'NaN',
      'fizz.web.maxSteps': { nope: true },
      'fizz.web.permissionMode': 'godmode'
    })
    // 空 patch = 一个字段都不动，用户原来的值原样保留
    expect(patch).toEqual({})
  })

  it('数值夹到合法区间（设置页手输越界不该把 agent 跑飞）', () => {
    // 上限只挡天文数字：设置页是自由输入，100 次重试该原样生效
    expect(normalizePrefsPatch({ 'fizz.web.maxRetries': '100' })).toEqual({ 'fizz.web.maxRetries': '100' })
    expect(normalizePrefsPatch({ 'fizz.web.maxRetries': '1e9' })).toEqual({ 'fizz.web.maxRetries': '1000' })
    expect(normalizePrefsPatch({ 'fizz.web.maxSteps': '0' })).toEqual({ 'fizz.web.maxSteps': '1' })
    expect(normalizePrefsPatch({ 'fizz.web.confirmTimeout': '3.6' })).toEqual({ 'fizz.web.confirmTimeout': '4' })
  })

  it('空串对数字是非法值（设置页清空输入框不等于 0）', () => {
    expect(normalizePrefsPatch({ 'fizz.web.maxRetries': '' })).toEqual({})
  })

  it('语音静音超时：负数判非法（不是夹成 0），上界夹到 3600', () => {
    // 负数一旦被夹成 0，语义就从「60 秒后自动停」变成「永远不停、麦克风一直开」
    expect(normalizePrefsPatch({ 'fizz.web.voiceSilenceTimeout': '-5' })).toEqual({})
    expect(normalizePrefsPatch({ 'fizz.web.voiceSilenceTimeout': '9999' })).toEqual({
      'fizz.web.voiceSilenceTimeout': '3600'
    })
  })

  it('terminalShell 空串是合法值（自动探测），带换行的注入串不是', () => {
    expect(normalizePrefsPatch({ 'fizz.agent.terminalShell': '' })).toEqual({ 'fizz.agent.terminalShell': '' })
    expect(normalizePrefsPatch({ 'fizz.agent.terminalShell': 'pwsh\nrm -rf /' })).toEqual({})
  })

  it('提交 10 个 key 就改 10 个（这是「不为每项开接口」的前提）', () => {
    const patch = normalizePrefsPatch({
      'fizz.web.maxRetries': '4',
      'fizz.web.maxSteps': '120',
      'fizz.web.toolCallConcurrency': '2',
      'fizz.web.toolIntent': '0',
      'fizz.web.permissionMode': 'readonly',
      'fizz.web.terminalScrollback': '10000',
      'fizz.web.gitTreeView': '0',
      'fizz.file-manager.view': 'list',
      'fizz.file-manager.show-hidden': '1',
      'fizz.web.editorWordWrap': 'off'
    })
    expect(Object.keys(patch)).toHaveLength(10)
  })
})

describe('normalizePrefs（读侧 / 落盘）', () => {
  it('缺字段补默认，且默认为空表', () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS)
    expect(normalizePrefs('garbage')).toEqual(DEFAULT_PREFS)
  })

  it('已有合法值原样保留；越界值夹紧（与旧 resolveMaxSteps 一致）；非数字才回落默认', () => {
    const prefs = normalizePrefs({ 'fizz.web.maxRetries': '9', 'fizz.web.maxSteps': '-3' })
    expect(prefs['fizz.web.maxRetries']).toBe('9')
    // 越界不是「非法」：老代码 resolveMaxSteps(-3) 也是夹到 1，不能在这里改成默认值
    expect(prefs['fizz.web.maxSteps']).toBe('1')
    expect(normalizePref('fizz.web.maxSteps', 'abc')).toBe(DEFAULT_PREFS['fizz.web.maxSteps'])
  })

  it('默认值与升级前各模块读侧一致', () => {
    // gitTreeView：老实现是 `getItem() !== '0'` → 没存过 = 树状
    expect(DEFAULT_PREFS['fizz.web.gitTreeView']).toBe('1')
    // 终端行为默认全开
    expect(DEFAULT_PREFS['fizz.web.terminalCopyOnSelect']).toBe('1')
    expect(DEFAULT_PREFS['fizz.web.terminalScrollback']).toBe('5000')
    // Monaco 的 wordWrap 是 'on' / 'off'，不是 1 / 0
    expect(DEFAULT_PREFS['fizz.web.editorWordWrap']).toBe('on')
    // 默认 shell 空串 = 自动探测
    expect(DEFAULT_PREFS['fizz.agent.terminalShell']).toBe('')
    // 通知：老实现是 `getItem() !== '0'` → 没存过 = 开
    expect(DEFAULT_PREFS['fizz.web.notify']).toBe('1')
    // 语音静音超时默认 60 秒
    expect(DEFAULT_PREFS['fizz.web.voiceSilenceTimeout']).toBe('60')
  })

  it('命令沙箱只认 off / workspace-write（默认 off）', () => {
    expect(DEFAULT_PREFS['fizz.web.sandboxMode']).toBe('off')
    expect(normalizePref('fizz.web.sandboxMode', 'workspace-write')).toBe('workspace-write')
    // 拼错的开关不能悄悄变成「开」
    expect(normalizePref('fizz.web.sandboxMode', 'on')).toBe('off')
  })

  it('每个白名单 key 都有默认值（加 key 忘了补默认会在这里炸）', () => {
    for (const key of PREF_KEYS) expect(DEFAULT_PREFS[key]).toBeTypeOf('string')
    expect(Object.keys(DEFAULT_PREFS).sort()).toEqual([...PREF_KEYS].sort())
  })
})

describe('isPrefKey', () => {
  it('只认白名单', () => {
    expect(isPrefKey('fizz.web.maxRetries')).toBe(true)
    expect(isPrefKey('fizz.web.sidebarWidth')).toBe(false)
  })

  it('归一化后一定落在默认值或合法值上', () => {
    expect(normalizePref('fizz.web.permissionMode', undefined)).toBe('confirm')
    expect(normalizePref('fizz.web.permissionMode', 'full')).toBe('full')
  })
})
