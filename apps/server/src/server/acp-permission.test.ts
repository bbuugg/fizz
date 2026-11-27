/** 防回归：自动答复只选原始 allow_once ID，不能退回 allow_always，也不绕过确认模式。 */
import { describe, expect, it } from 'vitest'
import { pickAcpAutoPermissionOption } from './acp-permission'

const once = { optionId: 'vendor:approve:this', name: '本次允许', kind: 'allow_once' as const }
const always = { optionId: 'vendor:remember', name: '记住授权', kind: 'allow_always' as const }
describe('ACP 自动权限答复', () => {
  it('完全放行只选 allow_once，保留 Agent 的原始 optionId', () => {
    expect(pickAcpAutoPermissionOption('allow', [always, once])).toBe(once)
  })
  it.each(['confirm', undefined] as const)('%s 不替用户答复，确认卡仍可呈现所有原始选项', (mode) => {
    const options = [always, once]
    expect(pickAcpAutoPermissionOption(mode, options)).toBeUndefined()
    expect(options).toEqual([always, once])
  })
  it.each([{ options: [always] }, { options: [] }, { options: undefined }])('缺少本次允许时退回确认：%j', ({ options }) => {
    expect(pickAcpAutoPermissionOption('allow', options)).toBeUndefined()
  })
})
