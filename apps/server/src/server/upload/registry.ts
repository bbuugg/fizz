/**
 * 上传源的运行时目录：内置 `local` + **插件通过 `ctx.uploads` 注册的**上传源。
 *
 * ## 为什么是「长驻 context」而不是 turn context
 *
 * 上传发生在**还没有回合**的时候：用户先选文件、传完才发消息。而 `chat-turn.ts` 里那套
 * turn context 是每轮对话现建的（挂着审批回调 / requestId 等回合资源）。所以插件在这里
 * 要挂到一个**按项目长驻**的 context 上，与 `inspectPluginUi` 的临时 context 不同 ——
 * 它活到下一次重建为止。
 *
 * 重建时机：插件目录源码变了（按递归路径 + mtime + size 指纹）。这样「编辑插件 → 下一次上传
 * 即新代码」，与对话侧的热重载行为一致，不必重启服务端。
 *
 * ## 归属校验（安全边界）
 *
 * 插件 `put` 交回来的 URL **必须**落在它自己声明的 `urlPrefixes` 内，否则整条丢弃。
 * 见 `@fizz/plugin` 的 `UploadProviderSpec` 注释 —— 这是防止插件把附件指到任意域名的
 * 第一道闸；第二道是「已签发 URL」表（`trust.ts`）。
 */
import {
  HooksService,
  PromptService,
  ToolsService,
  UiService,
  UploadsService,
  ModelsService,
  createAppContext,
  matchesUploadPrefix,
  normalizeUploadPrefix,
  type Context,
  type UploadProviderRegistration,
  type UploadPutInput
} from '@fizz/plugin'
import { loadPlugins } from '@fizz/plugin/loader'
import { UPLOAD_ALLOWED_MIME, UPLOAD_MAX_BYTES } from '@fizz/contracts/agent-api'
import {
  discoverServerPlugins,
  pluginFingerprint,
  withRuntimeConfig
} from '@/lib/server/plugin-roots'
import { resolveUploadAdapter } from './adapters'

/** 内置上传源的 id（前端不传 provider 时用它） */
export const BUILTIN_UPLOAD_PROVIDER_ID = 'local'

/** 给前端看的形状（`GET /api/uploads/providers`） */
export interface UploadProviderView {
  id: string
  title: string
  /** 允许的 MIME 精确集合（前端据此放宽本地预校验） */
  acceptMime: string[]
  maxBytes: number
  /** false = 不出现在选择器里（插件只想被显式指定） */
  selectable: boolean
  /** 缺省上传源（不传 provider 时用它） */
  isDefault: boolean
  source: 'builtin' | 'plugin'
  /** 人可读来源（插件名 / 'builtin'） */
  sourceName: string
}

/** 内部形态：视图 + 真正干活的两件事 */
interface ResolvedProvider extends UploadProviderView {
  put(input: UploadPutInput): Promise<{ url: string }>
  /** `put` 交回来的 URL 是否在它自己的声明范围内（内置走适配器的 owns()） */
  ownsGeneratedUrl(url: string): boolean
  resolveModelUrl?: (url: string, origin: string) => string
  /** 丢弃「已 put 成功、但结果没人要」的附件时用来清理；缺省 = 不支持删除 */
  remove?: (url: string) => Promise<void>
  /** 声明的前缀（内置为空：它的地址是相对路径，靠 owns() 判） */
  urlPrefixes: string[]
}

/** `put` 的超时上限（第三方上传可能吊死；超时按失败处理，别把请求挂住） */
const PUT_TIMEOUT_MS = Number(process.env.FIZZ_UPLOAD_TIMEOUT_MS ?? 120_000)

/**
 * 「这次上传是客户端能自己改的」—— 未知上传源 / 类型不支持 / 太大。
 * 路由据此回 400 而不是 500（其余情况是上游或插件的问题，回 500）。
 */
export class UploadRequestError extends Error {}

interface CacheEntry {
  /** 插件清单指纹（文件路径 + 大小 + mtime + 启用态）；变了就重建 */
  fingerprint: string
  ctx: Context
  providers: ResolvedProvider[]
  byId: Map<string, ResolvedProvider>
}

/** key = workspaceId（'' = 只有插件可用，比如没带 workspaceId 的上传请求） */
const cache = new Map<string, CacheEntry>()

/**
 * 内置上传源：落数据目录的 `uploads/`，对外是相对 `/api/uploads/<uuid>.<ext>`。
 *
 * 刻意走 `resolveUploadAdapter()`（而不是直接 new `LocalUploadAdapter`）：`FIZZ_UPLOAD_BACKEND`
 * 配了别的实现时，走内置源的上传也该落到那个实现上 —— 不能因为插件这套进来就把它悄悄架空。
 */
function builtinProvider(): ResolvedProvider {
  const adapter = resolveUploadAdapter()
  return {
    id: adapter.id,
    title: '内置存储',
    acceptMime: [...UPLOAD_ALLOWED_MIME],
    maxBytes: UPLOAD_MAX_BYTES,
    selectable: true,
    isDefault: true,
    source: 'builtin',
    sourceName: 'builtin',
    urlPrefixes: [],
    put: (input) => adapter.put(input),
    ownsGeneratedUrl: (url) => adapter.owns(url),
    resolveModelUrl: (url, origin) => adapter.resolveModelUrl(url, origin),
    ...(adapter.remove ? { remove: (url: string) => adapter.remove!(url) } : {})
  }
}

/** 插件注册项 → 内部形态。没声明 accept 的按契约白名单 + 10MB 兜底 */
function resolvePluginProvider(reg: UploadProviderRegistration): ResolvedProvider {
  const prefixes = reg.urlPrefixes.map(normalizeUploadPrefix)
  return {
    id: reg.id,
    title: reg.title,
    acceptMime: reg.accept.mime.length ? [...reg.accept.mime] : [...UPLOAD_ALLOWED_MIME],
    maxBytes: reg.accept.maxBytes ?? UPLOAD_MAX_BYTES,
    selectable: reg.selectable,
    isDefault: false,
    source: 'plugin',
    sourceName: reg.source,
    urlPrefixes: prefixes,
    put: (input) => reg.put(input),
    ownsGeneratedUrl: (url) => matchesUploadPrefix(url, prefixes),
    resolveModelUrl: reg.resolveModelUrl,
    ...(reg.remove ? { remove: (url: string) => reg.remove!(url) } : {})
  }
}

/**
 * 发现插件：与对话侧**同一份组装规则**（`discoverServerPlugins`）—— 内置、项目级、用户级
 * 都在内，启停按来源分开。两处各写一遍的话，早晚出现「对话里能用的上传源，上传时找不到」。
 */
async function discoverFor(workspaceId?: string, workspacePath?: string) {
  return discoverServerPlugins({ workspaceId, workspacePath })
}

/**
 * 取该项目（不传 = 只用插件）的上传源清单。命中缓存直接返回；插件文件变了就重建
 * （先 `dispose()` 旧的：插件在长驻 context 上登记的监听器 / effect 一并回收）。
 *
 * 同一 key 的**并发请求共用一次构建**（`pending`）：多选文件会同时打几个上传请求，
 * 不串行化的话它们会各建一个 context，后来的把前一个 `dispose()` 掉 —— 正在飞的那次
 * `put` 虽然还能跑完（`put` 已经被取出来了），但这种「自己拆自己」的状态不该出现。
 */
const pending = new Map<string, Promise<CacheEntry>>()

async function ensureEntry(workspaceId?: string, workspacePath?: string): Promise<CacheEntry> {
  const key = workspaceId ?? ''
  const inflight = pending.get(key)
  if (inflight) return inflight
  const task = buildEntry(key, workspaceId, workspacePath).finally(() => {
    pending.delete(key)
  })
  pending.set(key, task)
  return task
}

async function buildEntry(
  key: string,
  workspaceId?: string,
  workspacePath?: string
): Promise<CacheEntry> {
  const descriptors = await discoverFor(workspaceId, workspacePath)
  // 指纹含**插件文件**与**设置页里填的值**：任一变了就重建 —— 在设置里填完 token
  // 立刻能用，不必重启（见 pluginFingerprint 的说明）
  const fingerprint = await pluginFingerprint(descriptors)
  const cached = cache.get(key)
  if (cached && cached.fingerprint === fingerprint) return cached

  const ctx = createAppContext(`upload:${key || 'global'}`)
  // 插件可能 `inject` 任意内建服务名。四个都给上，否则那些插件会被**推迟挂载**，
  // 它注册的上传源就永远不出现（与 inspectPluginUi 同一个取舍）。
  ctx.set('tools', new ToolsService(ctx))
  ctx.set('prompt', new PromptService(ctx))
  ctx.set('hooks', new HooksService(ctx))
  ctx.set('ui', new UiService(ctx))
  const uploads = new UploadsService(ctx)
  ctx.set('uploads', uploads)
  // 避免顶层 `inject: ['models']` 的插件在这份长驻 context 里被推迟（与 inspect 同理）
  ctx.set('models', new ModelsService(ctx))

  const builtin = builtinProvider()
  const providers: ResolvedProvider[] = [builtin]
  const byId = new Map<string, ResolvedProvider>([[builtin.id, builtin]])

  // 挂载前合上运行时配置（plugins.yml + 设置页里填的值）——插件在 apply 里读 `config.xxx`
  const { loaded, errors } = await loadPlugins(withRuntimeConfig(descriptors.filter((d) => d.enabled)))
  for (const err of errors) console.warn('[upload] 插件加载失败（它的上传源不可用）：', err)
  for (const item of loaded) {
    try {
      ctx.plugin(item.plugin, item.config)
    } catch (err) {
      // 单个插件 apply 抛错（如 register 形状校验失败）不该拖垮别的上传源
      console.warn(`[upload] 插件 apply 失败（已跳过）：${item.id}`, err)
    }
  }

  for (const reg of uploads.list()) {
    if (byId.has(reg.id)) {
      console.warn(`[upload] 上传源 id 与已有的重名，已忽略插件注册的「${reg.id}」`)
      continue
    }
    const resolved = resolvePluginProvider(reg)
    providers.push(resolved)
    byId.set(resolved.id, resolved)
  }

  if (cached) await cached.ctx.dispose().catch(() => {})
  const entry: CacheEntry = { fingerprint, ctx, providers, byId }
  cache.set(key, entry)
  return entry
}

/**
 * 主动作废上传源缓存（**安装 / 卸载插件**时调）。
 *
 * 平时它靠指纹重建（文件 / 启用态 / 设置值任一变了就重建），但重建**只在下次有人
 * 请求时**才发生 —— 插件已经卸载了，它提供的上传源却还挂在「传到哪儿」下拉里，
 * 直到下一次上传才消失；插件在长驻 context 上登记的监听器也要到那时才回收。
 * 装 / 卸之后立刻调一下，两件事都当场完成。
 *
 * 不传 workspaceId = 只清「只有插件」那一份（与 `cache` 的 key 语义一致）。
 */
export async function invalidateUploadProviders(workspaceId?: string): Promise<void> {
  const key = workspaceId ?? ''
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  // 顺序很重要：先摘出缓存，再 dispose —— 正在飞的那次 put 仍持有 provider，能跑完；
  // 而 dispose 期间若有人来取，会直接建一个新的，不会撞到正在回收的这个
  await entry.ctx.dispose().catch(() => {})
}

/** 给前端与上传路由用的清单（顺序 = 内置在前，插件按注册顺序） */
export async function getUploadProviders(opts: {
  workspaceId?: string
  workspacePath?: string
}): Promise<UploadProviderView[]> {
  const entry = await ensureEntry(opts.workspaceId, opts.workspacePath)
  return entry.providers.map(({ put: _put, ownsGeneratedUrl: _owns, resolveModelUrl: _r, remove: _rm, urlPrefixes: _p, ...view }) => view)
}

/** 解析出这次要用哪个上传源：显式 id 优先，缺省 = `isDefault` 那个（内置） */
async function pickProvider(
  opts: { workspaceId?: string; workspacePath?: string; providerId?: string }
): Promise<ResolvedProvider> {
  const entry = await ensureEntry(opts.workspaceId, opts.workspacePath)
  if (opts.providerId) {
    const found = entry.byId.get(opts.providerId)
    if (!found) {
      throw new UploadRequestError(
        `未知的上传源「${opts.providerId}」（可用：${[...entry.byId.keys()].join('、')}）`
      )
    }
    return found
  }
  const fallback = entry.providers.find((p) => p.isDefault) ?? entry.providers[0]
  if (!fallback) throw new UploadRequestError('没有任何可用的上传源')
  return fallback
}

/**
 * 走指定上传源落一条 URL。三件事都在这里做，调用点别各写一遍：
 * 1. 类型 / 大小按**该上传源**的 accept 判（内置 = 契约白名单 + 10MB）；
 * 2. `put` 带超时（第三方服务吊死不该把请求挂住）；
 * 3. `put` 交回来的 URL 必须落在它自己声明的 `urlPrefixes` 内 —— **fail-closed**：
 *    不在范围内的整条丢弃。没这道闸，一个写错的插件就能把附件指到任意域名。
 */
export async function putWithProvider(opts: {
  workspaceId?: string
  workspacePath?: string
  providerId?: string
  input: UploadPutInput
  signal?: AbortSignal
}): Promise<{ url: string; providerId: string }> {
  if (opts.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
  const provider = await pickProvider(opts)
  const { input } = opts

  if (!provider.acceptMime.includes(input.mediaType)) {
    throw new UploadRequestError(
      `上传源「${provider.title}」不支持 ${input.mediaType || '（缺失类型）'}（支持：${provider.acceptMime.join('、')}）`
    )
  }
  if (input.bytes.length === 0) throw new UploadRequestError('附件内容为空')
  if (input.bytes.length > provider.maxBytes) {
    throw new UploadRequestError(
      `附件超过该上传源的大小上限（${Math.round(provider.maxBytes / 1024 / 1024)}MB）`
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let rejectAbort: ((reason: DOMException) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => {
    controller.abort()
    rejectAbort?.(new DOMException('上传已取消', 'AbortError'))
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`上传超时（${PUT_TIMEOUT_MS}ms）`))
    }, PUT_TIMEOUT_MS)
    // 别让这颗定时器把进程钉住（Node 才有 unref）
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  let url: string
  try {
    if (opts.signal?.aborted) {
      controller.abort()
      throw new DOMException('上传已取消', 'AbortError')
    }
    const result = await Promise.race([
      provider.put({ ...input, signal: controller.signal }),
      timeout,
      ...(opts.signal ? [aborted] : [])
    ])
    url = typeof result?.url === 'string' ? result.url.trim() : ''
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }

  if (!url) throw new Error(`上传源「${provider.title}」没有返回 url`)
  if (!provider.ownsGeneratedUrl(url)) {
    throw new Error(
      `上传源「${provider.title}」返回的 URL 不在它声明的范围内，已拒绝：${url}` +
        `（声明：${provider.urlPrefixes.join('、') || '（无）'}）`
    )
  }
  /*
    取消恰好落在 put 返回之后：结果没人要。尽力清掉已经落盘的对象，否则它会成为
    「没有签发记录、也没人引用」的孤儿（远端存储尤其明显，本地也会一直堆文件）。
  */
  if (opts.signal?.aborted) {
    try {
      await provider.remove?.(url)
    } catch (err) {
      console.warn(`[upload] 取消后清理已上传对象失败：${url}`, err)
    }
    throw new DOMException('上传已取消', 'AbortError')
  }
  return { url, providerId: provider.id }
}

/**
 * 插件上传源的模型地址解析（**同步**，缺省 = 原样返回）。
 *
 * 为什么是同步：附件转模型消息（`model-messages.ts`）发生在每轮装配里，不能为一条 URL
 * 去 await 插件加载。所以这里查的是「上一份清单」（重建时替换）—— 对插件来说意味着
 * 「改了 `resolveModelUrl` 后，最迟下一次上传 / 下一次清单重建生效」。
 *
 * 返回 null = 没有任何插件认领这条 URL（内置存储与绝对公网地址都走这条），调用方自行兜底。
 * 刻意不 import `./index`（那边要 import 本文件）：避免两个模块互相引用。
 */
export function pluginModelUrlResolver(url: string, origin: string): string | null {
  for (const entry of cache.values()) {
    for (const provider of entry.providers) {
      if (provider.source !== 'plugin') continue
      if (provider.resolveModelUrl && matchesUploadPrefix(url, provider.urlPrefixes)) {
        return provider.resolveModelUrl(url, origin)
      }
    }
  }
  return null
}
