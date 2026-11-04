/**
 * 「插件」侧栏列表模型的回归保护。
 *
 * 这条纯函数决定「点插件这一行到底打开哪个面」。写错的表现很隐蔽：点一行没反应
 * （target 取不到）、或者每次都开到错的面（order / opens 判反），而界面上看不出原因。
 * 这里把四个分支各钉一条。
 */
import { describe, expect, it } from 'vitest'
import { pluginListOf } from './plugin-list'
import type { PluginSurfaceView } from '@fizz/contracts/agent-api'

function surface(
  overrides: Partial<PluginSurfaceView> & Pick<PluginSurfaceView, 'pluginId' | 'kind' | 'id'>
): PluginSurfaceView {
  const { pluginId, kind, id } = overrides
  return {
    key: `${pluginId}:${kind}:${id}`,
    pluginName: '演示插件',
    title: id,
    order: 0,
    hasAction: false,
    ...overrides
  }
}

describe('pluginListOf', () => {
  it('一个插件只出一行，默认面取 order 最小的那个 view', () => {
    const entries = pluginListOf([
      surface({ pluginId: 'demo', kind: 'view', id: 'keys', title: 'Key', order: 10 }),
      surface({ pluginId: 'demo', kind: 'view', id: 'connections', title: '连接', order: 0 })
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.target.id).toBe('connections')
  })

  it('老插件用 activityBar.opens 指定默认面时，按它来（而不是 order 最小的）', () => {
    const entries = pluginListOf([
      surface({ pluginId: 'demo', kind: 'activityBar', id: 'demo', order: 0, opens: 'view:detail' }),
      surface({ pluginId: 'demo', kind: 'view', id: 'list', order: 1 }),
      surface({ pluginId: 'demo', kind: 'view', id: 'detail', order: 9 })
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.target.id).toBe('detail')
  })

  it('只声明了 sider 的老插件也能点开（sider 面被当成标签页）', () => {
    const entries = pluginListOf([
      surface({ pluginId: 'legacy', kind: 'activityBar', id: 'legacy', opens: 'sider:home' }),
      surface({ pluginId: 'legacy', kind: 'sider', id: 'home', title: '状态' })
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.target.kind).toBe('sider')
    expect(entries[0]?.target.id).toBe('home')
  })

  it('只有 activityBar 而没有内容面的插件不出现（点开一片空白比没有入口更糟）', () => {
    const entries = pluginListOf([
      surface({ pluginId: 'empty', kind: 'activityBar', id: 'empty', opens: 'view:missing' })
    ])

    expect(entries).toEqual([])
  })

  it('说明与版本跟着插件走，没写就不塞字段（侧栏行据此决定要不要留第二行）', () => {
    const entries = pluginListOf([
      surface({
        pluginId: 'redis',
        kind: 'view',
        id: 'connections',
        pluginDescription: 'Redis 连接管理与 Key 浏览',
        pluginVersion: '1.0.0'
      }),
      surface({ pluginId: 'bare', kind: 'view', id: 'main' })
    ])

    expect(entries.find((entry) => entry.pluginId === 'redis')?.description).toBe(
      'Redis 连接管理与 Key 浏览'
    )
    expect(entries.find((entry) => entry.pluginId === 'redis')?.version).toBe('1.0.0')
    expect(entries.find((entry) => entry.pluginId === 'bare')?.description).toBeUndefined()
    expect(entries.find((entry) => entry.pluginId === 'bare')?.version).toBeUndefined()
  })

  it('多个插件按 rank 升序，且各自带上插件图标', () => {
    const entries = pluginListOf([
      surface({ pluginId: 'b', kind: 'view', id: 'main', order: 5, pluginIcon: 'data:image/svg+xml,b' }),
      surface({ pluginId: 'a', kind: 'view', id: 'main', order: 1, pluginIcon: 'data:image/svg+xml,a' })
    ])

    expect(entries.map((entry) => entry.pluginId)).toEqual(['a', 'b'])
    expect(entries[0]?.icon).toBe('data:image/svg+xml,a')
  })
})
