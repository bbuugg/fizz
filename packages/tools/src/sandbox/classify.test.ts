/**
 * 防回归：把一次失败正确归到「被沙箱挡了」还是「runner 自己坏了」。
 *
 * 这两类如果混淆，模型会拿到完全相反的建议：拒绝 → 换做法 / 申请提权；
 * runner 失败 → 命令根本没跑，重试同一个命令毫无意义。
 */
import { describe, expect, it } from 'vitest'
import { classifyRunnerFailure, matchesSignature } from './classify'

describe('matchesSignature', () => {
  it('非零退出 + 命中签名才算拒绝', () => {
    expect(matchesSignature(1, "bash: x: Read-only file system", ['read-only file system'])).toBe(true)
  })

  it('退出码为 0 一律不算：命令自己打印 permission denied 是常态', () => {
    expect(matchesSignature(0, 'grep: /x: permission denied', ['permission denied'])).toBe(false)
  })

  it('没有退出码（启动失败）不算拒绝', () => {
    expect(matchesSignature(null, 'permission denied', ['permission denied'])).toBe(false)
  })

  it('大小写不敏感，且只认传入的方言（不看并集）', () => {
    expect(matchesSignature(1, 'Operation NOT permitted', ['operation not permitted'])).toBe(true)
    // bwrap 的方言里没有 EPERM 文本，不能拿 Seatbelt 的签名套到 bwrap 上
    expect(matchesSignature(1, 'operation not permitted', ['read-only file system'])).toBe(false)
  })

  it('空签名列表永远不算', () => {
    expect(matchesSignature(1, 'read-only file system', [])).toBe(false)
  })
})

describe('classifyRunnerFailure', () => {
  it('命中致命签名时返回那一行作为详情', () => {
    const hit = classifyRunnerFailure(
      1,
      'bwrap: setting up uid map: Permission denied\n',
      [{ fatalSignatures: ['bwrap: '] }]
    )
    expect(hit?.detail).toBe('bwrap: setting up uid map: Permission denied')
  })

  it('allowedExitCodes 门控：别的非零码不算 runner 失败', () => {
    const rules = [{ allowedExitCodes: [127], fatalSignatures: ['runner: '] }]
    expect(classifyRunnerFailure(127, 'runner: bad args', rules)?.detail).toBe('runner: bad args')
    expect(classifyRunnerFailure(1, 'runner: bad args', rules)).toBeUndefined()
  })

  it('informationalLines 按整行精确剔除，不能拿来当证据', () => {
    const rules = [
      {
        fatalSignatures: ['launcher: '],
        informationalLines: ['launcher: partial enforcement (older Landlock ABI)']
      }
    ]
    expect(
      classifyRunnerFailure(125, 'launcher: partial enforcement (older Landlock ABI)', rules)
    ).toBeUndefined()
    expect(classifyRunnerFailure(125, 'launcher: cannot exec', rules)?.detail).toBe('launcher: cannot exec')
  })

  it('退出码为 0 或未知时不算 runner 失败', () => {
    const rules = [{ fatalSignatures: ['bwrap: '] }]
    expect(classifyRunnerFailure(0, 'bwrap: x', rules)).toBeUndefined()
    expect(classifyRunnerFailure(null, 'bwrap: x', rules)).toBeUndefined()
  })
})
