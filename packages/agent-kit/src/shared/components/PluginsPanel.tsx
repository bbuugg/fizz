/**
 * 插件管理面板（列表 / 启停 / 声明预览 / 刷新 / 目录入口）——**按作用域参数化**。
 *
 * 放在 `shared/` 是因为它同时被两个功能区用（`features/settings` 的设置页与
 * `features/projects` 的项目弹窗），按本仓库的分层约定就不该落在任一 feature 目录下。
 *
 * ## 两个作用域是**两份数据**，不是一份数据的两种视图
 *
 * - `global`（设置 →「插件」）：用户级插件 `~/.fizz/plugins`，启停存服务端全局一份；
 * - `workspace`（侧栏项目「更多」→「插件」）：项目插件 `<项目>/.fizz/plugins`，启停按项目存。
 *
 * 用户级插件对所有项目生效，所以它的开关就该是全局的 —— 因此**一个项目无法单独停用某个
 * 用户级插件**，项目面里也不会列出它（列出来既点不动、又容易让人以为「在这里关掉就全局关了」）。
 * 服务端 `GET /api/plugins?scope=global` 与 `?workspaceId=` 各自只回自己那一半。
 *
 * 插件的生效时机**按能力分**（面板里有说明，别写混）：
 * - 工具 / 提示词 / 钩子挂在 turn context 上 → **下一轮对话**；
 * - 上传源（`ctx.uploads`）挂在长驻 context 上 → 回到输入框重开附件菜单即可选到。
 *
 * 插件的**设置项**（`ctx.ui.setting`）在卡片上的「配置」按钮打开的**弹窗**里编辑：值存在服务端
 * （密钥项加密，且只回 `hasValue`），保存后立刻生效（挂载缓存指纹里含设置值）。
 *
 * 为什么设置是弹窗、列表是栅格：插件多起来之后（尤其像 OSS 那样十项设置的），内联表单会把一列
 * 列表撑成一条条长表单 —— 既难扫读、也没法并排。列表只留「一眼看全」的信息（图标 / 名字 /
 * 路径 / 提供了什么能力），要编辑才开弹窗。列数按**面板自己的宽度**算（容器查询），见列表那段注释。
 *
 * 数据按作用域**现拉**，不进全局 store：清单本就跟着「管哪个项目 / 全局」走。
 */
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import {
  Copy,
  Folder,
  FolderOpen,
  Package,
  Puzzle,
  RotateCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Textarea } from '@fizz/ui/textarea'
import { Switch } from '@fizz/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { refreshPluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { fileToBase64, type PluginsResponse } from '@fizz/agent-client/api'
import type { PluginSettingView } from '@fizz/plugin'

export type PluginScope = 'global' | 'workspace'

/** 每个作用域的一撮文案：来源标签 + 生效范围 + 空态 */
const SCOPE_COPY: Record<
  PluginScope,
  { title: string; hint: string; intro: string; empty: string }
> = {
  global: {
    title: '插件',
    hint: '内置 + 用户级，所有项目共用',
    intro:
      '插件',
    empty:
      '暂无插件'
  },
  workspace: {
    title: '项目插件',
    hint: '只在这个项目里生效',
    intro:
      '这里只列这个项目自己的插件',
    empty:
      '暂无插件'
  }
}

/** 来源标签：内置随产品分发，用户级在自己家里，项目级跟着项目走 */
const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  user: '用户级',
  workspace: '项目'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 设置项的「已提交值」：已存的 > 声明里的 default > 类型的空值 */
function committedValue(item: PluginSettingView): string | number | boolean {
  if (item.type === 'boolean') return Boolean(item.value ?? item.default ?? false)
  if (item.value !== undefined) return item.value
  if (item.default !== undefined) return item.type === 'number' ? Number(item.default) : String(item.default)
  return ''
}

/**
 * 插件设置项的表单**本体**（渲染在「配置」弹窗里；以前是内联在列表卡片里的）。
 *
 * 交互取舍：
 * - 开关 / 下拉**即时保存**（一次交互就是一个值，没有「改了一半」的状态）；
 * - 文本 / 数字走**失焦保存**（边打字边发请求太吵），`Enter` 也当失焦；
 * - 密钥项：输入框**从空开始**（明文不在浏览器手里），留空 = 不改，已设置时给一个「清除」；
 * - 保存失败**回滚草稿**并 toast 原话 —— 免得界面上显示的值和盘上的不一致。
 *
 * ## 手机上是**上下两行**，不是左右两列
 *
 * 输入框在桌面端是定宽（`w-52` = 208px）、标签占剩余宽度；手机弹窗去掉内边距后只剩 260px 上下，
 * 一左一右摆下来标签被压成几十像素宽，标题和说明各自折成好几行 —— 用户反馈的「挤压变形」就是它。
 * 所以窄屏一律 `flex-col`：标签一行、控件整行铺满（`w-full sm:w-52`），
 * 到 `sm`（≥640px，弹窗已是 40rem 宽）才恢复左右布局。**别把 `w-52` 写回无条件的类**。
 */
function PluginSettingsForm({
  settings,
  onSave
}: {
  settings: PluginSettingView[]
  onSave: (patch: Record<string, string | number | boolean | null>) => Promise<void>
}) {
  const tr = useT()
  return (
    <div className="min-w-0 space-y-3">
      {settings.map((item) => (
        <PluginSettingRow key={item.id} item={item} onSave={onSave} />
      ))}
    </div>
  )
}

function PluginSettingRow({
  item,
  onSave
}: {
  item: PluginSettingView
  onSave: (patch: Record<string, string | number | boolean | null>) => Promise<void>
}) {
  const tr = useT()
  const committed = committedValue(item)
  const [busy, setBusy] = useState(false)
  /** 文本 / 数字的草稿；密钥项恒从空开始（见表单说明） */
  const [draft, setDraft] = useState(() => (item.secret ? '' : String(committed)))

  /** 返回是否保存成功（密钥项成功后要把草稿清空） */
  const push = async (
    patch: Record<string, string | number | boolean | null>,
    revert?: () => void
  ): Promise<boolean> => {
    setBusy(true)
    try {
      await onSave(patch)
      return true
    } catch (err) {
      revert?.()
      toast.error(tr('{name}：{error}', { name: item.title, error: messageOf(err) }))
      return false
    } finally {
      setBusy(false)
    }
  }

  const label = (
    <div className="min-w-0 flex-1">
      <div className="text-[0.6875rem] leading-4 break-words text-foreground/80">{item.title}</div>
      {/*
        `break-words` 是这里**必须有**的一行：插件的说明里常带长 URL / 长键名（如 OSS 的
        `https://s3.oss-cn-hangzhou.aliyuncs.com`），它们是「不可断行」的 token。标签盒虽然
        `min-w-0` 能缩，但文字本身缩不下去，就会溢出盒子，再被最近的可滚动祖先接住 ——
        表现就是配置弹窗里冒出一条横向滚动条（用户实测反馈过）。
      */}
      {item.description && (
        <div className="text-[0.625rem] leading-4 break-words text-muted-foreground">
          {item.description}
        </div>
      )}
    </div>
  )

  if (item.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        {label}
        <Switch
          checked={Boolean(committed)}
          disabled={busy}
          aria-label={item.title}
          onCheckedChange={(next) => void push({ [item.id]: next })}
        />
      </div>
    )
  }

  if (item.type === 'select') {
    const current = String(committed ?? '')
    return (
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        {label}
        <Select
          value={current || undefined}
          disabled={busy}
          onValueChange={(next) => void push({ [item.id]: next })}
        >
          <SelectTrigger className="h-7 w-full shrink-0 text-xs sm:w-40" aria-label={item.title}>
            <SelectValue placeholder={tr('未设置')} />
          </SelectTrigger>
          <SelectContent>
            {(item.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  /** 失焦提交：没改就不发请求；数字清空 = 清掉这一项 */
  const commit = (): void => {
    if (item.secret) {
      if (draft === '') return // 留空 = 不改（明文不在手里，没法回传）
      void push({ [item.id]: draft }, () => setDraft('')).then((ok) => {
        if (ok) setDraft('')
      })
      return
    }
    if (item.type === 'number') {
      const trimmed = draft.trim()
      if (trimmed === '') {
        if (String(committed) === '') return
        void push({ [item.id]: null }, () => setDraft(''))
        return
      }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        toast.error(tr('{name}：要填一个数字', { name: item.title }))
        setDraft(String(committed))
        return
      }
      if (parsed === committed) return
      void push({ [item.id]: parsed }, () => setDraft(String(committed)))
      return
    }
    if (draft === String(committed)) return
    void push({ [item.id]: draft }, () => setDraft(String(committed)))
  }

  if (item.multiline) {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Textarea
          value={draft}
          disabled={busy}
          aria-label={item.title}
          placeholder={item.placeholder ?? ''}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className="min-h-24 w-full resize-y text-xs"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2">
      {label}
      <div className="flex w-full shrink-0 items-center gap-1 sm:w-auto">
        <Input
          type={item.secret ? 'password' : item.type === 'number' ? 'number' : 'text'}
          value={draft}
          disabled={busy}
          aria-label={item.title}
          autoComplete={item.secret ? 'new-password' : 'off'}
          data-lpignore="true"
          data-1p-ignore="true"
          placeholder={
            item.secret
              ? item.hasValue
                ? tr('已设置（留空不改）')
                : tr('未设置')
              : (item.placeholder ?? '')
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter 等同失焦（不然得先点别处才保存，很别扭）
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-7 w-full text-xs sm:w-52"
        />
        {item.secret && item.hasValue && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-[0.625rem]"
            disabled={busy}
            title={tr('清掉已保存的值')}
            onClick={() => void push({ [item.id]: null }, () => setDraft(''))}
          >
            {tr('清除')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function PluginsPanel({
  app,
  scope,
  workspaceId,
  className
}: {
  app: AgentApp
  scope: PluginScope
  /** `scope === 'workspace'` 必填：管哪个项目（服务端按它扫目录、存启停） */
  workspaceId?: string | null
  className?: string
}) {
  const tr = useT()
  const [data, setData] = useState<PluginsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * 正在保存的那几项（启停 / 卸载）。
   *
   * 同一项连点会算出两份互相覆盖的清单，直接挡掉；**不同项可以连着点，但要串行落地**
   * （见 `saveChainRef`）—— 每笔写回的都是整份停用清单，并发时谁后落地谁赢，
   * 前一笔的改动会被后一笔带着的旧清单整条抹掉。用户看到的就是「点了好几次才停用」。
   */
  const [busyIds, setBusyIds] = useState<string[]>([])
  /** 搜索词（纯前端过滤：名字 / 路径 / 来源） */
  const [keyword, setKeyword] = useState('')
  /** 正在编辑设置项的那个插件 id（null = 弹窗关着） */
  const [configPluginId, setConfigPluginId] = useState<string | null>(null)
  /** 正在安装（读文件 + 发过去 + 服务端体检期间） */
  const [installing, setInstalling] = useState(false)
  /** 正在装插件根里声明过的 npm 依赖（pnpm 可能跑几十秒） */
  const [syncingDeps, setSyncingDeps] = useState(false)
  /** 待确认卸载的插件 id —— 卸载是**删磁盘上的文件**，所以两步：先点一次出确认 */
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null)
  /** 选本地文件的隐藏 input（常挂树上、靠 ref 触发：每次新建 input 在 Safari 上会掉权限） */
  const installInputRef = useRef<HTMLInputElement | null>(null)
  /** 代次防护：作用域 / 项目切换时旧响应可能后到，直接丢弃（脏展示很难查） */
  const loadGenRef = useRef(0)
  /**
   * 最新一份清单。
   *
   * 异步流程里读 `data` 读到的是**那次渲染的闭包快照**：连着点两个开关时，第二下若还按
   * 旧清单算 `next`，第一下的改动就被覆盖了。所有写入都走 `applyData`，这里始终是当下的值。
   */
  const dataRef = useRef<PluginsResponse | null>(null)
  /** 启停保存的串行链（见 `busyIds` 的说明） */
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())

  const targetId = scope === 'workspace' ? (workspaceId ?? null) : null
  /** 拉不了就没有可管理的东西（项目弹窗传了空 id / 没连接） */
  const ready = scope === 'global' || !!targetId
  const copy = SCOPE_COPY[scope]

  /*
   * 依赖里只能出现 `api`（连接级缓存的稳定引用），**不能出现整个 `app`**。
   *
   * 整店订阅下 `app` 是 `agentAppFrom()` 每帧现造的对象字面量：对话流式输出时每个 token /
   * 工具事件都换一次引用 → `fetchList` 换 → `load` 换 → 下面那个 `useEffect` 再来一遍。
   * 表现为「对话进行中设置页的插件列表在不停重扫」（每次 GET 服务端都真的扫磁盘），
   * 用户报过。同一个坑在 `shared/lib/plugin-surfaces.ts` 的 `usePluginSurfaces` 里
   * 也是按 `app.api` 收的，别改回去。
   */
  const api = app.api

  /** 改清单，并同步 `dataRef`（异步流程要读**刚写的**那一份，不是渲染快照） */
  const applyData = useCallback((next: PluginsResponse | null): void => {
    dataRef.current = next
    setData(next)
  }, [])

  /** 标记 / 取消某一项的「保存中」 */
  const markBusy = useCallback((id: string, on: boolean): void => {
    setBusyIds((prev) =>
      on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)
    )
  }, [])

  /**
   * 重拉**界面清单**（图标栏 / 侧栏 / 标签条那一份是前端模块级缓存，见
   * `shared/lib/plugin-surfaces.ts`）。
   *
   * - 不重拉的话：启停之后图标栏纹丝不动，要等某个 `usePluginSurfaces` 的宿主重新挂载
   *   （比如点一下那颗图标）才刷新 —— 用户实测就是「改了没反应，点它才消失」；
   * - 必须用**活动项目**（`app.activeWorkspaceId`）而不是正在管的作用域：那份缓存就是按
   *   活动项目取用的，全局作用域传 `targetId` 会掉成 `null`（= 只扫内置 + 用户级），
   *   活动项目自己的插件图标会集体从活动栏消失，直到切项目才回来。
   */
  const refreshSurfaces = (): void => {
    refreshPluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  }

  const fetchList = useCallback((): Promise<PluginsResponse> => {
    if (!api) return Promise.reject(new Error(tr('还没有连接到服务端')))
    if (scope === 'global') return api.listGlobalPlugins()
    if (!targetId) return Promise.reject(new Error(tr('还没选择项目')))
    return api.listPlugins(targetId)
  }, [api, scope, targetId])

  const load = useCallback(async (): Promise<void> => {
    if (!ready) return
    const gen = ++loadGenRef.current
    setLoading(true)
    try {
      const next = await fetchList()
      if (gen === loadGenRef.current) applyData(next)
    } catch (err) {
      if (gen === loadGenRef.current) toast.error(tr('读取插件失败：{error}', { error: messageOf(err) }))
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [ready, fetchList, applyData])

  // 只在**作用域 / 目标项目**变化时清空（`load` 的依赖已经收敛到 `api` + 这两项，不会
  // 被对话推送带着重跑；清空自然也只该跟它们走）。
  useEffect(() => {
    applyData(null)
  }, [applyData, scope, targetId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 启停。
   *
   * 三件必须一起做（少任何一件都会变成「点了没反应 / 点好几次才生效」）：
   * 1. **先翻本地开关**：服务端回来前 `checked` 还停在旧值，开关不动用户就会再点一次；
   * 2. **串行落地**：`disabled` 是完整清单，两笔并发谁后到谁赢，先点的那笔会被抹掉；
   * 3. **重拉界面清单**：图标栏是前端缓存，不重拉的话停用后那颗图标还在（见 `refreshSurfaces`）。
   */
  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    const current = dataRef.current
    if (!api || !current || !ready) return
    if (busyIds.includes(id)) return
    // disabled 是完整清单：读当前 → 加/减一个 → 全量写回（与技能页同款）
    const disabled = current.settings.disabled
    const next = enabled ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])]
    const gen = loadGenRef.current
    markBusy(id, true)
    applyData({ ...current, settings: { ...current.settings, disabled: next } })
    const run = saveChainRef.current.then(() =>
      scope === 'global'
        ? api.saveGlobalPlugins(next)
        : api.savePlugins(targetId as string, next)
    )
    // 链上失败不能把后面几笔一起带走：吞掉错误，只让这一次的调用方看到
    saveChainRef.current = run.catch(() => undefined)
    try {
      const result = await run
      // 保存期间若用户切了作用域 / 项目，这次结果就不该落到当前视图上
      if (gen === loadGenRef.current) {
        applyData(result)
        refreshSurfaces()
      }
    } catch (err) {
      toast.error(tr('保存失败：{error}', { error: messageOf(err) }))
      // 乐观改过的本地值不能留着：按服务端那份重新对齐
      if (gen === loadGenRef.current) void load()
    } finally {
      markBusy(id, false)
    }
  }

  /**
   * **安装**：把用户选中的整个目录发给服务端，由它写进这个作用域的插件目录。
   *
   * 目录里必须有 `plugin.json`（接口见 `@fizz/plugin` 的 `PluginManifest`）。路径去掉
   * 最外层目录名（`my-plugin/index.ts` → `index.ts`），服务端用 manifest.id 当安装目录名。
   *
   * 服务端返回的就是重扫后的完整清单，所以这里直接 `applyData` —— 不必再拉一次。
   * 另外**强制重拉界面清单**（`refreshSurfaces`）：图标栏 / 侧栏那一份是前端缓存的，
   * 不重拉的话新插件的图标要等下次进设置才出现。
   */
  const install = async (picked: FileList): Promise<void> => {
    if (!api || !ready) return
    const files: File[] = []
    for (const file of Array.from(picked)) {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/')
      const segments = rel.split('/')
      // 跳过隐藏文件 / node_modules：它们不是插件源码，传上去只会拖慢安装
      if (segments.some((part) => part.startsWith('.') || part === 'node_modules')) continue
      files.push(file)
    }
    if (!files.length) {
      toast.error(tr('这个目录里没有可安装的文件'))
      return
    }
    const rootName = (files[0].webkitRelativePath || '').split('/')[0] || tr('插件')
    const gen = loadGenRef.current
    setInstalling(true)
    try {
      const payload = await Promise.all(
        files.map(async (file) => {
          const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/')
          const segments = rel.split('/')
          // 有 webkitRelativePath 时去掉最外层目录名；单选文件（无相对路径）用文件名
          const path = file.webkitRelativePath ? segments.slice(1).join('/') : file.name
          return { path, content: await fileToBase64(file) }
        })
      )
      const result = await api.installPlugin({
        scope,
        ...(targetId ? { workspaceId: targetId } : {}),
        files: payload
      })
      if (gen !== loadGenRef.current) return
      applyData(result)
      refreshSurfaces()
      toast.success(tr('已安装「{name}」', { name: rootName }))
    } catch (err) {
      // 服务端会把「坏插件已撤回」的原因原样带回来，直接给用户看
      toast.error(tr('安装失败：{error}', { error: messageOf(err) }))
    } finally {
      setInstalling(false)
    }
  }

  /**
   * **卸载**：删掉插件整个目录。服务端顺带清掉它的设置值与启停名单里的残留
   * （不清的话同一个插件装回来会接着上一次的状态）。
   */
  const uninstall = async (id: string, name: string): Promise<void> => {
    if (!api || !ready) return
    const gen = loadGenRef.current
    markBusy(id, true)
    try {
      const result = await api.uninstallPlugin({
        scope,
        ...(targetId ? { workspaceId: targetId } : {}),
        pluginId: id
      })
      if (gen !== loadGenRef.current) return
      applyData(result)
      refreshSurfaces()
      setPendingUninstall(null)
      // 它的设置弹窗可能还开着：关掉，免得对着一个已删除的插件编辑
      if (configPluginId === id) setConfigPluginId(null)
      toast.success(tr('已卸载「{name}」', { name }))
    } catch (err) {
      toast.error(tr('卸载失败：{error}', { error: messageOf(err) }))
    } finally {
      markBusy(id, false)
    }
  }

  /**
   * **安装依赖**：把这一作用域里所有插件的 `dependencies` 合成一份，交给 pnpm 装进插件根。
   *
   * 只在「有插件声明了 dependencies」时才出现那颗按钮（见 `hasDeps`）—— 绝大多数人
   * 不写依赖，常驻一颗永远不会有反应的按钮只会让面板变糊。
   *
   * 它服务的是**手工拷进目录**的插件：走「安装插件」的那条路服务端已经自动装过了。
   */
  const syncDeps = async (): Promise<void> => {
    if (!api || !ready) return
    setSyncingDeps(true)
    try {
      const result = await api.syncPluginDeps({
        scope,
        ...(targetId ? { workspaceId: targetId } : {})
      })
      if (!result.changed) {
        toast.info(tr('这个作用域里没有插件声明 npm 依赖，什么都没做'))
      } else {
        toast.success(tr('插件依赖已安装（{root}）', { root: result.root }))
      }
      for (const warning of result.warnings) toast.warning(warning)
    } catch (err) {
      // pnpm 的原话最有信息量（没装 / 版本冲突 / 网络不通），原样给用户
      toast.error(tr('依赖安装失败：{error}', { error: messageOf(err) }))
    } finally {
      setSyncingDeps(false)
    }
  }

  /**
   * 保存某个插件的设置项，成功后**重拉清单** —— 值 / `hasValue` 都要跟着刷新
   * （失败时抛给表单那一层：它负责回滚草稿 + toast 原话）。
   */
  const saveSettings = async (
    pluginId: string,
    patch: Record<string, string | number | boolean | null>
  ): Promise<void> => {
    if (!api) throw new Error(tr('未连接服务端'))
    await api.savePluginConfig(pluginId, patch, targetId ?? undefined)
    await load()
  }

  const copyText = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(tr('已复制{what}', { what }))
    } catch {
      toast.error(tr('复制失败：剪贴板不可用（可手动选中路径复制）'))
    }
  }

  /** 用系统默认程序打开插件的存放目录（只有 desktop 宿主有本机文件系统） */
  const openDir = async (dir: string): Promise<void> => {
    const host = getAgentHostOrNull()
    if (!host?.openPath) {
      toast.error(tr('浏览器里打不开本机路径：{dir}', { dir }))
      return
    }
    const result = await host.openPath(dir)
    if (!result.ok) toast.error(tr('打开目录失败：{error}', { error: result.error ?? dir }))
  }

  const plugins = data?.plugins ?? []
  const errors = data?.errors ?? []
  const disabled = data?.settings.disabled ?? []
  const kw = keyword.trim().toLowerCase()
  /** 名字 / 路径 / 来源都能命中：装多了以后多半记得的是其中之一 */
  const shown = kw
    ? plugins.filter((p) => [p.name, p.file, p.source].some((v) => v.toLowerCase().includes(kw)))
    : plugins
  /**
   * 清单里超过一种来源才逐条标来源：全局那一面是「内置 + 用户级」，混在一起不标就分不清
   * 哪些是随应用来的、哪些是自己放的；只有一种来源时标它纯属噪音。
   */
  const mixedSources = new Set(plugins.map((p) => p.source)).size > 1
  /**
   * 有没有插件声明了 npm 依赖 —— 「安装依赖」那颗按钮只在有依赖时出现。
   * 依赖是**按插件根**合成一份的（不是每插件一份），所以这是作用域级而不是卡片级操作。
   */
  const hasDeps = plugins.some((p) => Object.keys(p.manifest.dependencies ?? {}).length > 0)
  /**
   * 弹窗里的那个插件：**按 id 现查**，而不是开弹窗时存一份快照 —— 保存设置后会 `load()` 重拉
   * 清单，现查才能让「已设置 / 未设置」这类状态立刻反映到表单上；插件从清单里消失（被删 /
   * 改名）时它自然变成 null，弹窗跟着关掉。
   */
  const configPlugin = plugins.find((p) => p.id === configPluginId) ?? null
  const configSettings = configPlugin ? (data?.ui[configPlugin.id]?.settings ?? []) : []
  const configIcon = configPlugin ? data?.ui[configPlugin.id]?.icon : undefined

  return (
    /* `@container`：下面插件列表的列数按**这个面板自己的宽度**算，不看视口（理由见列表那段） */
    <div className={cn('@container space-y-3', className)}>
      {/* 窄屏（手机）**上下排**：说明文字占满一行、按钮组落到下一行右对齐。
          左右并排时那段说明只剩 ~90px 宽，每行挤两三个字，整段被拉成一长条 —— 就是「挤压变形」的观感。 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <p className="text-xs leading-4 text-muted-foreground">{tr(copy.intro)}</p>
        <div className="flex shrink-0 items-center gap-1.5 max-sm:justify-end">
          {/* 选本地插件目录：隐藏 input 常挂树上、靠 ref 触发（每次新建 input 在 Safari
              上会掉权限，见 FilesPanel 那处的同款注释）。`webkitdirectory` 让浏览器
              只允许选目录，`multiple` 保证整个目录的文件都进 FileList。 */}
          <input
            ref={installInputRef}
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>)}
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files
              // 清空 value：同一个目录连选两次也要再触发一次 change
              e.target.value = ''
              if (picked?.length) void install(picked)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={loading || !ready || installing}
            title={scope === 'global' ? tr('从本地选一个插件目录（含 plugin.json）装进用户级的插件目录') : tr('从本地选一个插件目录（含 plugin.json）装进这个项目的插件目录')}
            onClick={() => installInputRef.current?.click()}
          >
            <Upload className={cn('size-3', installing && 'animate-pulse')} />
            {installing ? tr('安装中…') : tr('安装插件')}
          </Button>
          {/* 只在真有插件写了 dependencies 时出现：没有依赖的人看到它只会疑惑「点了没反应」 */}
          {hasDeps && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              disabled={loading || !ready || syncingDeps || installing}
              title={tr('把插件声明的 npm 依赖装进这个作用域的插件目录（手工拷进来的插件点这里）')}
              onClick={() => void syncDeps()}
            >
              <Package className={cn('size-3', syncingDeps && 'animate-pulse')} />
              {syncingDeps ? tr('安装中…') : tr('安装依赖')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={loading || !ready}
            title={tr('重新扫描磁盘上的插件目录（手放进去的文件点这里）')}
            onClick={() => {
              // 手放进去的插件也要立刻出现在图标栏：清单和界面清单是两份缓存
              refreshSurfaces()
              void load()
            }}
          >
            <RotateCw className={cn('size-3', loading && 'animate-spin')} />
            {loading ? tr('扫描中…') : tr('刷新')}
          </Button>
        </div>
      </div>

      {/* 扫描位置：看得到「扫了哪儿、各自几个」，新放插件时知道该往哪丢 */}
      {(data?.roots?.length ?? 0) > 0 && (
        <div className="rounded-md border border-border/60">
          <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2">
            <Puzzle className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">{tr(copy.title)}</span>
            <span className="text-[0.625rem] text-muted-foreground">{tr(copy.hint)}</span>
          </div>
          <div className="divide-y divide-border/60">
            {data?.roots.map((root) => {
              const count = plugins.filter((p) => p.root === root.dir).length
              return (
                <div key={`${root.source}:${root.dir}`} className="flex items-center gap-2 px-3 py-1.5">
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  {/* 扫了不止一个目录时才标来源：只有一个时标记纯属噪音 */}
                  {(data?.roots?.length ?? 0) > 1 && (
                    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[0.625rem]">
                      {tr(SOURCE_LABEL[root.source] ?? root.source)}
                    </Badge>
                  )}
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]"
                    title={root.dir}
                    data-selectable
                  >
                    {root.dir}
                  </span>
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    {count > 0 ? tr('{count} 个', { count }) : tr('空')}
                  </span>
                  <button
                    type="button"
                    aria-label={tr('复制目录 {dir}', { dir: root.dir })}
                    title={tr('复制这个目录路径')}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => void copyText(root.dir, tr('目录路径'))}
                  >
                    <Copy className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={tr('打开目录 {dir}', { dir: root.dir })}
                    title={tr('用系统默认程序打开这个目录（桌面端）')}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => void openDir(root.dir)}
                  >
                    <FolderOpen className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 加载 / 校验失败的插件：**必须显式提示**。写错形状（如把 execute 写成 handler）的
          插件会让模型调用后永远停在「执行中」，只靠日志排查太费劲。 */}
      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
          <div className="text-xs font-medium text-destructive">
            {tr('{count} 个插件没通过加载 / 校验，当前不会生效', { count: errors.length })}
          </div>
          <ul className="mt-1 space-y-1">
            {errors.map((err) => (
              <li
                key={err}
                className="text-[0.625rem] leading-4 break-words text-muted-foreground"
                title={err}
              >
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plugins.length > 1 && (
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            {/* `type="search"`：Chrome 的自动填充/密码管理器只认文本输入框，搜索框用
                search 类型能从源头避免被回填（回填会触发 onChange，把插件列表筛空）。
                `name` + 各类密码管理器的忽略标记再兜一层。 */}
            <Input
              type="search"
              name="plugin-search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={tr('搜索插件（名字 / 路径）…')}
              aria-label={tr('搜索插件')}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {kw ? `${shown.length}/${plugins.length}` : tr('{count} 个', { count: plugins.length })}
          </span>
        </div>
      )}

      {/*
        **列数按容器自己的宽度算，不按视口**（`@container` + `auto-fill`）。

        这块面板同时活在两个宽度差很多的地方：设置页（内容区很宽）与项目「更多 → 插件」
        弹窗（`sm:max-w-2xl`，可用宽度只有 ~40rem）；再加上主区域面板本身可以拖宽拖窄。
        用 `sm:grid-cols-2` 那种视口断点，窄面板 + 宽屏幕就会排出两列挤成「Fiz…」的卡片。

        `minmax(min(100%,20rem),1fr)`：一格至少 20rem 才好放下「图标 + 名字/路径 + 开关」；
        外层那个 `min(100%, …)` 是给比 20rem 还窄的容器（手机弹窗）兜底 —— 少了它，轨道
        撑在 20rem 不动，容器一窄就横向溢出。`auto-fill` 按可用宽度自动决定一行几格，
        不必再为「2 格 / 3 格」写死断点。
      */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-2">
        {shown.map((plugin) => {
          const enabled = !disabled.includes(plugin.id)
          // plugins.yml 里写了 enabled:false 的插件：这里管不到它，标出来免得用户
          // 对着一个勾了却又不生效的开关反复点
          const fromConfig = !plugin.enabled && enabled
          // 插件声明的 UI（`ctx.ui`）：设置项现在是**可编辑表单**（值存服务端、密钥加密），
          // 面板（panels）仍只做只读展示 —— 那部分还没有渲染能力。
          const decl = data?.ui[plugin.id]
          const declSettings = decl?.settings ?? []
          const declPanels = decl?.panels ?? []
          // 插件图标（data URI）：清单里静态声明的 `plugin.json` 优先（不用跑插件就能拿到，
          // 也是插件列表那一行用的同一份），否则用 `ctx.ui.icon`。两个来源都只放行
          // data:image/*，所以这里当图片源用即可（**绝不**把声明内容拼进 DOM）
          const pluginIcon = plugin.manifest.icon ?? decl?.icon
          // 它注册的上传源：显示出来，用户才知道「这个插件给了我一个附件上传目标」
          const uploadSources = data?.uploads?.[plugin.id] ?? []
          // 它要的 npm 依赖（按插件根合成后共享一份 node_modules）与自带前端半的界面
          const deps = Object.entries(plugin.manifest.dependencies ?? {})
          return (
            <div
              key={plugin.id}
              // `min-w-0`：栅格项默认 `min-width:auto`，那条长路径会把格子撑破（两列时尤其明显）。
              // 布局是** logo 居左 / 文字居中 / 操作居右**：扫一列卡片时眼睛走一条直线，
              // 不用在每张卡里现找「开关在哪」。
              //
              // 窄屏（手机）把操作列**折到第二行**（`max-sm:basis-full` + 横向右对齐）：
              // 手机上一张卡只有 ~290px，图标 40 + 操作列 80 之后留给名字/路径的只剩 ~130px，
              // 名字和路径双双截成「Fiz…」；折下去之后文字能占满整行。
              className="flex min-w-0 flex-wrap items-start gap-3 rounded-md border border-border/60 px-3 py-2.5"
            >
              {/* 40px：24px 时 logo 里的细节根本看不出来（插件作者找的图等于白画）。
                  `object-contain` 让非正方形（常见的横版 logo）不被拉变形；
                  没声明图标时给**同尺寸**占位，免得有图标与没图标的两行文字左边界错开。 */}
              {pluginIcon ? (
                <img
                  src={pluginIcon}
                  alt=""
                  aria-hidden
                  className="size-10 shrink-0 rounded-lg object-contain"
                />
              ) : (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                  <Puzzle className="size-5 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{plugin.name}</span>
                  {mixedSources && (
                    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[0.625rem]">
                      {tr(SOURCE_LABEL[plugin.source] ?? plugin.source)}
                    </Badge>
                  )}
                  {fromConfig && (
                    <Badge
                      variant="outline"
                      className="h-5 shrink-0 px-1.5 text-[0.625rem] text-muted-foreground"
                      title={tr('这个插件在 plugins.yml 里被 enabled: false 停用，改这里没用')}
                    >
                      {tr('plugins.yml 停用')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted-foreground"
                    title={plugin.file}
                    data-selectable
                  >
                    {plugin.file}
                  </span>
                  <button
                    type="button"
                    aria-label={tr('复制插件路径 {name}', { name: plugin.name })}
                    title={tr('复制插件目录路径')}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => void copyText(plugin.file, tr('插件路径'))}
                  >
                    <Copy className="size-3" />
                  </button>
                </div>
                {uploadSources.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 border-l border-border/60 pl-2">
                    {uploadSources.map((source) => (
                      <div
                        key={`u:${source.id}`}
                        className="text-[0.625rem] leading-4 text-muted-foreground"
                        title={
                          source.acceptMime.length
                            ? tr('接受：{list}', { list: source.acceptMime.join(', ') })
                            : tr('接受：内置白名单（图片 + PDF）')
                        }
                      >
                        <span className="text-foreground/80">{tr('上传源：')}{source.title}</span>
                        <span className="ml-1 rounded bg-muted px-1 text-muted-foreground">
                          {tr('附件菜单')}
                        </span>
                        {source.maxBytes ? (
                          <span className="ml-1 text-muted-foreground">
                            ≤{Math.round(source.maxBytes / 1024 / 1024)}MB
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                {declPanels.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 border-l border-border/60 pl-2">
                    {declPanels.map((panel) => (
                      <div
                        key={`p:${panel.id}`}
                        className="text-[0.625rem] leading-4 text-muted-foreground"
                        title={panel.description ?? panel.id}
                      >
                        <span className="text-foreground/80">{panel.title}</span>
                        <span className="ml-1 rounded bg-muted px-1 text-muted-foreground">
                          {tr('面板')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* 依赖按插件根合成一份，冲突只告警不阻断 —— 卡上直接摊开写了哪些包，
                    省得用户为了「到底装没装」去翻 node_modules。 */}
                {deps.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Package className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    {deps.map(([name, range]) => (
                      <span
                        key={`d:${name}`}
                        className="rounded bg-muted px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground"
                        title={tr('{name}@{range}（装在这个插件根的共享 node_modules 里）', {
                          name,
                          range
                        })}
                      >
                        {name}@{range}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 右：操作（启停 / 配置）。窄屏折到第二行并横向右对齐（见卡片容器那段注释） */}
              <div className="flex shrink-0 flex-col items-end gap-1.5 max-sm:basis-full max-sm:flex-row max-sm:items-center max-sm:justify-end">
                <Switch
                  checked={enabled}
                  disabled={busyIds.includes(plugin.id)}
                  onCheckedChange={(next) => void toggle(plugin.id, next)}
                  aria-label={enabled ? tr('停用插件 {name}', { name: plugin.name }) : tr('启用插件 {name}', { name: plugin.name })}
                />
                {declSettings.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[0.625rem]"
                    title={tr('编辑这个插件的设置项')}
                    onClick={() => setConfigPluginId(plugin.id)}
                  >
                    <SlidersHorizontal className="size-3" />
                    {tr('配置')}
                    {/* 手机上去掉项数：这个按钮和开关挤在同一行时，多两个字就够把插件名再压一截 */}
                    <span className="max-sm:hidden">{tr('（{count} 项）', { count: declSettings.length })}</span>
                  </Button>
                )}
                {/* 卸载：内置插件除外（它随产品分发，只能停用不能删），见 uninstall 路由 */}
                {plugin.source !== 'builtin' &&
                  (pendingUninstall === plugin.id ? (
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className="max-w-[9rem] text-right text-[0.625rem] leading-3 text-destructive"
                        title={plugin.file}
                      >
                        {tr('删掉 {name}？', { name: plugin.file.split(/[\\/]/).pop() ?? plugin.file })}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyIds.includes(plugin.id)}
                          onClick={() => setPendingUninstall(null)}
                        >
                          {tr('取消')}
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={busyIds.includes(plugin.id)}
                          onClick={() => void uninstall(plugin.id, plugin.name)}
                        >
                          {tr('删除')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      title={tr('卸载（把它的文件从磁盘删掉）')}
                      aria-label={tr('卸载插件 {name}', { name: plugin.name })}
                      disabled={busyIds.includes(plugin.id)}
                      onClick={() => setPendingUninstall(plugin.id)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 设置项编辑弹窗：高度封顶 + 内部滚动，十项设置（如 OSS）也放得下；值随 `data` 刷新而更新
          （见上面 configPlugin 的说明），所以保存后不必关弹窗也能看到新状态。 */}
      {configPlugin && configSettings.length > 0 && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfigPluginId(null)
          }}
        >
          {/* `max-sm:p-4`：手机上一屏只有 ~330px，默认 24px 的内边距再吃掉 48px，
              表单行就只剩 260px —— 叠在一起更明显（与设置弹窗同款处理） */}
          <DialogContent className="max-sm:p-4 sm:max-w-[min(40rem,calc(100%-2rem))]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {configIcon && (
                  <img
                    src={configIcon}
                    alt=""
                    aria-hidden
                    className="size-9 shrink-0 rounded-lg object-contain"
                  />
                )}
                {/* `min-w-0 flex-1`：flex 子项默认不肯缩到内容宽度以下，超长插件名会把标题顶宽 */}
                <span className="min-w-0 flex-1 truncate">{configPlugin.name}</span>
              </DialogTitle>
            </DialogHeader>
            {/*
              `overflow-x-hidden` 不是多余的：只写 `overflow-y-auto` 时，**另一轴会被算成 auto**，
              内容稍微宽一点就冒出横向滚动条（配置项里全是长 URL / 长键名）。纵向该滚还滚。
              `min-w-0`：它是 DialogContent 那个 grid 的子项，默认 `min-width:auto` 会按内容撑宽。
            */}
            <div className="max-h-[60dvh] min-w-0 overflow-x-hidden overflow-y-auto px-0.5">
              <PluginSettingsForm
                settings={configSettings}
                onSave={(patch) => saveSettings(configPlugin.id, patch)}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {!loading && plugins.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr(copy.empty)}
        </p>
      )}
      {plugins.length > 0 && shown.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr('没有匹配「{keyword}」的插件。', { keyword: keyword.trim() })}
        </p>
      )}
    </div>
  )
}
