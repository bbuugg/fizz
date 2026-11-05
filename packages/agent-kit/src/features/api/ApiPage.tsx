"use client";

/**
 * 接口请求编辑页（主区域）：一个标签 = 一个请求（或一条未保存草稿）。
 *
 * 从 dogi 的 `features/api/ApiPage.tsx` 平移，做了四处适配：
 * 1. antd（Select / Input / Segmented / Modal / AutoComplete / Tag / message）全换成
 *    shadcn/ui + `cn()` + sonner —— 本仓库禁用 antd。补全**不用原生 `<datalist>`**：
 *    那个下拉由浏览器 / 系统绘制，跟主题与表格观感都对不上，改用 `KeyValueTable` 里
 *    自绘的 Popover 下拉（见 `CellSuggestInput`）。
 * 2. 请求由**服务端**发出（`app.sendApiRequest` → `POST /api/api-client/send`），
 *    不再是 Electron 主进程 IPC；取消走 `sendId`。
 * 3. form-data 的文件字段由 `<input type=file>` 读成 base64 随 JSON 上送
 *    （`fileToBase64`），**没有本地绝对路径**的概念：落盘只留 `fileName`，内容
 *    （`dataBase64`）只活在标签内存里、随发送载荷上送。
 * 4. 请求头 / 参数 / 请求体表单四处统一走 `KeyValueTable`（自定义表格：表头 + 行分隔线 +
 *    整行 hover + **零边框零圆角**的单元格 + 行首启用勾选），不再各写一摊「flex 行 + Input」。
 *    它只认 `key` / `value` / `enabled`，文件列与「类型」列由 `kindOf` / `renderValue` 注入。
 *
 * 草稿**不自动保存**：改完点工具栏「保存」或按 Ctrl/Cmd+S 才落盘（保存成功给 toast）。
 *
 * ## 页面上的三组切换都是 shadcn `Tabs`
 *
 * 原先这三处用的是分段控件（现在是 `shared/components/Segmented`），现在统一走
 * `shared/ui/tabs`，视觉与设置页 / 弹窗里的 Tab 一致：
 *
 * - **请求构造区**（请求头 / 参数 / 请求体）—— 最外层那棵 `Tabs`；
 * - **请求体形态**（none / raw / x-www-form-urlencoded / form-data）—— 嵌在「请求体」面板里
 *   的第二棵 `Tabs`（Radix 的 Tabs 可以嵌套，两层各有各的 value）；
 * - **响应区**（响应体 / 响应头）—— 下面那棵 `Tabs`。
 *
 * 三个面板都由 `TabsContent` 承载，Radix 只挂当前那个 —— 与原先 `x === 'a' && …`
 * 的卸载行为一致，不会在背后多留一份 Monaco。`WsPage` 的分段控件仍是 `Segmented`（没跟着换），
 * 但两边分隔条的指针管线是同一份 `useDragResize`。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { ChevronDown, ChevronUp, FolderOpen, Globe, Save, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import MonacoEditor from '@fizz/agent-kit/features/files/MonacoEditor'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { fileToBase64 } from '@fizz/agent-client/api'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { closeTab } from '@fizz/agent-kit/shared/lib/panel-store'
import { apiTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { openApiTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import {
  BODY_TYPES,
  COMMON_HEADERS,
  METHODS,
  NEW_API_REQUEST_ID,
  baseNameOf,
  bodyLanguageOf,
  contentTypeForBodyType,
  contentTypeOf,
  emptyFormField,
  emptyHeader,
  formatBody,
  formatBytes,
  headerValueSuggestions,
  isBlankFormField,
  isBlankHeader,
  isFormContentType,
  normalizeFormFields,
  normalizeHeaders,
  pairsToHeaders,
  parseQueryParams,
  serializeParams,
  setContentType,
  statusClass,
  tidyFormRows,
  tidyHeaderRows,
  withQuery
} from '@fizz/agent-kit/features/api/api-client'
import { buildGroupTree, type GroupNode } from '@fizz/agent-kit/shared/lib/group-tree'
import { CellInput, KeyValueTable } from '@fizz/agent-kit/features/api/KeyValueTable'
import { apiDraftSeedVersion, subscribeApiDraftSeed, takeApiDraftSeed } from '@fizz/agent-kit/features/api/api-draft'
import type {
  ApiBodyType,
  ApiFormField,
  ApiGroup,
  ApiHeaderPair,
  ApiHistoryEntry,
  ApiHttpResponse,
  ApiRequestEntry
} from '@fizz/contracts/types'

/** 接口请求分组树节点（`group-tree` 的常用实例化） */
type ApiGroupNode = GroupNode<ApiGroup, ApiRequestEntry>

/** 响应面板高度占比的默认值与上下限（拖动分隔条时按此范围夹取） */
const RES_RATIO_DEFAULT = 0.45
const RES_RATIO_MIN = 0.15
const RES_RATIO_MAX = 0.8
/**
 * 请求构造区（请求头 / 请求体）至少保留的高度（px）。
 * 只按比例卡上限是不够的：窗口一矮，80% 的响应面板照样能把请求区压成 0，
 * 压扁后请求区内容会溢出、透过响应面板显出来，所以还要按像素留底。
 */
const MIN_REQ_PANE_H = 120

/**
 * 分组选择器的「未分组 / 顶级」哨兵值。
 * Radix Select **不允许**空字符串当 `value`（会当成「无值」而显示占位符），
 * 所以用一个不可能撞车的哨兵字符串代表「不归属任何分组」。
 */
const NO_GROUP = '__none__'

/** 请求构造区的分段切换项 */
const REQ_TABS = [
  { value: 'headers', label: '请求头' },
  { value: 'params', label: '参数' },
  { value: 'body', label: '请求体' }
] as const

type ReqTab = (typeof REQ_TABS)[number]['value']

/**
 * 请求体类型选项（横向分段，顺序即 BODY_TYPES）。
 * `shortLabel` 是窄屏用的短标签（见 `BODY_TYPES` 的说明），这里补成「必有」，
 * 渲染时就不用再写 `?? label` 兜底。
 */
const BODY_TYPE_OPTIONS = BODY_TYPES.map((b) => ({
  value: b.value,
  label: b.label,
  shortLabel: b.shortLabel ?? b.label
}))
const METHOD_OPTIONS = METHODS.map((m) => ({ value: m, label: m }))

/** 分组下拉的扁平选项（多级用全角缩进表达层级；Radix Select 不支持嵌套） */
interface GroupOption {
  id: string
  label: string
}

function flattenGroupOptions(groups: ApiGroup[]): GroupOption[] {
  const out: GroupOption[] = []
  const walk = (nodes: ApiGroupNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ id: node.group.id, label: `${'　'.repeat(depth)}${node.group.name}` })
      walk(node.children, depth + 1)
    }
  }
  walk(buildGroupTree(groups, []), 0)
  return out
}

/**
 * form-data 字段的值单元格：只读文件名 + 「选择文件」。
 *
 * 单独抽出来是因为它**整格替换**掉了 `KeyValueTable` 的默认输入框（`renderValue`）——
 * 文件字段的值不是手打的，是选出来的；给一个能打字但打了没用的框只会误导。
 * 输入框复用 `KeyValueTable` 导出的 `CellInput`，免得两处格子长得不一样。
 *
 * 「选择文件」用 `ghost`（无边框）而不是 `outline`：这一格是**表格里的一个动作**，
 * 描边的按钮在表格里会立刻变成一个「表单控件」，和旁边零边框的格子格格不入。
 * 可点性靠 hover 的底色和图标承担（与行尾删除按钮同一套）。
 */
function FileValueCell({
  field,
  onPick
}: {
  field: ApiFormField
  onPick: () => void
}) {
  return (
    <>
      <CellInput
        readOnly
        value={field.fileName || baseNameOf(field.value) || ''}
        placeholder="未选择文件"
        title={field.fileName || undefined}
        aria-label="已选文件"
        className="flex-1 text-muted-foreground"
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 px-1.5 text-xs text-foreground/80 hover:text-foreground"
        onClick={onPick}
      >
        <FolderOpen className="size-3.5" />
        选择文件
      </Button>
    </>
  )
}

/** 落盘前剥掉文件字段的运行期内容（`dataBase64` 只随发送载荷走，不写库） */
function stripFileData(fields: ApiFormField[]): ApiFormField[] {
  return fields.map((f) => {
    if (!f.dataBase64) return f
    const { dataBase64: _omit, ...rest } = f
    return rest
  })
}

export function ApiPage({ requestId }: { requestId: string }) {
  const { app } = useAppContext()
  const request = app.apiRequests.find((r) => r.id === requestId) ?? null
  /** 本标签是否是「未保存的新请求」草稿（requestId 为哨兵值，不是真实存储条目） */
  const isDraft = requestId === NEW_API_REQUEST_ID

  /** 分组下拉选项：未分组 + 多级分组树（扁平化 + 缩进表达层级） */
  const groupOptions = useMemo(() => flattenGroupOptions(app.apiGroups), [app.apiGroups])

  // ---------- 请求草稿 ----------
  // 不自动保存：改完必须按 Ctrl/Cmd+S 才落盘。标签保持挂载，所以切走再回来草稿还在；
  // 但**关掉标签**就会丢掉未保存的改动（这是「不自动保存」的必然代价）。
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState<string | undefined>(undefined)
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<ApiHeaderPair[]>([emptyHeader()])
  /**
   * 查询参数表。URL 的查询串是它的唯一事实来源（不另存一份），
   * 所以这里只是「查询串的可编辑视图」：改 URL 的查询 → 解析进本表；
   * 改本表 → 序列化回 URL 的查询串（见 params 的同步 effect）。
   */
  const [params, setParams] = useState<ApiHeaderPair[]>([emptyHeader()])
  const [body, setBody] = useState('')
  /** 请求体类型：三种形态**各存各的内容**（raw 用 body、另两种各一张表），来回切不丢东西 */
  const [bodyType, setBodyType] = useState<ApiBodyType>('raw')
  const [urlencoded, setUrlencoded] = useState<ApiHeaderPair[]>([emptyHeader()])
  /** `form-data` 的字段（文件字段的 `dataBase64` 只活在内存里） */
  const [formFields, setFormFields] = useState<ApiFormField[]>([emptyFormField()])
  /** 请求体编辑器（Monaco）的高亮语言：由 Content-Type 推导，不持久化 */
  const [bodyLanguage, setBodyLanguage] = useState('json')

  // ---------- 视图状态（无需持久化；标签保持挂载，所以切标签不丢） ----------
  const [reqTab, setReqTab] = useState<ReqTab>('headers')
  const [resTab, setResTab] = useState<'body' | 'headers'>('body')
  const [sending, setSending] = useState(false)
  /**
   * 进行中请求的取消句柄：sendIdRef 记着本次 send 的 sendId（服务端按它找到终止信号），
   * cancelledRef 标记「是用户主动取消的」—— 取消与超时在服务端侧都表现为 status=0 +
   * AbortError，只有渲染端能区分。
   */
  const sendIdRef = useRef('')
  const cancelledRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [response, setResponse] = useState<ApiHttpResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 响应正文：本地可编辑副本；用 Monaco 展示并允许其格式化按钮美化（不落盘） */
  const [respBody, setRespBody] = useState('')
  const [respCollapsed, setRespCollapsed] = useState(false)
  const [resRatio, setResRatio] = useState(RES_RATIO_DEFAULT)
  /** 页面根容器：拖动分隔条时按它的高度换算比例（不依赖 parentElement 的层级假设） */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 请求行（方法 + 地址 + 发送）：它的底边就是请求构造区的顶边，用来算响应面板的高度上限 */
  const reqRowRef = useRef<HTMLDivElement | null>(null)

  /**
   * 切换请求：用新请求重置草稿（不冲刷未保存的改动 —— 那是用户自己的事）。
   * 草稿（`isDraft`）时 `request` 恒为 null（哨兵 id 不在列表里），初值全空。
   */
  useEffect(() => {
    const req = useAgentStore.getState().apiRequests.find((r) => r.id === requestId) ?? null
    setName(req?.name ?? '')
    setGroupId(req?.groupId)
    setMethod(req?.method ?? 'GET')
    setUrl(req?.url ?? '')
    setHeaders(req?.headers?.length ? tidyHeaderRows(normalizeHeaders(req.headers)) : [emptyHeader()])
    // 查询参数表从 URL 的查询串解析出来（不另存，URL 才是事实来源）
    setParams(tidyHeaderRows(parseQueryParams(req?.url ?? '')))
    setBody(req?.body ?? '')
    // 请求体形态：历史数据没有 bodyType → raw；两张表单各自规整（末行恒为空槽位）
    setBodyType(req?.bodyType ?? 'raw')
    setUrlencoded(
      req?.bodyUrlencoded?.length ? tidyHeaderRows(normalizeHeaders(req.bodyUrlencoded)) : [emptyHeader()]
    )
    setFormFields(
      req?.bodyFormFields?.length
        ? tidyFormRows(normalizeFormFields(req.bodyFormFields))
        : [emptyFormField()]
    )
    // 编辑器语言跟着这个请求的 Content-Type 走（没有 Content-Type 时给 json）
    setBodyLanguage(bodyLanguageOf(contentTypeOf(req?.headers ?? [])))
    // 响应与错误属于「上一次请求的结果」，换请求时清空避免张冠李戴
    setResponse(null)
    setError(null)
  }, [requestId])

  /**
   * 工具栏那两个输入框（分组 / 名称）在**已保存请求**上要跟着条目走：侧栏那一行也能改这两项
   * （那边弹窗直接落盘），改完这里得跟上 —— 不跟的话工具栏还显示旧名字，而「保存」用的正是
   * 本地这份值，会把侧栏刚改的覆盖回去（`saveNow` 的取值来源就是 `name` / `groupId`）。
   *
   * 只认**存储里的值**变化，所以在本页打字不会被这条 effect 打回（打字只改本地 state，
   * 不动 store）。草稿（`isDraft`）不走这里：它还没进列表，这两项就是本页自己说了算。
   */
  useEffect(() => {
    if (isDraft) return
    setName(request?.name ?? '')
    setGroupId(request?.groupId)
  }, [isDraft, request?.name, request?.groupId])

  /**
   * 关闭 / 刷新守卫（**只给未保存的草稿标签**）：填了任何内容再关 / 再刷 → 先确认「丢弃」。
   *
   * 草稿不自动保存（改完按 Ctrl/Cmd+S 才落盘），关掉标签、刷新标签（内容卸载重挂）都等于
   * 丢掉这些改动，所以两个钩子共用同一份脏判据、只换文案。空白草稿（什么都没填）直接放行。
   * 已保存的接口标签本轮不拦（将来要拦，把这里的判据换成「与落盘条目比对」即可）。
   * **保存路径**里的 `closeTab(apiTabKey(NEW_API_REQUEST_ID))` 是草稿提升为真实标签，
   * 走裸关闭、不经过这里（见 `tab-close.ts` 纪律 1）。
   */
  const confirm = useConfirm()
  const dirtyRef = useRef(false)
  dirtyRef.current =
    isDraft &&
    (method !== 'GET' ||
      // 名称 / 分组也在工具栏上，只填了这两项也算「有改动」（否则打个名字再关就静默丢了）
      name.trim() !== '' ||
      groupId !== undefined ||
      url.trim() !== '' ||
      body.trim() !== '' ||
      headers.some((h) => !isBlankHeader(h)) ||
      params.some((h) => !isBlankHeader(h)) ||
      urlencoded.some((h) => !isBlankHeader(h)) ||
      formFields.some((f) => !isBlankFormField(f)))
  useEffect(() => {
    if (!isDraft) return
    return registerTabCloseGuard(apiTabKey(requestId), {
      beforeClose: async () => {
        if (!dirtyRef.current) return 'close'
        const ok = await confirm({
          title: '丢弃未保存的改动？',
          description: '这个请求还没有保存，关闭标签会丢弃当前的改动。',
          confirmLabel: '丢弃并关闭',
          destructive: true
        })
        return ok ? 'close' : 'cancel'
      },
      beforeReload: async () => {
        if (!dirtyRef.current) return 'reload'
        const ok = await confirm({
          title: '丢弃未保存的改动并刷新？',
          description: '这个请求还没有保存，刷新标签会重新挂载页面、丢弃当前的改动。',
          confirmLabel: '丢弃并刷新',
          destructive: true
        })
        return ok ? 'reload' : 'cancel'
      }
    })
  }, [isDraft, requestId, confirm])

  /**
   * 消费「历史记录载入」的种子：侧栏历史分区点一行时，先 `setApiDraftSeed(entry)`
   * 再开草稿标签，本 effect 把种子写进草稿后立即清空。
   *
   * 订阅**版本号**而不是只依赖 `requestId`：草稿标签复用同一个 key，第二条历史点进来
   * 时组件不重挂、`requestId` 也没变 —— 靠版本号自增才能触发「载入新种子」。
   * 只作用于草稿（`isDraft`）：已保存请求的标签也挂着本组件，绝不能被种子冲掉草稿；
   * 声明在「切换请求」effect 之后 —— 挂载时两者都跑，种子要在其后覆盖生效。
   */
  const seedVersion = useSyncExternalStore(subscribeApiDraftSeed, apiDraftSeedVersion, () => 0)
  useEffect(() => {
    if (!isDraft) return
    const seed = takeApiDraftSeed()
    if (!seed) return
    const seedHeaders = tidyHeaderRows(normalizeHeaders(seed.headers))
    setMethod(seed.method || 'GET')
    setUrl(seed.url || '')
    setParams(tidyHeaderRows(parseQueryParams(seed.url || '')))
    setHeaders(seedHeaders)
    setBody(seed.body || '')
    setBodyType(seed.bodyType ?? 'raw')
    setUrlencoded(
      seed.bodyUrlencoded?.length ? tidyHeaderRows(normalizeHeaders(seed.bodyUrlencoded)) : [emptyHeader()]
    )
    setFormFields(
      seed.bodyFormFields?.length
        ? tidyFormRows(normalizeFormFields(seed.bodyFormFields))
        : [emptyFormField()]
    )
    setBodyLanguage(bodyLanguageOf(contentTypeOf(seedHeaders)))
    setReqTab('headers')
    setResponse(null)
    setError(null)
  }, [seedVersion, isDraft])

  /**
   * 新响应到达时，把正文按内容类型美化后放进可编辑副本（Monaco 展示 + 允许格式化按钮）。
   * 放在 early return 之前：它是纯派生副作用，不依赖 request 是否存在。
   */
  useEffect(() => {
    if (response) {
      const ct = response.headers?.['content-type'] || ''
      setRespBody(formatBody(response.body, ct, true))
    }
  }, [response])

  /**
   * 参数表 → URL 的同步（与 onUrlChange 形成双向）。
   * 仅当参数表变化时触发：把整张表序列化回 URL 的查询串。
   * 因为 onUrlChange 已经把「URL 改动」解析进了参数表，这里序列化回去得到的就是同源字符串，
   * setUrl 会被 React 的同值跳过（除非确实存在差异，例如用户改了某个参数行的值），
   * 所以不会和地址框输入形成回环。
   */
  useEffect(() => {
    const candidate = withQuery(url, serializeParams(params))
    if (candidate !== url) setUrl(candidate)
    // 只依赖 params：本 effect 要的是「用当前 URL 替换其查询串」，
    // 闭包里的 url 就是本次提交时的地址（已是上一次同步后的结果）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  // ---------- 请求头增删改 ----------
  // 没有「添加请求头」按钮：末行填了内容就自动补一个空槽位（见 tidyHeaderRows），
  // 所以表格最后一行永远是待填的那一行。
  // 行上的字段（key / value / enabled）都走这一个 patch 入口：勾选「停用」不该另开一条路。
  const patchHeader = (idx: number, patch: Partial<ApiHeaderPair>): void => {
    setHeaders((prev) => tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, ...patch } : p))))
    // 改的是 Content-Type 的值 → 请求体编辑器的高亮语言跟着换
    if (patch.value !== undefined && (headers[idx]?.key ?? '').trim().toLowerCase() === 'content-type') {
      setBodyLanguage(bodyLanguageOf(patch.value))
    }
  }
  const removeHeader = (idx: number): void => {
    setHeaders((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
  }

  // ---------- 查询参数（与请求头同样的「末行空槽位」交互，但无补全） ----------
  const patchParam = (idx: number, patch: Partial<ApiHeaderPair>): void => {
    setParams((prev) => tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, ...patch } : p))))
  }
  const removeParam = (idx: number): void => {
    setParams((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
  }

  // ---------- 表单字段（x-www-form-urlencoded / form-data 各一张表） ----------
  const patchUrlencoded = (idx: number, patch: Partial<ApiHeaderPair>): void => {
    setUrlencoded((prev) => tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, ...patch } : p))))
  }
  const removeUrlencoded = (idx: number): void => {
    setUrlencoded((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
  }
  const patchFormField = (idx: number, patch: Partial<ApiFormField>): void => {
    setFormFields((prev) => tidyFormRows(prev.map((f, i) => (i === idx ? { ...f, ...patch } : f))))
  }
  const removeFormField = (idx: number): void => {
    setFormFields((prev) => tidyFormRows(prev.filter((_, i) => i !== idx)))
  }

  /**
   * 为某个 form-data 字段选本地文件：浏览器 `<input type=file>` 选文件 → 读成 base64
   * （`dataBase64`）存进标签内存，`fileName` 用于 multipart 的 filename 与界面展示。
   * 落盘**只留 fileName**（见 stripFileData）—— 文件内容不进库。
   */
  const pickFormFile = (idx: number): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void fileToBase64(file)
        .then((dataBase64) =>
          patchFormField(idx, { isFile: true, fileName: file.name, value: '', dataBase64 })
        )
        .catch((e) => toast.error('读取文件失败：' + (e instanceof Error ? e.message : String(e))))
    }
    input.click()
  }

  /**
   * 切换请求体类型：顺手把请求头里的 Content-Type 一起换掉，别让它跟正文对不上。
   * - `none`：连 Content-Type 也不动 —— 没有正文就没有「对不上」的问题；
   * - 换成表单类：当前没填、或填的还是另一类表单 → 换成这一类的标准值；
   * - 换回 raw：当前还是表单类 → 换成 application/json。
   */
  const changeBodyType = (next: ApiBodyType): void => {
    setBodyType(next)
    if (next === 'none') return
    const canonical = contentTypeForBodyType(next)
    const current = contentTypeOf(headers)
    if (canonical && (!current.trim() || isFormContentType(current))) {
      setHeaders((prev) => setContentType(prev, canonical))
      setBodyLanguage(bodyLanguageOf(canonical))
    } else if (!canonical && isFormContentType(current)) {
      setHeaders((prev) => setContentType(prev, 'application/json'))
      setBodyLanguage('json')
    }
  }

  /**
   * 地址框输入：直接把新 URL 落盘到草稿，同时把查询串解析进参数表
   * （这是「URL → 表格」这一向的同步；「表格 → URL」由上面的 effect 负责）。
   */
  const onUrlChange = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    setUrl(raw)
    setParams(tidyHeaderRows(parseQueryParams(raw)))
  }

  // ---------- 保存（唯一落盘入口；工具栏「保存」按钮与 Ctrl/Cmd+S 都走到这里） ----------
  /**
   * 草稿真正落盘：把工具栏那两个输入框的当前值（名称 + 分组）一并写入列表，
   * 并把草稿标签切成真实标签。
   *
   * 名称**允许为空**（工具栏不弹窗要名字了）：空名在侧栏按「方法 + 路径」显示
   * （见 `ApiPanel` 的 `RequestRow`），不该为了一个显示名把「保存」变成点不动的死键。
   */
  const persistDraft = async (): Promise<void> => {
    setSaving(true)
    try {
      const before = new Set(useAgentStore.getState().apiRequests.map((r) => r.id))
      const ok = await app.saveApiRequest({
        id: '',
        name: name.trim(),
        method,
        url: url.trim(),
        headers,
        body,
        bodyType,
        bodyUrlencoded: urlencoded,
        bodyFormFields: stripFileData(formFields),
        groupId,
        createdAt: 0,
        updatedAt: 0
      })
      if (!ok) return
      const created = useAgentStore.getState().apiRequests.find((r) => !before.has(r.id))
      // 草稿标签 → 真实标签：关掉草稿，避免残留一个空白标签
      closeTab(apiTabKey(NEW_API_REQUEST_ID))
      if (created) openApiTab(created)
      toast.success('已保存')
    } finally {
      setSaving(false)
    }
  }

  /**
   * 保存（工具栏那颗「保存」按钮与 Ctrl/Cmd+S 都走到这里）。两种情况同一颗键：
   * - **未保存草稿 → 新增**：名称 / 分组取工具栏输入框的当前值，没填名字也照存（行上退回
   *   「方法 + 路径」）；
   * - **已保存请求 → 修改**：整条覆盖写，名称 / 分组同样以本地 state 为准
   *   （它跟着侧栏那一行的改动同步，见上面的同步 effect）。
   */
  const saveNow = async (): Promise<void> => {
    if (isDraft) {
      await persistDraft()
      return
    }
    setSaving(true)
    const ok = await app.saveApiRequest({
      id: requestId,
      name: name.trim(),
      method,
      url: url.trim(),
      headers,
      body,
      bodyType,
      bodyUrlencoded: urlencoded,
      bodyFormFields: stripFileData(formFields),
      groupId,
      createdAt: 0,
      updatedAt: 0
    })
    setSaving(false)
    if (ok) toast.success('已保存')
  }

  // ---------- 发送 ----------
  const send = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed) {
      setError('请填写请求地址')
      return
    }
    setSending(true)
    setError(null)
    setResponse(null)
    const sendId = crypto.randomUUID()
    sendIdRef.current = sendId
    cancelledRef.current = false
    let res: ApiHttpResponse | null = null
    try {
      // 不传 timeoutMs：永不超时，慢接口由用户手动点「取消」中断。
      // 三种请求体形态把各自的数据都带上（服务端按 bodyType 取用那一种）。
      res = await app.sendApiRequest({
        sendId,
        request: {
          method,
          url: trimmed,
          headers: pairsToHeaders(headers),
          bodyType,
          body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
          urlencoded,
          formFields
        }
      })
    } finally {
      setSending(false)
      sendIdRef.current = ''
      if (cancelledRef.current) {
        cancelledRef.current = false
        setError('请求已取消')
        toast.info('请求已取消')
      } else if (res) {
        setResponse(res)
        if (res.error) toast.error('请求失败：' + res.error)
        // 失败也记历史（status=0），便于回看「当时发的是什么」；手动取消不记
        const entry: ApiHistoryEntry = {
          id: crypto.randomUUID(),
          method,
          url: trimmed,
          headers,
          body,
          bodyType,
          bodyUrlencoded: urlencoded,
          bodyFormFields: stripFileData(formFields),
          status: res.status,
          statusText: res.statusText,
          timeMs: res.timeMs,
          at: Date.now()
        }
        void app.saveApiHistory([entry, ...app.apiHistory].slice(0, 50))
      }
    }
  }

  /** 取消进行中的请求（发送按钮在请求期间就是「取消」） */
  const cancelSend = (): void => {
    const id = sendIdRef.current
    if (!id) return
    cancelledRef.current = true
    void app.abortApiRequest(id)
  }

  /**
   * 拖动分隔条调整响应面板高度。
   *
   * 高度按「页面根容器」的高度换算成比例，所以窗口缩放后仍然正确；
   * 上限不是死比例，而是「请求构造区至少留 MIN_REQ_PANE_H」反推出来的，
   * 否则能一路把请求区压成 0、让响应面板盖住请求头。
   *
   * 指针管线走 `useDragResize`（`touch-action` + 幂等收尾，见该 hook 的文件头）：
   * 这里以前手写 `pointerdown + window pointermove`，缺 `touch-action` 声明，
   * 手机上手指一动就被浏览器当成滚动手势抢走（`pointercancel`），
   * 表现为「一次只能拖一点点、松手就停」。
   */
  const startResize = useDragResize<{
    total: number
    startRatio: number
    maxRatio: number
  }>({
    axis: 'y',
    onStart: () => {
      const rootRect = rootRef.current?.getBoundingClientRect()
      const reqRect = reqRowRef.current?.getBoundingClientRect()
      // 量不到就当作无效起点，别进拖拽（否则整段拖动都在改一个错误的比例）
      if (!rootRect || !reqRect || rootRect.height <= 0) return null
      const total = rootRect.height
      const fixedAbove = reqRect.bottom - rootRect.top
      return {
        total,
        startRatio: resRatio,
        maxRatio: Math.min(
          RES_RATIO_MAX,
          Math.max(RES_RATIO_MIN, (total - fixedAbove - MIN_REQ_PANE_H) / total)
        )
      }
    },
    // 向上拖（deltaY 为负）= 响应区变高
    onMove: (deltaY, drag) =>
      setResRatio(
        Math.min(drag.maxRatio, Math.max(RES_RATIO_MIN, drag.startRatio - deltaY / drag.total))
      )
  })

  /**
   * 快捷键：Ctrl/Cmd+S 保存（与工具栏「保存」按钮同效），Ctrl/Cmd+Enter 发送
   * （请求进行中时同一快捷键改为取消）。限定在页内（onKeyDown 挂在根容器上）。
   */
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveNow()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (sending) cancelSend()
      else void send()
    }
  }

  if (!request && !isDraft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Globe className="size-12 opacity-30" />
        <div className="text-sm">该请求已被删除</div>
        <div className="text-xs text-muted-foreground">从左侧列表选择其他请求</div>
      </div>
    )
  }

  const contentType = response?.headers?.['content-type'] || ''
  const respLang = bodyLanguageOf(contentType)
  const respHeaders = response ? Object.entries(response.headers || {}) : []

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-background" onKeyDown={onKeyDown}>
      {/*
        工具栏：**分组 + 名称一行，两项都可编辑** + 右侧「保存」按钮。详情页**不弹任何 dialog**。

        这两项是这条请求的「身份」（放在哪、叫什么），和下面的请求内容（方法 / 地址 / 请求头 /
        请求体）分开摆；两边都靠同一颗「保存」落盘 —— 点下去**新的就新增、旧的（已保存的）就修改**，
        用户不用先分辨自己开的是哪种标签。

        名称是输入框、**允许留空**：空名在侧栏按「方法 + 路径」显示（见 `ApiPanel` 的
        `RequestRow`），不该为了一个显示名把「保存」变成点不动的死键。
        分组下拉**固定 `w-40`**（长分组名截断、不挤名字）：宽度跟着内容走的话，换个分组
        就会让右边的名称输入框左右跳一下；「未分组」走 `NO_GROUP` 哨兵。
        已保存的请求在侧栏那一行也能改这两项（那边弹窗直接落盘），改完靠上面的同步 effect 跟上。
        「保存」必须**有按钮**：Ctrl/Cmd+S 只是加速方式，不能是唯一入口（没有键盘就没法落盘）。
      */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <Select
          value={groupId ?? NO_GROUP}
          onValueChange={(v) => setGroupId(v === NO_GROUP ? undefined : v)}
        >
          <SelectTrigger
            size="sm"
            className="w-40 shrink-0"
            title="请求所属分组（改动后点「保存」或 Ctrl+S 落盘）"
          >
            <SelectValue placeholder="未分组" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP}>未分组</SelectItem>
            {groupOptions.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="请求名称（可选，缺省显示「方法 + 路径」）"
          className="h-8 min-w-0 flex-1 text-[15px] font-semibold"
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0 gap-1.5"
          disabled={saving}
          title="保存（Ctrl+S）"
          onClick={() => void saveNow()}
        >
          <Save className="size-4" />
          保存
        </Button>
      </div>

      {/*
        请求行：方法 + 地址 + 发送 —— **三者融成一条**，看起来是一整个输入框，不是三个按钮。

        原来的做法是三个独立控件并排（`gap-2` 摆一个 Select、一个 Input、一颗 Button），
        三个圆角边框各自为政，连起来看就是「三个按钮」，而它其实是一句话：**用 GET 请求这个地址**。

        所以外壳只留**一圈**边框一个圆角（`h-8 rounded-md border border-input shadow-xs`，
        与 `Input` / `SelectTrigger` 的 `sm` 档同值），里面三段全部去边框去圆角去阴影，靠
        `divide-x` 的 1px 竖线分隔 —— 形态与「一个输入框里有几段」一致。

        ⚠️ 三条硬要求，缺一个就露馅：
        ① **三段同高**。外壳 `h-8`，内层一律 `h-full`（SelectTrigger 的 `data-[size=sm]:h-8`
           被 `h-full` 覆盖成同一高度）—— 差 1px 就会在接缝处露出一截底色。
        ② **焦点态画在外壳上**（`focus-within:border-ring`）。内层都去掉了自己的描边，
           再各自画焦点就会在内侧多出一圈框、又变回「三个」。`focus-within` 的经典坑是
           **点在外壳内层自己身上也触发**（这里只有内层，没有 padding 区），所以拿掉即可。
        ③ **发送那颗的圆角要贴外壳的右下角**（`rounded-r-md` + `-mr-px -my-px`）：它是
           `variant=default` 的实心块，正方形盖在外壳圆角上会露出四个尖角。

        `gap-2` 换成 `divide-x` 之后整条更紧凑，窄屏（手机）上地址列能多让出 16px。
      */}
      <div ref={reqRowRef} className="shrink-0 px-3 py-2">
        <div className="flex h-8 items-stretch divide-x divide-border overflow-hidden rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring">
          {/* 方法：宽度按 4 个选项里最长的 `DELETE` 给足（`w-[5.25rem]`），免得选中它时整条抖一下 */}
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger
              size="sm"
              icon={false}
              className="h-full w-[5.25rem] shrink-0 justify-center rounded-none border-0 bg-transparent px-2 font-medium shadow-none dark:bg-transparent dark:hover:bg-transparent border-r"
              aria-label="请求方法"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHOD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={url}
            onChange={onUrlChange}
            placeholder="请求地址，如 https://api.example.com/users"
            className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent font-mono text-xs shadow-none dark:bg-transparent"
          />
          {/* 请求进行中时同一颗按钮切换为「取消」：点它中断请求（Ctrl+Enter 同效） */}
          {sending ? (
            <Button
              size="sm"
              variant="destructive"
              className="-my-px -mr-px h-auto shrink-0 rounded-none rounded-r-md"
              title="取消请求（Ctrl+Enter）"
              onClick={cancelSend}
            >
              <X className="size-4" />
              取消
            </Button>
          ) : (
            <Button
              size="sm"
              className="-my-px -mr-px h-auto shrink-0 rounded-none rounded-r-md"
              title="发送（Ctrl+Enter）"
              onClick={() => void send()}
            >
              <Send className="size-4" />
              发送
            </Button>
          )}
        </div>
      </div>

      {/*
        请求构造区（overflow-hidden：被压扁时裁掉内容，不要溢出去糊在响应面板上）。

        整块就是一棵 Radix Tabs：切换项是 `TabsList` / `TabsTrigger`，三个面板是
        `TabsContent`（由 Radix 负责「只挂当前那个」—— 与原先 `reqTab === 'x' && …`
        的卸载行为一致，不会多留一份 Monaco 在背后）。`gap-0` 压掉 Tabs 根自带的
        `gap-2`，否则标题行与面板之间会凭空多出一条缝。
      */}
      <Tabs
        value={reqTab}
        onValueChange={(value) => setReqTab(value as ReqTab)}
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
      >
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5">
          <TabsList>
            {REQ_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent
          value="headers"
          className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-3"
        >
          {/* 补全候选直接喂给表格（它自己用 Popover 画下拉）—— 不用 `<datalist>`：
              原生那个列表由浏览器 / 系统绘制，跟主题和表格观感都对不上。
              名称列固定给常见头名；值列按**该行的头名**算（见 headerValueSuggestions）。 */}
          <KeyValueTable
            rows={headers}
            keyPlaceholder="名称，如 Content-Type"
            valuePlaceholder="值，如 application/json"
            keySuggestions={() => COMMON_HEADERS}
            valueSuggestions={(h) => headerValueSuggestions(h.key) ?? []}
            onPatch={patchHeader}
            onRemove={removeHeader}
          />
        </TabsContent>

        <TabsContent value="params" className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-3">
          <KeyValueTable
            rows={params}
            keyPlaceholder="参数名"
            valuePlaceholder="参数值"
            onPatch={patchParam}
            onRemove={removeParam}
          />
        </TabsContent>

        {/* 请求体：面板内部**再嵌一层 Tabs**（形态切换）。Radix 的 Tabs 可以嵌套 ——
            两层各有各的 value / onValueChange，上下文互不干扰（别把内层提到外层去，
            那样「请求头」也会跟着显示请求体的形态条） */}
        <TabsContent value="body" className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <Tabs
            value={bodyType}
            onValueChange={(value) => changeBodyType(value as ApiBodyType)}
            className="flex h-full min-h-0 flex-col gap-0"
          >
            {/*
              请求体形态；GET/HEAD 的提醒不额外占一行，靠发送时空 body 兜底。

              四个形态并排，`x-www-form-urlencoded` 在手机端（根字号 18px）一个就顶掉近
              180px，四个加起来必然溢出屏宽（用户报过）。两条一起上：
              ① 窄屏换短标签（`md` 断点互斥的两段 span，见 `BODY_TYPE_OPTIONS`）；
              ② 外面再套一层横向滚动兜底 —— 标签再长、屏再窄也只是这条自己横滑，
                 绝不把面板顶宽、更不会溢到响应区上去。
            */}
            <div className="flex shrink-0 items-center py-2">
              {/* 滚动层写成 `flex`：`TabsList` 自带 `inline-flex`，放在块级滚动容器里会变成一个
                  行内盒 —— 行盒会在它下面多留几像素的字形下沉空间（上下留白不对称，一眼能看出
                  分段条没居中）。`flex` 把它块化，顺带压掉这点空隙；`overflow-x-auto` 照旧生效
                  （子项 `min-width: auto` 不会缩到内容宽度以下，所以是「容器滚」而不是「挤扁」）。 */}
              <div className="flex min-w-0 flex-1 overflow-x-auto no-scrollbar">
                <TabsList>
                  {BODY_TYPE_OPTIONS.map((option) => (
                    <TabsTrigger key={option.value} value={option.value}>
                      {/* 两段互斥（`md` 之上用完整名、之下用短名）。用两段 span 而不是 JS
                          判宽度：断点判定交给 CSS，首帧就不会闪一下长标签再收回来。 */}
                      <span className="md:hidden">{option.shortLabel}</span>
                      <span className="hidden md:inline">{option.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>

            <TabsContent
              value="none"
              className="min-h-0 flex-1 overflow-auto pt-1 text-xs text-muted-foreground"
            >
              不携带请求体：发送时不带 body（请求头里的 Content-Type 原样保留）。
            </TabsContent>

            <TabsContent value="raw" className="min-h-0 flex-1 overflow-hidden">
              <MonacoEditor
                value={body}
                onChange={setBody}
                language={bodyLanguage}
                onLanguageChange={setBodyLanguage}
                showLanguageSelector
                showLineNumbersToggle
                showWordWrapToggle
                showCopyButton
              />
            </TabsContent>

            {/* 两张表单与「请求头」同款：末行恒为空槽位（见 tidyFormRows） */}
            <TabsContent value="x-www-form-urlencoded" className="min-h-0 flex-1 overflow-auto">
              <KeyValueTable
                rows={urlencoded}
                keyPlaceholder="参数名"
                valuePlaceholder="参数值"
                onPatch={patchUrlencoded}
                onRemove={removeUrlencoded}
              />
            </TabsContent>

            <TabsContent value="form-data" className="min-h-0 flex-1 overflow-auto">
              <KeyValueTable
                rows={formFields}
                keyPlaceholder="字段名，如 file"
                valuePlaceholder="字段值（上面的类型选「文件」可上传本地文件）"
                // 「类型」列：换类型时值一起清掉 —— 文本值当文件名用必然对不上，反之亦然
                kindOf={(f, i) => ({
                  value: f.isFile ? 'file' : 'text',
                  onChange: (v) =>
                    patchFormField(i, {
                      isFile: v === 'file',
                      value: '',
                      fileName: undefined,
                      dataBase64: undefined
                    })
                })}
                renderValue={(f, i) =>
                  f.isFile ? <FileValueCell field={f} onPick={() => pickFormFile(i)} /> : null
                }
                onPatch={patchFormField}
                onRemove={removeFormField}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      {/* 拖拽条：调整响应面板高度。**常驻**（只在面板折叠时隐藏）。
          touch-none 必带：少了它手机上手指一动就被浏览器当成滚动手势抢走（见 useDragResize）。
          热区窄屏放宽到 16px（-my-2 h-4），负 margin 抵成净占位 0；sm 以上回到 8px。 */}
      {!respCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整响应面板高度"
          className="group/res relative z-20 -my-2 h-4 shrink-0 cursor-row-resize touch-none select-none [-webkit-touch-callout:none] sm:-my-1 sm:h-2"
          title="拖动调整响应面板高度"
          onPointerDown={startResize}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/res:bg-primary" />
        </div>
      )}

      {/*
        响应区：高度由上面的分隔条拖动决定。

        ⚠️ 标题行**恒为「响应」**，`响应体 / 响应头` 的 TabsList 放在面板内容里 —— 别把
        切换项挪回标题行：有没有响应会让同一块区域在「一行字」和「一排 tab」之间变形，
        看起来像整块面板被替换掉了。标题行只放「这次响应是什么样」（状态码 / 耗时 / 大小 /
        内容类型），正文的两种视图在下面的面板里切。
      */}
      <div
        className="flex shrink-0 flex-col gap-0 overflow-hidden bg-background"
        style={respCollapsed ? undefined : { height: Math.round(resRatio * 100) + '%' }}
      >
        {/*
          高度必须**定死**：状态码那枚徽标带 `py-0.5`，自然高度比纯文字高 4px ——
          靠 `py-1.5` 撑的话，请求前后这一行会轻微跳一下。
        */}
        <div className="flex h-8 shrink-0 items-center gap-3 px-3 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">响应</span>
          {response && (
            <span className={cn('shrink-0 rounded px-1.5 py-0.5 font-medium', statusClass(response.status))}>
              {response.status} {response.statusText}
            </span>
          )}
          {response && <span className="text-muted-foreground">{response.timeMs} ms</span>}
          {response && (
            <span className="text-muted-foreground">{formatBytes((response.body || '').length)}</span>
          )}
          {contentType && (
            <span className="truncate text-muted-foreground" title={contentType}>
              {contentType}
            </span>
          )}
          {error && <span className="text-destructive">错误：{error}</span>}
          <button
            type="button"
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={respCollapsed ? '展开响应面板' : '折叠响应面板'}
            onClick={() => setRespCollapsed((v) => !v)}
          >
            {respCollapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>

        {!respCollapsed &&
          (response ? (
            <Tabs
              value={resTab}
              onValueChange={(value) => setResTab(value as 'body' | 'headers')}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <div className="flex shrink-0 items-center px-3 pb-1.5">
                <TabsList>
                  <TabsTrigger value="body">响应体</TabsTrigger>
                  <TabsTrigger value="headers">
                    响应头{respHeaders.length ? ` (${respHeaders.length})` : ''}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="body" className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
                <div className="h-full overflow-hidden">
                  {/* 响应体用 Monaco：自带格式化按钮（工具栏的「代码」图标） */}
                  <MonacoEditor
                    value={respBody}
                    onChange={setRespBody}
                    language={respLang}
                    showLanguageSelector
                    showCopyButton
                  />
                </div>
              </TabsContent>

              <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                {respHeaders.length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无响应头。</div>
                ) : (
                  /*
                    响应头也是「两列表格」，跟请求头 / 参数一样要能在窄屏横拖（手机屏上
                    `w-56` 的头名列 + 值列必然超出屏宽）。计数行与所有行包在**同一个**
                    滚动层里，横拖时计数不会跟着错位。
                  */
                  <div className="min-w-0 overflow-x-auto">
                    <div className="flex w-full min-w-[30rem] flex-col">
                      <div className="pb-1 text-[0.6875rem] text-muted-foreground">
                        {respHeaders.length} 项
                      </div>
                      {/* 响应头是只读产物，用户要拿它去别处排查 —— 所以**每一格都要能选中**：
                          `styles.css` 里 `body { user-select: none }` 让正文默认禁选，不给
                          `data-selectable` 的话连拖选一段都做不到（这不是「顺手加」，是必须）。
                          复制走浏览器原生选中 + Ctrl/Cmd+C，不另做复制按钮。 */}
                      {respHeaders.map(([k, v]) => (
                        <div
                          key={k}
                          className="flex items-start gap-3 border-b border-border/40 py-1"
                        >
                          <span
                            data-selectable
                            className="w-56 shrink-0 break-all font-mono text-xs text-muted-foreground"
                          >
                            {k}
                          </span>
                          <span data-selectable className="min-w-0 flex-1 break-all font-mono text-xs">
                            {v}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          ) : (
            <div className="px-3 pb-3 text-xs text-muted-foreground">
              发送请求后在此查看响应（状态码、耗时与正文）。
            </div>
          ))}
      </div>
    </div>
  )
}