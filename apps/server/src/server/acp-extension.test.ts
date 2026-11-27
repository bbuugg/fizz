/** 防回归：移除可编辑类型后，新 pi 预设及旧 wrapper+type 身份仍能启用内部确认扩展。 */
import { describe, expect, it } from 'vitest'
import type { AcpAgentConfig } from '@fizz/acp'
import { isPiAcpAgent } from './acp-extension'

const base: AcpAgentConfig = { id: 'agent', name: 'Custom', command: 'wrapper', args: [] }
describe('pi ACP 内部身份兼容', () => {
  it.each([
    { preset: 'pi' },
    { type: 'pi' as const },
    { command: 'pi-acp' },
    { command: 'npx', args: ['-y', 'pi-acp'] },
  ])('保留预设、旧类型与命令兜底：%j', (identity) => {
    expect(isPiAcpAgent({ ...base, ...identity })).toBe(true)
  })
  it.each([{}, { type: 'generic' as const }, { preset: 'open_code', type: 'opencode' as const }])(
    '不把其他 Agent 当 pi：%j', (identity) => {
      expect(isPiAcpAgent({ ...base, ...identity })).toBe(false)
    },
  )
})
