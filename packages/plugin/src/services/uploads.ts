/**
 * 上传源注册表：`ctx.uploads` 的实体。**这是插件给「文件上传」换实现的唯一入口。**
 *
 * 为什么要有它：上传的目标本来写死在服务端（`UploadAdapter` 的 `local`，落数据目录再
 * 由 `/api/uploads/<name>` 公开服务）。想换成自建图床 / S3 / 对象存储 / 内网服务时，
 * 只能改服务端源码。这里把「把字节落成一条 URL」抽成一个插件可注册的能力，插件注册完，
 * 对话附件就用它 —— **最终给到输入框的始终只是一条 url**，与存储在哪无关。
 *
 * ## 契约只有一句话：`put` 交出 URL，且这条 URL 必须落在你**自己声明**的 `urlPrefixes` 里
 *
 * 服务端在 `put` 返回后会**立刻**用 `matchesUploadPrefix` 校验返回值，不在声明范围内就
 * 整条丢弃并报错（fail-closed）。原因：附件 URL 是**直传**给模型的（`ImagePart` /
 * `FilePart` 里就是这条地址，服务端不下载、不校验），插件若返回一个任意地址，等于让模型
 * 去取那个地址。声明出来才看得见、才拦得住，也就没法悄悄把附件指到别的域名上。
 *
 * 每条成功签发的 URL 还会被服务端记进「已签发」表（持久化），所以：
 * - 服务端重启后，历史消息里的附件引用**仍然**能通过校验；
 * - 但**没走过一次真实上传**的 URL 一律进不来（手编一条 URL 注进历史 = 400）。
 *
 * ## 生效范围
 *
 * 上传发生在「还没有回合」的时候（用户先选文件、后发消息），所以注册表挂在**长驻 context**
 * 上（每项目一个），不是 turn context —— 与 `ctx.tools` 每轮重建不同。插件文件改了会在
 * 下一次上传时重新 apply（服务端按 mtime + size 判断）。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose } from '../types'
import type { ToolOrigin } from './tools'

/** 这个上传源收什么文件（缺省 = 契约的图片 + PDF 白名单与 10MB 上限） */
export interface UploadProviderAccept {
  /** 允许的 MIME **精确集合**（不是前缀通配） */
  mime: string[]
  /** 单文件字节上限；缺省 = 契约的 `UPLOAD_MAX_BYTES` */
  maxBytes?: number
}

/** `put` 的入参 */
export interface UploadPutInput {
  /** 原始文件名（只用于展示 / 传给上游；不参与本地落盘路径） */
  name: string
  mediaType: string
  bytes: Uint8Array
  /** 上传被用户取消或请求断开时触发；异步上传源应尽快中止上游请求并清理临时数据。 */
  signal?: AbortSignal
  /** 当前项目根目录（项目级插件按它分流；用户级插件一般用不到） */
  workspacePath?: string
}

export interface UploadProviderSpec {
  /** 唯一 id：进上传请求的 `provider` 字段与附件引用，一旦用上别改 */
  id: string
  /** 选择器里的显示名；缺省 = id */
  title?: string
  /**
   * 本上传源会产出的 URL 前缀白名单（**至少一条**）。
   * 必须 https（`http://localhost` / `http://127.0.0.1` 例外，给本地服务留口），
   * 允许带路径前缀（如 `https://cdn.example.com/fizz`），末尾斜杠会被归一并忽略。
   */
  urlPrefixes: string[]
  /** 收什么文件；缺省 = 契约白名单 + 10MB */
  accept?: UploadProviderAccept
  /** `false` = 不在前端选择器里出现（只想被显式指定时用）；缺省 = 出现 */
  selectable?: boolean
  /**
   * 落存储并返回对外 URL。抛错 = 这次上传失败（错误原话会回给用户）。
   * 若有 `input.signal`，应在取消时中止上游请求并清理未完成的远端对象。
   */
  put(input: UploadPutInput): Promise<{ url: string }>
  /**
   * 交给模型的绝对地址；缺省 = 原样返回（返回公网 https 的适配器不用实现它）。
   * 只有「存的是相对地址、或需要拼临时签名」的适配器才需要。
   */
  resolveModelUrl?(url: string, origin: string): string
}

/** 归一化后的注册项（服务端读这份） */
export interface UploadProviderRegistration {
  id: string
  title: string
  urlPrefixes: string[]
  accept: UploadProviderAccept
  selectable: boolean
  put(input: UploadPutInput): Promise<{ url: string }>
  resolveModelUrl?: (url: string, origin: string) => string
  /** 越大越优先；同名冲突时**只认第一条**（见 register 的说明） */
  priority: number
  origin: ToolOrigin
  /** 人可读的来源标识（插件名 / 'builtin'），冲突告警与设置页展示用 */
  source: string
}

export interface RegisterUploadProviderOptions {
  priority?: number
  origin?: ToolOrigin
  source?: string
}

/** http 只给本机留口（本地跑一个最小图床的开发场景） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * 归一化一条 URL 前缀：去空白与末尾斜杠，并要求是 https（或本机 http）、不带 query / hash。
 *
 * 导出是为了让服务端用**同一份**规则校验 `put` 的返回值 —— 判定规则只有一份，两端才不会漂。
 */
export function normalizeUploadPrefix(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('urlPrefixes 里有一条空字符串')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`urlPrefixes 里的「${raw}」不是合法 URL（要写成 https://主机[/路径]）`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`urlPrefixes 必须用 https（http 只允许 localhost / 127.0.0.1）：「${raw}」`)
  }
  if (url.search || url.hash) {
    throw new Error(`urlPrefixes 不能带 query / hash（它是一条前缀，不是一条具体地址）：「${raw}」`)
  }
  return trimmed
}

/**
 * 这条 URL 是否落在声明的前缀内。**按 `/` 边界比较**，避免 `https://a.com` 命中
 * `https://a.com.evil.net`（前缀匹配最经典的坑）。
 */
export function matchesUploadPrefix(url: string, prefixes: readonly string[]): boolean {
  if (!url) return false
  return prefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}

export class UploadsService extends Service {
  private readonly _byId = new Map<string, UploadProviderRegistration>()
  /** 首次出现的 id 顺序，`list()` 按它输出（选择器里顺序稳定） */
  private readonly _order: string[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'uploads'
  }

  /**
   * 注册一个上传源，返回 disposer（随插件 fiber 卸载）。
   *
   * 形状不对（缺 id / 没声明 urlPrefixes / `put` 不是函数）**当场抛错**：装配期大声报错，
   * 远好过用户点了上传才发现「选了文件什么都没发生」。
   *
   * ⚠️ 与 `ToolsService` 刻意不同：**id 冲突不做覆盖、也不按 priority 抢**，只保留先注册的
   * 那个并告警。理由是这里的失败面太大 —— 上传是整条附件链路的入口，谁盖谁都不该是
   * 「静默生效」的（内置 `local` 尤其不该被悄悄顶掉）。
   */
  register(spec: UploadProviderSpec, opts: RegisterUploadProviderOptions = {}): Dispose {
    const id = typeof spec?.id === 'string' ? spec.id.trim() : ''
    if (!id || /\s/.test(id)) {
      throw new Error(`上传源 id 非法（来源 ${opts.source ?? 'unknown'}）：要是非空、不含空白的字符串`)
    }
    if (typeof spec.put !== 'function') {
      throw new Error(`上传源「${id}」没有 put 方法（来源 ${opts.source ?? 'unknown'}）：put 必须是返回 { url } 的异步函数`)
    }
    if (!Array.isArray(spec.urlPrefixes) || spec.urlPrefixes.length === 0) {
      throw new Error(
        `上传源「${id}」必须声明 urlPrefixes（来源 ${opts.source ?? 'unknown'}）：` +
          '至少一条 https 前缀，服务端据此校验 put 交回来的 URL 有没有跑出你自己的域名'
      )
    }
    const urlPrefixes = spec.urlPrefixes.map(normalizeUploadPrefix)
    const mime = spec.accept?.mime
    if (mime && (!Array.isArray(mime) || mime.length === 0 || mime.some((m) => typeof m !== 'string'))) {
      throw new Error(`上传源「${id}」的 accept.mime 必须是非空字符串数组（来源 ${opts.source ?? 'unknown'}）`)
    }

    const reg: UploadProviderRegistration = {
      id,
      title: spec.title?.trim() || id,
      urlPrefixes,
      accept: { mime: mime ?? [], maxBytes: spec.accept?.maxBytes },
      selectable: spec.selectable !== false,
      put: spec.put.bind(spec),
      resolveModelUrl: spec.resolveModelUrl?.bind(spec),
      priority: opts.priority ?? 0,
      origin: opts.origin ?? 'plugin',
      source: opts.source ?? 'unknown'
    }

    const existing = this._byId.get(id)
    if (existing) {
      // 不覆盖、不抛错（抛错会把整条上传链路带停）：保留先注册的，大声告警
      this.ctx.logger.warn(
        `[uploads] 上传源 id 冲突：「${id}」已被 ${existing.source} 注册，忽略这次来自 ${reg.source} 的注册`
      )
      return () => {}
    }
    this._byId.set(id, reg)
    this._order.push(id)
    return this.bind(() => {
      if (this._byId.get(id) === reg) {
        this._byId.delete(id)
        const i = this._order.indexOf(id)
        if (i >= 0) this._order.splice(i, 1)
      }
    })
  }

  /** 全部注册项（按注册顺序） */
  list(): UploadProviderRegistration[] {
    return this._order.map((id) => this._byId.get(id)).filter((r): r is UploadProviderRegistration => !!r)
  }

  get(id: string): UploadProviderRegistration | undefined {
    return this._byId.get(id)
  }
}
