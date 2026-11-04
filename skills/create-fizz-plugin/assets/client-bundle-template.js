/**
 * Fizz 插件**前端半**的参考实现（`plugin.json` 的 `client.entry` 指向本文件）。
 *
 * 五条硬约束，抄之前先看一眼：
 * 1. **顶层同步注册**：`new Function(code)()` 这一行里必须调完 `__FIZZ_PLUGIN__`。
 *    写成 `import(...).then(...)` 或 `await` 注册 = 宿主等不到，界面直接报「没有注册」。
 * 2. **没有任何 import**：这是预构建产物。要 React / UI 原语 / 图标，一律从 `host` 取；
 *    第三方库得自己内联进这个文件。仓库的做法是把源码写成 `client.jsx`，跑
 *    `npm run build:plugins`（tsc 经典 JSX 转换）产出 `client.js`，产物含 import 会直接报错。
 * 3. **React 只能是 `host.React`**：自带一份 = 两个 React，hooks 直接报错。
 * 4. **`render` 是纯渲染**：宿主在自己的渲染函数里同步调它，所以在 `render` 里调 hooks
 *    会让 hook 顺序随面 / 版本切换而变。状态一律写在下面的组件里（`render` 只负责
 *    `return h(YourSurface, ctx)`）。
 * 5. 头部（含顶栏按钮）**由插件自己画**：client 面不吃清单里的 `headerActions`，
 *    宿主也不替它渲染顶栏。弹窗用 `host.ui.Dialog*`，别自绘遮罩。
 *
 * 与它配套的服务端半（`index.ts`）只需要注册 rpc 方法：
 *
 * ```ts
 * import type { Context } from '@fizz/plugin'
 * export default {
 *   name: '示例（前端半）',
 *   inject: ['rpc'],
 *   apply(ctx: Context) {
 *     ctx.rpc.handle('list', async () => ['alpha', 'beta'])
 *     ctx.rpc.handle('add', async (payload) => { ... })
 *   }
 * }
 * ```
 */
window.__FIZZ_PLUGIN__('demo-client', (host) => {
  const { React, ui, icons, lib } = host
  const { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } = ui
  const { cn } = lib
  const h = React.createElement

  // 每个插件只注入一段：宿主按插件 id 打标记，停用 / 热更新时会整段摘掉
  host.injectStyle(`
    .demo-client-row { display: flex; align-items: center; gap: 8px; }
    .demo-client-row + .demo-client-row { margin-top: 4px; }
  `)

  /** 一个面（`client.surfaces[].id` 认领它） */
  function DemoSurface({ surfaceId, params, rpc, openView }) {
    const [items, setItems] = React.useState(null)
    const [draft, setDraft] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)

    // rpc 是唯一后端入口：桌面端渲染进程没有 HTTP 端口，别在这里 fetch('/api/...')
    const reload = React.useCallback(() => {
      rpc('list')
        .then((next) => {
          setItems(next)
          setError(null)
        })
        .catch((err) => setError(String(err && err.message ? err.message : err)))
    }, [rpc])

    React.useEffect(() => {
      reload()
    }, [reload])

    const add = () => {
      const value = draft.trim()
      if (!value || busy) return
      setBusy(true)
      rpc('add', { value })
        .then(() => {
          setDraft('')
          reload()
        })
        .catch((err) => setError(String(err && err.message ? err.message : err)))
        .finally(() => setBusy(false))
    }

    if (error) {
      return h(
        'div',
        { className: 'p-3 text-xs text-destructive break-words' },
        error
      )
    }
    if (!items) {
      return h(
        'div',
        { className: 'flex h-full items-center justify-center' },
        h(Spinner, { className: 'size-4 text-muted-foreground' })
      )
    }

    return h(
      'div',
      { className: 'flex flex-col gap-3 p-3' },
      h(
        Card,
        null,
        h(
          CardHeader,
          { className: 'flex-row items-center justify-between gap-2 pb-2' },
          h(CardTitle, { className: 'text-sm' }, '示例列表'),
          h(Badge, { variant: 'outline', className: 'text-[0.625rem]' }, surfaceId)
        ),
        h(
          CardContent,
          { className: 'flex flex-col gap-2' },
          // 打开这一屏时带的参数（同一个面开多屏时用得上）
          params && Object.keys(params).length
            ? h(
                'p',
                { className: 'text-[0.6875rem] text-muted-foreground' },
                JSON.stringify(params)
              )
            : null,
          items.length === 0
            ? h('p', { className: 'text-xs text-muted-foreground' }, '还没有条目')
            : items.map((item) =>
                h(
                  'div',
                  { key: String(item), className: cn('demo-client-row text-xs') },
                  h(icons.Check, { className: 'size-3.5 text-muted-foreground' }),
                  h('span', { className: 'text-foreground' }, String(item))
                )
              ),
          h(
            'div',
            { className: 'flex items-center gap-2 pt-1' },
            h(Input, {
              value: draft,
              placeholder: '加一条…',
              className: 'h-7 text-xs',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') add()
              }
            }),
            h(
              Button,
              { size: 'sm', className: 'h-7 gap-1 px-2 text-xs', disabled: busy, onClick: add },
              busy ? h(Spinner, { className: 'size-3' }) : h(icons.Plus, { className: 'size-3' }),
              '添加'
            ),
            /*
             * 开新标签：**同一个面 + 不同 params 就是另一屏**（宿主按 params 去重）。
             * 标签的 key / 分屏 / 关闭保护都归宿主，插件只负责请求。
             */
            h(
              Button,
              {
                size: 'sm',
                variant: 'outline',
                className: 'h-7 px-2 text-xs',
                onClick: () =>
                  openView({
                    surfaceId,
                    params: { ...(params || {}), n: Date.now() },
                    label: '再开一屏'
                  })
              },
              '再开一屏'
            )
          )
        )
      )
    )
  }

  /**
   * 宿主每渲染一次就调一次 `render`：**别在这里做副作用**（写状态、发请求放 useEffect）。
   * 返回 null 表示「这个面不归我」。
   */
  return {
    render: (surfaceId, ctx) => {
      if (surfaceId !== 'main') return null
      return h(DemoSurface, ctx)
    },
    /** 插件被停用 / 卸载 / 换版本时调：清定时器、断开连接 */
    dispose: () => {
      /* 这个示例没有长驻资源，留空即可 */
    }
  }
})
