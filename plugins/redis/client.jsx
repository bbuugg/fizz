/**
 * Redis 客户端 —— **前端半**（双面包的另一半，服务端半在 `index.ts`）。
 *
 * 构建：`npm run build:plugins`（tsc 把 JSX 转成 `React.createElement`，产出 `client.js`）。
 * **`client.js` 是产物，别手改**；改这个文件再构建。
 *
 * 五条硬约束（`skills/create-fizz-plugin` 的 3.7 节有完整版）：
 * 1. 顶层同步注册；
 * 2. 没有 import（React / UI 原语 / 图标全从 `host` 取）；
 * 3. React 只能是 `host.React`（两个 React = hooks 直接报错）；
 * 4. `render` 是纯渲染，不许在里面调 hooks —— 状态都在下面的组件里；
 * 5. 头部（顶栏按钮）自己画：client 面不吃清单里的 `headerActions`。
 *
 * 与旧版（块式界面）的差别只有一处，但很关键：**界面状态在这儿**。游标 / 过滤词 /
 * 打开哪个 key / 命令行输出全是各标签页自己的 —— 早先它们在服务端存着，同一个连接开两页
 * 会互相踩游标。
 */
window.__FIZZ_PLUGIN__('redis', (host) => {
  const { React, ui, icons, lib } = host
  const cn = lib.cn
  const {
    Badge,
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    ScrollArea,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    Spinner,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea
  } = ui
  const { Plus, RefreshCw, Search, Settings, Trash2, X } = icons

  /** 表单一行：标签 + 控件（窄侧栏里也排得下） */
  function Field({ label, children, hint }) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        {children}
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
    )
  }

  /** 状态点：绿=连着，灰=没连，红=出错/掉线 */
  function StatusDot({ tone }) {
    return (
      <span
        className={cn(
          'inline-block size-1.5 shrink-0 rounded-full',
          tone === 'success' ? 'bg-emerald-500' : tone === 'danger' ? 'bg-red-500' : 'bg-muted-foreground'
        )}
      />
    )
  }

  /** 把 rpc 的错误统一成一句人话（服务端半抛的是中文原话，直接显示） */
  function messageOf(err) {
    return err instanceof Error ? err.message : String(err)
  }

  // -------------------------------------------------------------------------
  // 连接编辑弹窗（新增 / 修改共用）
  // -------------------------------------------------------------------------

  const EMPTY_CONN = {
    name: '',
    host: '127.0.0.1',
    port: '6379',
    username: '',
    password: '',
    db: '0',
    tls: false,
    timeoutMs: '10000'
  }

  function ConnDialog({ open, initial, rpc, notify, onClose, onSaved }) {
    const [form, setForm] = React.useState(EMPTY_CONN)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')

    // 每次打开都从 `initial` 重置：**别把上一次的残值带进来**（尤其是密码框）
    React.useEffect(() => {
      if (!open) return
      setError('')
      setForm(
        initial
          ? {
              name: initial.name,
              host: initial.host,
              port: String(initial.port),
              username: initial.username || '',
              // 密码不回传，这里只能是空的 = 「不改」
              password: '',
              db: String(initial.db),
              tls: Boolean(initial.tls),
              timeoutMs: String(initial.timeoutMs || 10000)
            }
          : EMPTY_CONN
      )
    }, [open, initial])

    const set = (key) => (event) =>
      setForm((prev) => ({
        ...prev,
        [key]: event.target ? event.target.value : event
      }))

    async function submit() {
      if (busy) return
      setBusy(true)
      setError('')
      try {
        await rpc('conns.save', {
          ...(initial ? { id: initial.id } : {}),
          name: form.name.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 6379,
          username: form.username.trim(),
          // 留空 = 不改（服务端半按这个约定处理）
          password: form.password,
          db: Number(form.db) || 0,
          tls: form.tls,
          timeoutMs: Number(form.timeoutMs) || 10000
        })
        onSaved()
        onClose()
      } catch (err) {
        setError(messageOf(err))
      } finally {
        setBusy(false)
      }
    }

    return (
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{initial ? '修改连接' : '新增连接'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field label="名字">
              <Input value={form.name} onChange={set('name')} placeholder="本地开发" autoFocus />
            </Field>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field label="地址">
                  <Input value={form.host} onChange={set('host')} placeholder="127.0.0.1" />
                </Field>
              </div>
              <div className="w-24">
                <Field label="端口">
                  <Input value={form.port} onChange={set('port')} inputMode="numeric" />
                </Field>
              </div>
              <div className="w-20">
                <Field label="DB">
                  <Input value={form.db} onChange={set('db')} inputMode="numeric" />
                </Field>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field label="用户名" hint="ACL 用户（没有就留空）">
                  <Input value={form.username} onChange={set('username')} placeholder="default" />
                </Field>
              </div>
              <div className="flex-1">
                <Field
                  label="密码"
                  hint={initial && initial.hasPassword ? '已设置，留空表示不改' : '没有就留空'}
                >
                  <Input
                    type="password"
                    value={form.password}
                    onChange={set('password')}
                    placeholder={initial && initial.hasPassword ? '••••••' : ''}
                  />
                </Field>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Switch checked={form.tls} onCheckedChange={(v) => set('tls')(v)} id="redis-tls" />
                <Label htmlFor="redis-tls" className="text-xs">
                  TLS
                </Label>
              </div>
              <div className="w-28">
                <Field label="超时(ms)">
                  <Input value={form.timeoutMs} onChange={set('timeoutMs')} inputMode="numeric" />
                </Field>
              </div>
            </div>
            {error ? <p className="text-xs text-red-500">{error}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={busy}>
                取消
              </Button>
            </DialogClose>
            <Button size="sm" disabled={busy} onClick={submit}>
              {busy ? <Spinner className="size-3.5" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // -------------------------------------------------------------------------
  // 面 `connections`：连接列表（点插件行后默认打开这一面）
  //
  // 以前这是插件的侧栏（活动栏一颗图标配一列），现在插件不占侧栏了 —— 这一面
  // 和 Key 浏览一样是个标签页，点连接再 openView 开 `key` 面。
  // -------------------------------------------------------------------------

  function ConnectionsView({ rpc, notify, openView }) {
    const [conns, setConns] = React.useState(null)
    const [error, setError] = React.useState('')
    const [editing, setEditing] = React.useState(null)
    const [dialogOpen, setDialogOpen] = React.useState(false)
    const [removing, setRemoving] = React.useState(null)

    const load = React.useCallback(async () => {
      try {
        const res = await rpc('conns.list')
        setConns(res.conns || [])
        setError('')
      } catch (err) {
        setError(messageOf(err))
      }
    }, [rpc])

    React.useEffect(() => {
      void load()
    }, [load])

    function openNew() {
      setEditing(null)
      setDialogOpen(true)
    }

    function openEdit(conn) {
      setEditing(conn)
      setDialogOpen(true)
    }

    async function remove(conn) {
      try {
        await rpc('conns.remove', { id: conn.id })
        setRemoving(null)
        notify.success(`已删除「${conn.name}」`)
        await load()
      } catch (err) {
        notify.error(messageOf(err))
      }
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/*
          自带头部：client 面不该指望宿主画顶栏（它连标题行都跳过了）。
          高度与宿主侧栏那排按钮对齐（h-8），免得上下一换面就跳一下。
        */}
        <div className="flex h-8 shrink-0 items-center justify-between gap-1 border-b px-2">
          <span className="truncate text-xs font-medium text-muted-foreground">连接</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              title="刷新"
              onClick={() => void load()}
              aria-label="刷新"
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" title="新增连接" onClick={openNew} aria-label="新增连接">
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {error ? (
            <div className="flex flex-col gap-2 p-3">
              <p className="text-xs text-red-500">{error}</p>
              <Button variant="outline" size="sm" className="h-7 self-start text-xs" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : conns === null ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              读取中…
            </div>
          ) : conns.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-3">
              <p className="text-xs text-muted-foreground">还没有连接。</p>
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={openNew}>
                <Plus className="size-3.5" />
                新增一个
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col p-1">
              {conns.map((conn) => (
                <li key={conn.id} className="group relative">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() =>
                      // 同一个面 + 不同 params = 另一个标签页；重复点只会聚焦已有的那个
                      openView({
                        surfaceId: 'key',
                        params: { conn: conn.id },
                        label: conn.name,
                        title: `${conn.name} · Redis`
                      })
                    }
                  >
                    <span className="mt-1.5">
                      <StatusDot tone={conn.status?.tone} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{conn.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {conn.host}:{conn.port} / db{conn.db}
                        {conn.tls ? ' · TLS' : ''}
                      </span>
                      {conn.status && conn.status.tone !== 'success' && conn.status.tone !== 'muted' ? (
                        <span className="block truncate text-[11px] text-red-500">{conn.status.label}</span>
                      ) : null}
                    </span>
                  </button>
                  {/* 行内操作只在 hover / focus 时露出来：侧栏窄，常驻会挤掉地址 */}
                  <span className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="修改"
                      aria-label="修改"
                      onClick={() => openEdit(conn)}
                    >
                      <Settings className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除"
                      aria-label="删除"
                      onClick={() => setRemoving(conn)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <ConnDialog
          open={dialogOpen}
          initial={editing}
          rpc={rpc}
          notify={notify}
          onClose={() => setDialogOpen(false)}
          onSaved={() => void load()}
        />

        {/* 删除是不可逆的（连接配置一删，密码也跟着没了）—— 必须二次确认 */}
        <Dialog open={Boolean(removing)} onOpenChange={(next) => (next ? undefined : setRemoving(null))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除连接？</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              「{removing ? removing.name : ''}」的地址与密码会一起删掉，取消就什么都没有发生。
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" onClick={() => removing && remove(removing)}>
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 主视图：一个连接一页
  // -------------------------------------------------------------------------

  /** TTL 的人话：-1 永久、-2 不存在（Redis 的约定，别自己另发明） */
  function ttlLabel(ttl) {
    if (ttl === -1) return '永久'
    if (ttl === -2) return '不存在'
    if (ttl >= 3600) return `${Math.round(ttl / 3600)} 小时`
    if (ttl >= 60) return `${Math.round(ttl / 60)} 分钟`
    return `${ttl} 秒`
  }

  function Pane({ rpc, notify, params }) {
    const connId = params && params.conn ? String(params.conn) : ''
    const [conn, setConn] = React.useState(null)
    const [error, setError] = React.useState('')
    const [mode, setMode] = React.useState('data')
    /** 数据被改过就 +1：让「数据」屏重拉列表（命令行里 SET 了也一样） */
    const [nonce, setNonce] = React.useState(0)

    const load = React.useCallback(async () => {
      if (!connId) return
      try {
        const view = await rpc('conns.get', { id: connId })
        setConn(view)
        setError('')
      } catch (err) {
        setError(messageOf(err))
      }
    }, [rpc, connId])

    React.useEffect(() => {
      void load()
    }, [load])

    async function selectDb(next) {
      try {
        await rpc('db.select', { conn: connId, db: Number(next) })
        await load()
        setNonce((n) => n + 1)
      } catch (err) {
        notify.error(messageOf(err))
      }
    }

    if (!connId) {
      return <div className="p-3 text-xs text-muted-foreground">这条标签页没有带连接参数。</div>
    }
    if (error) {
      return (
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-xs text-red-500">{error}</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )
    }
    if (!conn) {
      return (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          连接中…
        </div>
      )
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot tone={conn.status && conn.status.tone} />
            <span className="truncate text-xs font-medium">{conn.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {conn.host}:{conn.port}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Select value={String(conn.db)} onValueChange={selectDb}>
              <SelectTrigger className="h-7 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 16 }, (_, i) => (
                  <SelectItem key={i} value={String(i)} className="text-xs">
                    db{i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              title="刷新"
              aria-label="刷新"
              onClick={() => {
                void load()
                setNonce((n) => n + 1)
              }}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        <Tabs value={mode} onValueChange={setMode} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-3 mt-2 h-8 w-fit shrink-0">
            <TabsTrigger value="data" className="h-6 px-2 text-xs">
              数据
            </TabsTrigger>
            <TabsTrigger value="info" className="h-6 px-2 text-xs">
              信息
            </TabsTrigger>
            <TabsTrigger value="cli" className="h-6 px-2 text-xs">
              命令行
            </TabsTrigger>
          </TabsList>
          <TabsContent value="data" className="mt-2 min-h-0 flex-1">
            <DataMode rpc={rpc} notify={notify} conn={conn} nonce={nonce} onChanged={() => setNonce((n) => n + 1)} />
          </TabsContent>
          <TabsContent value="info" className="mt-2 min-h-0 flex-1">
            <InfoMode rpc={rpc} conn={conn} nonce={nonce} />
          </TabsContent>
          <TabsContent value="cli" className="mt-2 min-h-0 flex-1">
            <CliMode rpc={rpc} conn={conn} onChanged={() => setNonce((n) => n + 1)} />
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 数据屏：左列表 + 右详情
  // -------------------------------------------------------------------------

  function DataMode({ rpc, notify, conn, nonce, onChanged }) {
    const [pattern, setPattern] = React.useState(conn.pattern || '*')
    const [keys, setKeys] = React.useState([])
    const [cursor, setCursor] = React.useState(0)
    const [done, setDone] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [opened, setOpened] = React.useState(null)
    /**
     * 跨页判重：`SCAN` 允许同一个元素被返回多次（它只保证「至少一次」）。
     * 不判重就会出现两条同 key 的项，React 列表直接报重复 key。
     */
    const seen = React.useRef(new Set())

    const scan = React.useCallback(
      async (reset) => {
        setBusy(true)
        setError('')
        try {
          const res = await rpc('keys.scan', {
            conn: conn.id,
            pattern,
            cursor: reset ? 0 : cursor
          })
          if (reset) seen.current = new Set()
          const fresh = []
          for (const item of res.keys || []) {
            if (seen.current.has(item.key)) continue
            seen.current.add(item.key)
            fresh.push(item)
          }
          setKeys((prev) => (reset ? fresh : prev.concat(fresh)))
          setCursor(res.cursor || 0)
          setDone(Boolean(res.done))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      },
      [rpc, conn.id, pattern, cursor]
    )

    // 首次进入 + 外部改动（命令行写入了）→ 重扫
    React.useEffect(() => {
      void scan(true)
      // eslint 不在插件目录生效；这里刻意只认这两个信号
    }, [conn.id, nonce])

    return (
      <div className="flex h-full min-h-0">
        <div className="flex w-64 shrink-0 flex-col border-r">
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
            <Input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // 换搜索条件 = 换一批 key：详情跟着关掉（不然会停在一个不在列表里的 key 上）
                  setOpened(null)
                  void scan(true)
                }
              }}
              placeholder="MATCH，如 user:*"
              className="h-7 text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              title="搜索"
              aria-label="搜索"
              disabled={busy}
              onClick={() => {
                setOpened(null)
                void scan(true)
              }}
            >
              <Search className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {error ? (
              <p className="p-2 text-xs text-red-500">{error}</p>
            ) : keys.length === 0 && !busy ? (
              <p className="p-2 text-xs text-muted-foreground">
                {done ? '没有匹配的 key。' : '点右上角的搜索开始。'}
              </p>
            ) : (
              <ul className="p-1">
                {keys.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      disabled={item.binary}
                      title={item.binary ? '二进制 key 名（无法按名访问）' : item.key}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs',
                        item.binary
                          ? 'cursor-not-allowed opacity-50'
                          : opened === item.key
                            ? 'bg-accent'
                            : 'hover:bg-accent/60'
                      )}
                      onClick={() => setOpened(item.key)}
                    >
                      <span className="truncate">{item.key}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {item.type}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {busy ? (
              <div className="flex items-center gap-1.5 p-2 text-[11px] text-muted-foreground">
                <Spinner className="size-3" />
                扫描中…
              </div>
            ) : keys.length > 0 && !done ? (
              <Button
                variant="ghost"
                size="sm"
                className="m-1 h-7 w-[calc(100%-0.5rem)] text-xs"
                onClick={() => void scan(false)}
              >
                继续加载（已 {keys.length} 条）
              </Button>
            ) : keys.length > 0 ? (
              <p className="p-2 text-[11px] text-muted-foreground">已扫完，共 {keys.length} 条。</p>
            ) : null}
          </ScrollArea>
        </div>

        {/*
          `key` 只认「连接 + key 名」：把 `nonce` 也放进去的话，每次保存都会重建组件、
          输入框丢草稿；`nonce` 通过 prop 传进去，让它自己重拉一次就够了。
        */}
        <div className="min-w-0 flex-1">
          {opened ? (
            <KeyDetail
              key={`${conn.id}:${opened}`}
              rpc={rpc}
              notify={notify}
              conn={conn}
              name={opened}
              nonce={nonce}
              onChanged={onChanged}
              onClosed={() => setOpened(null)}
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">左边点一个 key 看内容。</div>
          )}
        </div>
      </div>
    )
  }

  /** 新增条目时的表单字段（编辑时用服务端 `entry.get` 回的，那边才是真源） */
  function fieldsFor(kind) {
    if (kind === 'hash')
      return [
        { id: 'field', label: '字段' },
        { id: 'value', label: '值', multiline: true }
      ]
    if (kind === 'list') return [{ id: 'value', label: '元素值', multiline: true }]
    if (kind === 'set') return [{ id: 'member', label: '成员' }]
    if (kind === 'zset')
      return [
        { id: 'member', label: '成员' },
        { id: 'score', label: '分数' }
      ]
    return []
  }

  function EntryDialog({ open, title, fields, values, busy, error, onClose, onSubmit }) {
    const [form, setForm] = React.useState({})
    React.useEffect(() => {
      if (open) setForm({ ...values })
    }, [open, values])

    return (
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {fields.map((field) =>
              field.multiline ? (
                <Field key={field.id} label={field.label}>
                  <Textarea
                    value={form[field.id] || ''}
                    autoFocus
                    className="min-h-24 font-mono text-xs"
                    onChange={(event) => setForm((prev) => ({ ...prev, [field.id]: event.target.value }))}
                  />
                </Field>
              ) : (
                <Field key={field.id} label={field.label}>
                  <Input
                    value={form[field.id] || ''}
                    autoFocus={field.id === fields[0].id}
                    className="font-mono text-xs"
                    onChange={(event) => setForm((prev) => ({ ...prev, [field.id]: event.target.value }))}
                  />
                </Field>
              )
            )}
            {error ? <p className="text-xs text-red-500">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onSubmit(form)}>
              {busy ? <Spinner className="size-3.5" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  function KeyDetail({ rpc, notify, conn, name, nonce, onChanged, onClosed }) {
    const [detail, setDetail] = React.useState(null)
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [draft, setDraft] = React.useState('')
    const [entryDialog, setEntryDialog] = React.useState(null)
    const [renaming, setRenaming] = React.useState(false)
    const [newName, setNewName] = React.useState('')
    const [confirmDelete, setConfirmDelete] = React.useState(false)

    const load = React.useCallback(async () => {
      try {
        const res = await rpc('key.detail', { conn: conn.id, key: name })
        setDetail(res)
        setDraft(res.payload && res.payload.kind === 'string' ? res.payload.text : '')
        setError('')
      } catch (err) {
        setError(messageOf(err))
      }
    }, [rpc, conn.id, name])

    React.useEffect(() => {
      void load()
    }, [load, nonce])

    /** 改完统一走这里：重新拉详情 + 通知父层「列表也该刷新了」 */
    async function run(action, okText) {
      setBusy(true)
      try {
        await action()
        await load()
        onChanged()
        if (okText) notify.success(okText)
        return true
      } catch (err) {
        notify.error(messageOf(err))
        return false
      } finally {
        setBusy(false)
      }
    }

    if (error) {
      return (
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-xs text-red-500">{error}</p>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void load()}>
              重试
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClosed}>
              返回列表
            </Button>
          </div>
        </div>
      )
    }
    if (!detail) {
      return (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          读取中…
        </div>
      )
    }

    const payload = detail.payload || { kind: 'other' }
    const entries = payload.entries || []
    const editable = Boolean(payload.editable)

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
              {name}
            </span>
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
              {detail.type}
            </Badge>
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              TTL {ttlLabel(detail.ttl)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              disabled={busy}
              onClick={() => {
                setNewName(name)
                setRenaming(true)
              }}
            >
              重命名
            </Button>
            {[3600, 86400].map((seconds) => (
              <Button
                key={seconds}
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={busy}
                onClick={() =>
                  run(
                    () => rpc('key.expire', { conn: conn.id, key: name, ttl: seconds }),
                    `过期设为 ${ttlLabel(seconds)}`
                  )
                }
              >
                {seconds === 3600 ? '1 小时' : '1 天'}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              disabled={busy}
              onClick={() =>
                run(() => rpc('key.expire', { conn: conn.id, key: name, ttl: 0 }), '已设为永久')
              }
            >
              永久
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-red-500"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {payload.kind === 'string' ? (
            <div className="flex h-full flex-col gap-2">
              <Textarea
                value={draft}
                readOnly={!editable}
                className="min-h-32 flex-1 font-mono text-xs"
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {payload.bytes} 字节{payload.binary ? '（二进制，只读）' : ''}
                </span>
                {editable ? (
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy || draft === payload.text}
                    onClick={() =>
                      run(() => rpc('key.set', { conn: conn.id, key: name, value: draft }), '已保存')
                    }
                  >
                    保存
                  </Button>
                ) : null}
              </div>
            </div>
          ) : payload.kind === 'other' ? (
            <p className="text-xs text-muted-foreground">这个类型的值不支持预览。</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {payload.total} 条
                  {payload.total > entries.length ? `，只显示前 ${entries.length} 条` : ''}
                </span>
                {editable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={busy}
                    onClick={() =>
                      setEntryDialog({
                        mode: 'add',
                        title: '新增条目',
                        fields: fieldsFor(payload.kind),
                        values: {}
                      })
                    }
                  >
                    <Plus className="size-3.5" />
                    新增
                  </Button>
                ) : null}
              </div>
              <ul className="flex flex-col gap-1">
                {entries.map((item) => (
                  <li
                    key={item.id}
                    className="group flex items-start gap-2 rounded border px-2 py-1.5 hover:bg-accent/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs" title={item.label}>
                        {item.label}
                      </div>
                      {item.detail !== undefined ? (
                        <div className="truncate font-mono text-[11px] text-muted-foreground" title={item.detail}>
                          {item.detail}
                        </div>
                      ) : null}
                    </div>
                    {editable ? (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={busy}
                          onClick={async () => {
                            try {
                              const res = await rpc('entry.get', {
                                conn: conn.id,
                                type: payload.kind,
                                key: name,
                                entry: item.id
                              })
                              setEntryDialog({
                                mode: 'edit',
                                title: '修改条目',
                                fields: res.fields || fieldsFor(payload.kind),
                                values: res.values || {},
                                entry: item.id
                              })
                            } catch (err) {
                              notify.error(messageOf(err))
                            }
                          }}
                        >
                          修改
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="删除"
                          aria-label="删除"
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              rpc('entry.remove', {
                                conn: conn.id,
                                type: payload.kind,
                                key: name,
                                entry: item.id
                              })
                            )
                          }
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <EntryDialog
          open={Boolean(entryDialog)}
          title={entryDialog ? entryDialog.title : ''}
          fields={entryDialog ? entryDialog.fields : []}
          values={entryDialog ? entryDialog.values : {}}
          busy={busy}
          onClose={() => setEntryDialog(null)}
          onSubmit={async (form) => {
            const current = entryDialog
            if (!current) return
            const ok = await run(() =>
              rpc(current.mode === 'add' ? 'entry.add' : 'entry.save', {
                conn: conn.id,
                type: payload.kind,
                key: name,
                ...(current.entry !== undefined ? { entry: current.entry } : {}),
                args: form
              })
            )
            if (ok) setEntryDialog(null)
          }}
        />

        {/* 重命名：不做行内编辑（key 名很长，行内一改整行就跳） */}
        <Dialog open={renaming} onOpenChange={(next) => (next ? undefined : setRenaming(false))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>重命名</DialogTitle>
            </DialogHeader>
            <Field label="新名字" hint="目标已存在时 Redis 会直接报错，不会覆盖">
              <Input
                value={newName}
                autoFocus
                className="font-mono text-xs"
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={busy || !newName.trim() || newName === name}
                onClick={async () => {
                  const ok = await run(
                    () => rpc('key.rename', { conn: conn.id, key: name, to: newName.trim() }),
                    '已重命名'
                  )
                  if (ok) {
                    setRenaming(false)
                    onClosed()
                  }
                }}
              >
                确定
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={confirmDelete} onOpenChange={(next) => (next ? undefined : setConfirmDelete(false))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除这个 key？</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{name}</span> 会连同内容一起删掉，取消就什么都没有发生。
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  const ok = await run(
                    () => rpc('key.remove', { conn: conn.id, key: name }),
                    '已删除'
                  )
                  if (ok) {
                    setConfirmDelete(false)
                    onClosed()
                  }
                }}
              >
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 信息屏
  // -------------------------------------------------------------------------

  function formatUptime(seconds) {
    const total = Number(seconds)
    if (!Number.isFinite(total) || total <= 0) return String(seconds || '-')
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    if (days > 0) return `${days} 天 ${hours} 小时`
    const minutes = Math.floor((total % 3600) / 60)
    return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
  }

  function formatBytes(value) {
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes <= 0) return String(value || '-')
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
  }

  function InfoMode({ rpc, conn, nonce }) {
    const [data, setData] = React.useState(null)
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [filter, setFilter] = React.useState('')
    const [raw, setRaw] = React.useState(false)

    const load = React.useCallback(async () => {
      setBusy(true)
      try {
        const res = await rpc('info', { conn: conn.id })
        setData(res)
        setError('')
      } catch (err) {
        setError(messageOf(err))
      } finally {
        setBusy(false)
      }
    }, [rpc, conn.id])

    React.useEffect(() => {
      void load()
    }, [load, nonce])

    if (error) {
      return (
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="text-xs text-red-500">{error}</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )
    }
    if (!data) {
      return (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          读取 INFO…
        </div>
      )
    }

    const overview = data.overview || {}
    const needle = filter.trim().toLowerCase()
    const sections = (data.sections || [])
      .map((section) => ({
        ...section,
        rows: (section.rows || []).filter(
          ([key, value]) =>
            !needle ||
            String(key).toLowerCase().includes(needle) ||
            String(value).toLowerCase().includes(needle) ||
            String(section.name).toLowerCase().includes(needle)
        )
      }))
      .filter((section) => section.rows.length > 0 || (!needle && section.name))
    const rawText = needle
      ? String(data.raw || '')
          .split('\n')
          .filter((line) => line.toLowerCase().includes(needle))
          .join('\n')
      : String(data.raw || '')

    const cards = [
      ['版本', overview.version],
      ['运行时长', formatUptime(overview.uptime)],
      ['当前键数', data.dbsize],
      ['连接数', overview.clients],
      ['内存', formatBytes(overview.memory)],
      ['命中率', overview.hitRate === null ? '-' : `${overview.hitRate}%`],
      ['已执行命令', overview.commands]
    ]

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤（字段名 / 值）"
            className="h-7 text-xs"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Label htmlFor="redis-info-raw" className="text-xs text-muted-foreground">
              原始
            </Label>
            <Switch id="redis-info-raw" checked={raw} onCheckedChange={setRaw} />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新"
            aria-label="刷新"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {raw ? (
            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed">
              {rawText}
            </pre>
          ) : (
            <div className="flex flex-col gap-4 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {cards.map(([label, value]) => (
                  <div key={label} className="rounded border px-2 py-1.5">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="truncate text-xs font-medium" title={String(value)}>
                      {String(value)}
                    </div>
                  </div>
                ))}
              </div>
              {sections.map((section) => (
                <div key={section.name} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium uppercase text-muted-foreground">
                      {section.name}
                    </span>
                    <Separator className="flex-1" />
                  </div>
                  <ul className="flex flex-col">
                    {section.rows.map(([key, value]) => (
                      <li key={key} className="flex gap-2 py-0.5 text-[11px]">
                        <span className="w-48 shrink-0 truncate font-mono text-muted-foreground" title={key}>
                          {key}
                        </span>
                        <span className="min-w-0 flex-1 break-all font-mono" title={value}>
                          {value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {sections.length === 0 ? (
                <p className="text-xs text-muted-foreground">没有匹配「{filter}」的字段。</p>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 命令行
  // -------------------------------------------------------------------------

  function CliMode({ rpc, conn, onChanged }) {
    const [log, setLog] = React.useState([])
    const [line, setLine] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    /** 上一条命令（↑ 回填）：命令行没有这个就不像命令行 */
    const history = React.useRef([])
    const [historyAt, setHistoryAt] = React.useState(-1)

    async function run() {
      const text = line.trim()
      if (!text || busy) return
      setBusy(true)
      try {
        const res = await rpc('command', { conn: conn.id, line: text })
        setLog((prev) => [{ ok: res.ok, text: res.text }, ...prev].slice(0, 50))
        history.current = [text, ...history.current].slice(0, 50)
        setHistoryAt(-1)
        setLine('')
        // 写命令之后列表已经变了：让数据屏重拉（这里不自己改别人的 state）
        if (res.wrote) onChanged()
      } catch (err) {
        setLog((prev) => [{ ok: false, text: `$ ${text}\n(error) ${messageOf(err)}` }, ...prev].slice(0, 50))
      } finally {
        setBusy(false)
      }
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-1">
          <span className="text-[11px] text-muted-foreground">
            {log.length ? `${log.length} 条输出（最新在上）` : '直接敲 Redis 命令，如 GET foo'}
          </span>
          {log.length ? (
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => setLog([])}>
              清空
            </Button>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1.5 p-3">
            {log.map((item, index) => (
              <pre
                key={`${index}-${item.text.slice(0, 16)}`}
                className={cn(
                  'whitespace-pre-wrap break-all rounded border px-2 py-1 font-mono text-[11px]',
                  item.ok ? '' : 'border-red-500/40 text-red-500'
                )}
              >
                {item.text}
              </pre>
            ))}
            {log.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                输出只留最近 50 条；写命令（SET / DEL / HSET…）会自动刷新左边的 key 列表。
              </p>
            ) : null}
          </div>
        </ScrollArea>

        <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">&gt;</span>
          <Input
            value={line}
            disabled={busy}
            className="h-7 flex-1 font-mono text-xs"
            placeholder="GET foo"
            onChange={(event) => setLine(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run()
              // ↑ 往回翻历史：翻到头就停在第一条，别绕圈（绕圈会让人以为丢命令了）
              if (event.key === 'ArrowUp' && history.current.length) {
                event.preventDefault()
                const next = Math.min(historyAt + 1, history.current.length - 1)
                setHistoryAt(next)
                setLine(history.current[next])
              }
              if (event.key === 'ArrowDown' && historyAt >= 0) {
                event.preventDefault()
                const next = historyAt - 1
                setHistoryAt(next)
                setLine(next < 0 ? '' : history.current[next])
              }
            }}
          />
          <Button size="sm" className="h-7 text-xs" disabled={busy || !line.trim()} onClick={() => void run()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            执行
          </Button>
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // 注册：按 surfaceId 认领（清单里声明了 connections / key 两个面）
  //   connections = 连接列表（点插件后默认打开的那一面）
  //   key         = 某个连接的 Key 浏览（点连接后由 openView 开出来）
  // -------------------------------------------------------------------------

  return {
    render(surfaceId, ctx) {
      if (surfaceId === 'connections') return React.createElement(ConnectionsView, ctx)
      if (surfaceId === 'key') return React.createElement(Pane, ctx)
      return React.createElement(
        'div',
        { className: 'p-3 text-xs text-muted-foreground' },
        `这个面还没实现：${surfaceId}`
      )
    }
  }
})
