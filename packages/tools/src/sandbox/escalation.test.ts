/**
 * 防回归：提权只能**一次性、严格更宽、参数成对**。
 *
 * 这三条任意一条松掉都会变成「模型能自己把沙箱关掉」：比如接受「原地申请」就等于
 * 每次多一张没意义的卡；接受比当前更窄的目标则纯粹是参数错误；没有理由的申请会让用户
 * 在不知道为什么要放行的情况下点同意。
 */
import { describe, expect, it } from 'vitest'
import { resolveSandboxEscalation, validateEscalationArgs } from './escalation'

describe('validateEscalationArgs', () => {
  it('两个参数必须成对出现', () => {
    expect(() => validateEscalationArgs('danger-full-access', undefined)).toThrow(
      /requires a justification/
    )
    expect(() => validateEscalationArgs(undefined, 'need to write /etc')).toThrow(
      /only valid together/
    )
  })

  it('理由不能是空白', () => {
    expect(() => validateEscalationArgs('danger-full-access', '   ')).toThrow(/non-empty/)
  })

  it('都不传是合法的（普通调用）', () => {
    expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow()
  })
})

describe('resolveSandboxEscalation', () => {
  it('没带 sandbox_permissions 就不产生申请', () => {
    expect(resolveSandboxEscalation(undefined, undefined, 'workspace-write')).toBeUndefined()
  })

  it('workspace-write 下可以申请 danger-full-access，并带上理由', () => {
    expect(
      resolveSandboxEscalation('danger-full-access', '需要写 ~/.npmrc', 'workspace-write')
    ).toEqual({ mode: 'danger-full-access', justification: '需要写 ~/.npmrc' })
  })

  it('目标与当前档一致时按当前档执行（不弹卡）', () => {
    expect(
      resolveSandboxEscalation('workspace-write', '想写工作区', 'workspace-write')
    ).toBeUndefined()
  })

  it('沙箱关着时申请「完全访问」是空操作（本来就没限制，不弹卡）', () => {
    expect(
      resolveSandboxEscalation('danger-full-access', '想写外面', 'danger-full-access')
    ).toBeUndefined()
  })

  it('沙箱关着时申请更窄的档直接报错纠正模型', () => {
    expect(() =>
      resolveSandboxEscalation('workspace-write', '想收窄', 'danger-full-access')
    ).toThrow(/not available/)
  })

  it('非法目标值直接拒绝', () => {
    expect(() =>
      resolveSandboxEscalation('read-only', '想只读', 'workspace-write')
    ).toThrow(/expected "workspace-write" or "danger-full-access"/)
  })

  it('只读档可以往两档申请（阶梯表完整）', () => {
    expect(resolveSandboxEscalation('workspace-write', '需要写工作区', 'read-only')).toEqual({
      mode: 'workspace-write',
      justification: '需要写工作区'
    })
    expect(resolveSandboxEscalation('danger-full-access', '需要写外面', 'read-only')).toEqual({
      mode: 'danger-full-access',
      justification: '需要写外面'
    })
  })
})
