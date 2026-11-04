/**
 * `iconOnlyUi` 的回归护栏。
 *
 * 这条测试在防的事：有人为了「停用的插件也能看到它的设置项 / 面板」，把 `iconOnlyUi`
 * 改成原样透传（或只改 `settings: []` 那一行）—— 界面上就会出现「已经停用、却还能配置、
 * 还能在附件菜单里选它的上传源」的半真半假状态。停用只保留**图标**这一个字段。
 */
import { describe, expect, it } from 'vitest'
import type { PluginUiDeclaration } from '@fizz/plugin'
import { iconOnlyUi } from './stopped-icons'

/** 一份「什么都声明了」的插件 UI（形状取自 `PluginUiDeclaration`） */
const full: PluginUiDeclaration = {
  icon: 'data:image/png;base64,AAA',
  settings: [
    { id: 'token', title: 'Token', type: 'string', secret: true },
    { id: 'region', title: '区域', type: 'string' }
  ],
  panels: [{ id: 'overview', title: '概览' }],
  surfaces: [
    {
      kind: 'sider',
      id: 'list',
      title: '列表',
      render: () => []
    }
  ]
}

describe('iconOnlyUi', () => {
  it('只留图标，设置项 / 面板 / 界面面一律清空', () => {
    const out = iconOnlyUi({ 'plugin:a': full })

    expect(out['plugin:a']).toEqual({
      icon: 'data:image/png;base64,AAA',
      settings: [],
      panels: [],
      surfaces: []
    })
  })

  it('没声明图标的插件整条不出现（不留空声明）', () => {
    const { icon: _dropped, ...withoutIcon } = full

    expect(iconOnlyUi({ 'plugin:b': withoutIcon })).toEqual({})
  })

  it('多个插件各留各的图标，互不串味', () => {
    const out = iconOnlyUi({
      'plugin:a': full,
      'plugin:c': { ...full, icon: 'data:image/svg+xml;base64,BBB' }
    })

    expect(Object.keys(out).sort()).toEqual(['plugin:a', 'plugin:c'])
    expect(out['plugin:a'].icon).toBe('data:image/png;base64,AAA')
    expect(out['plugin:c'].icon).toBe('data:image/svg+xml;base64,BBB')
  })
})
