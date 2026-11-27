// 防止移除附件上传源时误删 upload_to_oss 文件分享工具，或继续暴露已移除的开关。
import { describe, expect, it, vi } from 'vitest'
import plugin from './index'

type PluginContext = Parameters<typeof plugin.apply>[0]

function context() {
  const ctx = {
    logger: { warn: vi.fn() },
    ui: { icon: vi.fn(), setting: vi.fn() },
    tools: { register: vi.fn() },
    workspace: { path: '/workspace', label: 'example', resolve: (path: string) => `/workspace/${path}` },
    inject: vi.fn<PluginContext['inject']>()
  }
  ctx.inject.mockImplementation((_deps, cb) => cb(ctx))
  return ctx
}

describe('OSS 插件能力', () => {
  it('仅声明设置与工具，不请求上传服务或暴露附件上传开关', () => {
    const ctx = context()
    plugin.apply(ctx)
    expect(ctx.inject.mock.calls.map(([deps]) => deps)).toEqual([['ui'], ['tools', 'workspace']])
    expect(ctx.tools.register.mock.calls[0]?.[0]).toBe('upload_to_oss')
    expect(ctx.ui.setting.mock.calls.some(([setting]) => setting.id === 'enableUploadProvider')).toBe(false)
  })

  it('工具开关关闭后仍可编辑设置，但不挂载文件分享工具', () => {
    const ctx = context()
    plugin.apply(ctx, { enableTools: false })
    expect(ctx.ui.setting).toHaveBeenCalled()
    expect(ctx.tools.register).not.toHaveBeenCalled()
  })
})
