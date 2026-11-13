/**
 * 内置 web_fetch 工具：打开任意网页（含搜索结果页），抓取正文并整理成 AI 容易理解的
 * 结构化 Markdown。
 *
 * 两种抓取引擎（engine 参数切换）：
 * - `fetch`（默认）：用 Node 原生 fetch 直接取静态 HTML，更轻量、更快，但拿不到 JS 渲染后的内容；
 * - `browser`：用 Playwright 无头浏览器跑 JS 渲染（适合 SPA / 动态内容）。
 *
 * 设计要点：
 * - 只读 / 无副作用：不写文件、不改系统，任何权限模式下都可用，相当于「读一个网页」。
 *   （唯一例外：正文超长时会把**全文**落一份到工作区 `.fizz/tool-output/`，
 *   那是 Fizz 自己的缓存目录 —— 文件树与 git 都忽略它，且只有这样 read
 *   才能把中段读回来。见 output-log.ts 的形状说明。）
 * - 正文 HTML 用 turndown 转成 Markdown，链接单独列出便于 Agent 继续深挖；
 * - 输出有上限（默认 20000 字符），超长截断并标注，避免把整页塞爆上下文。
 * - playwright / turndown 都走动态 import：没装时返回清晰的可读错误，而不是让整轮崩掉。
 *
 * ## 超时与中止（用户点「停止」）语义
 *
 * 单次抓取永远有结论：`timeoutMs` 默认 30000、钳在 [1000, 60000]，两种引擎都吃它
 * （fetch 用 AbortController 定时 abort，browser 传给 `page.goto`）。
 * 用户点「停止」时 abortSignal 一路传到最底层：fetch 直接 abort 请求、browser 关页面。
 * 超时与主动中止返回**不同的文案**：模型据此知道是该换镜像 / 调大 timeoutMs，还是别重试。
 *
 * ## 不替用户下载浏览器
 *
 * `engine=browser` 需要 Playwright 的 headless shell（约 150MB）。这里**不再**调
 * `ensureChromiumReady()` 自愈下载：一次抓取背后悄悄挂上十分钟的下载，界面上没有任何
 * 进度，用户只知道「卡住了」；而且它会和「设置 → 浏览器」的安装任务抢同一次下载。
 * 运行时由设置页显式安装，没装就立刻返回一句能执行的话（改用 fetch 引擎 / 让用户去装），
 * 见 `BrowserRuntimeMissingError`。
 *
 * ## 没装浏览器 = 只有一个引擎
 *
 * 装没装**在装配期现读**（`browserRuntimeInfo().installed`）：没装时 schema 里**根本没有
 * `engine` 这个入参**，description 也只说 fetch。留着那个选项（哪怕回一句「没装，请改用
 * fetch」）等于给模型一个注定失败的分支 —— 它每轮都会先试一遍 browser 才死心，白烧步数、
 * 还把落空的失败信息灌进上下文。装好后下一轮装配自动带上（与 `chat-turn` 的 `browser_*`
 * 装配闸、工具条那颗开关同一判据）。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'
import { createLocalBackend } from './backend'
import { summarizeLongOutput } from './output-log'
import { browserRuntimeInfo } from './playwright-browsers'
import { abortableSleep, launchHeadlessChromium, pageErrorMessage } from './headless'

/**
 * 返回 Markdown 的正文默认上限（字符）。
 *
 * 取 8000 而不是更大的值：正文超过一个工具结果的预算时，`formatPage` 会把**全文**
 * 落盘并把开头结尾返回给模型（见 output-log.ts）—— 也就是说默认值给大了并不会让
 * 模型看到更多有用内容，只会让它在摘要之外还多背一段正文。真需要细读某一段时，
 * 模型可以按落盘文件的行号位置 read，或显式调大 maxChars 重抓。
 */
const DEFAULT_MAX_CHARS = 8_000
/** 最多列出的页面内链接条数 */
const MAX_LINKS = 50
/** 页面加载默认超时（毫秒） */
const DEFAULT_TIMEOUT = 30_000
/** fetch 路径下，用于 Markdown 转换的 HTML 最大字符数（防超大页撑爆内存 / 卡死） */
const MAX_HTML_CHARS = 3_000_000

/** 抓取结果（两种引擎共用，统一格式化） */
interface FetchedPage {
  title: string
  finalUrl: string
  markdown: string
  links: Array<{ text: string; href: string }>
}

/**
 * 浏览器内执行的裁剪逻辑（以字符串形式传给 page.evaluate，避免在 Node 侧引用 document 等 DOM 全局）。
 * 返回：标题、最终 URL（重定向后）、清洗后的正文 HTML、正文内链接。
 */
const BROWSER_EXTRACT = `
(() => {
  const noise = document.querySelectorAll(
    'script,style,noscript,svg,iframe,nav,footer,header,aside,form,.advert,.ads,.ad,.cookie,.banner,[role="banner"],[role="navigation"],[role="dialog"]'
  );
  noise.forEach((el) => el.remove());
  const root =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.body;
  const links = [];
  const seen = new Set();
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    const text = (a.textContent || '').trim();
    if (!/^https?:\\/\\//i.test(href)) return;
    if (seen.has(href) || !text) return;
    seen.add(href);
    links.push({ text: text.slice(0, 120), href });
  });
  return {
    title: document.title,
    url: location.href,
    html: root.innerHTML,
    links
  };
})()
`

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 解除常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 从原始 HTML 抽标题（拿不到返回空串） */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim())
}

/** 从原始 HTML 抽 http(s) 链接（绝对地址、去重、带可见文本） */
function extractLinks(html: string, base: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const raw = m[1].trim()
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    if (!text) continue
    // 先把相对地址解析成绝对地址（base 为最终 URL），再按协议过滤、去重
    let abs: string
    try {
      abs = new URL(raw, base).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue
    seen.add(abs)
    out.push({ text: text.slice(0, 120), href: abs })
  }
  return out
}

/** fetch 路径：用正则去掉对正文无价值的节点，避免 turndown 把它们转成噪声文本 */
function cleanHtmlForFetch(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
}

/** 把 HTML 转成 Markdown（动态引入 turndown，缺失时抛错由调用方转成可读提示） */
async function htmlToMarkdown(html: string): Promise<string> {
  let turndownMod: unknown
  try {
    turndownMod = await import('turndown')
  } catch {
    throw new Error(
      'turndown 未安装（HTML→Markdown 转换器）。请在服务器环境执行 `npm i turndown` 后重试。'
    )
  }
  const TurndownService = (turndownMod as { default?: unknown }).default ?? turndownMod
  const td = new (TurndownService as new (opts?: Record<string, unknown>) => {
    remove: (sel: string | string[]) => void
    turndown: (html: string) => string
  })({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'head', 'nav', 'footer', 'header', 'aside', 'form'])
  return td.turndown(html).trim()
}

/**
 * 把统一的 FetchedPage 整理成模型友好的字符串。
 *
 * 正文超过 `maxChars`（模型自己给的上限）或一个工具结果的预算时，整篇落盘到工作区的
 * `.fizz/tool-output/` 并回相对路径 + 行号 —— 抓来的长文档最该做的事就是「回头精读
 * 某一段」，而不是把中段直接扔掉（读回来要重抓一次，代价太大）。
 */
async function formatPage(
  p: FetchedPage,
  requestedUrl: string,
  clampedMax: number,
  backend: WorkspaceBackend | null
): Promise<string> {
  const clipped = p.markdown.length > clampedMax
  const md = clipped ? p.markdown.slice(0, clampedMax) : p.markdown
  const linkSection = p.links.length
    ? `\n\n## 页面内链接（前 ${Math.min(p.links.length, MAX_LINKS)} 条）\n` +
      p.links
        .slice(0, MAX_LINKS)
        .map((l) => `- [${l.text}](${l.href})`)
        .join('\n')
    : ''
  const header = `# ${p.title || '(无标题)'}\n源地址：${p.finalUrl}（抓取自 ${requestedUrl}）\n`
  const full = `${header}\n${md}${linkSection}`
  return summarizeLongOutput(full, {
    backend,
    tool: 'web_fetch',
    detail: p.finalUrl,
    extra: clipped
      ? `正文按你给的 maxChars=${clampedMax} 裁到了开头这段；想要更靠后的内容就用 read 的 offset/limit 翻落盘文件，或把 maxChars 调大（上限 100000）重抓。`
      : undefined
  })
}

/**
 * 缺运行时：**不是抓取失败**，所以走单独的类型，让 `execute` 回一段能执行的话
 * （改用 `engine="fetch"` / 让用户去设置里装），而不是「web_fetch 抓取 … 失败：Executable
 * doesn't exist」这种模型看了也不知道该干什么的报错。
 */
class BrowserRuntimeMissingError extends Error {
  constructor() {
    super('内置浏览器（Playwright headless shell）未安装')
    this.name = 'BrowserRuntimeMissingError'
  }
}

/** engine=browser：Playwright 无头浏览器跑 JS 后抓取 */
async function fetchByBrowser(
  target: URL,
  timeout: number,
  abortSignal?: AbortSignal
): Promise<FetchedPage> {
  // 没装就直接回话，**不下载**（见文件头「不替用户下载浏览器」）。判据与工具条那颗
  // 开关、`chat-turn` 的装配闸同源：都是 `browserRuntimeInfo().installed`。
  if (!browserRuntimeInfo().installed) throw new BrowserRuntimeMissingError()
  // launch 超时 + playwright 未安装的可读报错都收在 headless.ts
  const browser = await launchHeadlessChromium(timeout)
  try {
    const context = await browser.newContext({ userAgent: UA })
    const page = await context.newPage()
    // 用户中止时直接关掉页面，让挂起的 goto / evaluate 抛错退出
    abortSignal?.addEventListener(
      'abort',
      () => {
        page.close().catch(() => {})
      },
      { once: true }
    )
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout })
    // 给 SPA / 懒加载一点渲染时间（可中止：用户点停止时不必干等这 800ms）
    await abortableSleep(800, abortSignal)
    if (abortSignal?.aborted) {
      throw new Error('web_fetch 抓取已被用户中止（点了「停止」）。')
    }
    const data = (await page.evaluate(BROWSER_EXTRACT)) as {
      title: string
      url: string
      html: string
      links: Array<{ text: string; href: string }>
    }
    const markdown = await htmlToMarkdown(data.html)
    return { title: data.title, finalUrl: data.url, markdown, links: data.links }
  } finally {
    await browser?.close().catch(() => {})
  }
}

/** engine=fetch（默认）：Node 原生 fetch 取静态 HTML 后抓取 */
async function fetchByHttp(
  target: URL,
  timeout: number,
  abortSignal?: AbortSignal
): Promise<FetchedPage> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeout)
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const finalUrl = res.url || target.toString()
    let html = await res.text()
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS)
    const title = extractTitle(html)
    const links = extractLinks(html, finalUrl)
    const markdown = await htmlToMarkdown(cleanHtmlForFetch(html))
    return { title, finalUrl, markdown, links }
  } catch (err) {
    // fetch 被 abort 时只抛一句「This operation was aborted」，分不清是谁 abort 的。
    // 超时要能认出来：调用方据此告诉模型「换镜像 / 调大 timeoutMs，别原样重试」，
    // 而用户点停止则是另一句（直接收场）。
    if (timedOut) {
      throw new Error(`web_fetch fetch 超时（timeout ${timeout}ms 内未拿到响应）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * 构建 web_fetch 工具（返回单键 ToolSet，便于在 agent 端与其它工具合并）。
 *
 * `root` = 工作区根，只用于「正文过长时把全文落进 `.fizz/tool-output/`」——
 * 落在工作区内 read 才读得回来（数据目录在 resolveInside 边界外，见 output-log.ts）。
 */
/**
 * 单条抓取的停止钩子（与 `bash` 的 `onCommandStart/End` 同一形状）：
 * 登记 `toolCallId → 中止这一条的函数`，宿主据此让「停止」只停这一次抓取，整轮继续。
 */
export interface WebFetchStopHooks {
  onStart?: (toolCallId: string, stop: () => void) => void
  onEnd?: (toolCallId: string) => void
}

/** web_fetch 的入参形状（schema 按运行时条件构建，见下；这里只用来收窄 execute 的类型） */
interface WebFetchInput {
  url: string
  engine?: 'browser' | 'fetch'
  timeoutMs?: number
  maxChars?: number
}

export function buildWebFetchTool(
  root: string,
  stopHooks: WebFetchStopHooks = {},
  /** 落盘后端：不传 = 按 `root` 现建本地后端（无工作区时 root 为空串 → 只截断不落盘） */
  backend?: WorkspaceBackend
): ToolSet {
  const spillBackend = backend ?? (root ? createLocalBackend(root) : null)
  /**
   * 这一轮暴露几个抓取引擎：**装配期现读**运行时。没装就**连 `engine` 这个入参都不给**
   * （理由见文件头「没装浏览器 = 只有一个引擎」），description 也换成单引擎版本。
   */
  const browserEngine = browserRuntimeInfo().installed
  const urlField = z.string().describe('要抓取的网页 URL，必须是 http(s)，如 https://example.com')
  const timeoutField = z
    .number()
    .optional()
    .describe('页面加载超时（毫秒），默认 30000，最大 60000')
  const maxCharsField = z
    .number()
    .optional()
    .describe(
      `返回 Markdown 的最大字符数，默认 ${DEFAULT_MAX_CHARS}，范围 1000–100000。` +
        '默认值已够判断页面内容；一般不要调大 —— 需要看某一段时用落盘文件的 offset/limit 更省。'
    )

  return {
    web_fetch: tool({
      description: browserEngine
        ? '抓取网页并整理成结构化 Markdown 返回给模型。默认用 Node 原生 fetch 取静态 HTML（更快更轻量）；设置 engine="browser" 则改用 Playwright 无头浏览器跑 JS 渲染（适合 SPA / 动态内容、搜索结果页）。适合：联网查资料、读文档 / 博客 / 文章、从网页提取链接继续深挖。页面过长时会只回开头结尾，并把全文落盘到工作区文件（结果里给出相对路径与行号）；其余部分用 read 的 offset/limit 接着读，也可以用 grep 检索。只读、不写任何文件。browser 引擎需要内置浏览器运行时（headless shell），由用户在「设置 → 浏览器」里安装 —— 没装时这个引擎会直接告诉你改用 fetch，不会自行下载。'
        : '抓取网页并整理成结构化 Markdown 返回给模型。用 Node 原生 fetch 取静态 HTML（这台机器没装内置浏览器，所以只有这一个引擎，不需要浏览器）。适合：联网查资料、读文档 / 博客 / 文章、从网页提取链接继续深挖。拿不到 JS 渲染后的内容（SPA / 纯前端渲染的页面）—— 抓到正文为空时不要反复重试同一个地址，换可达的静态页面或镜像。页面过长时会只回开头结尾，并把全文落盘到工作区文件（结果里给出相对路径与行号）；其余部分用 read 的 offset/limit 接着读，也可以用 grep 检索。只读、不写任何文件。',
      // 两个 schema 是**不同形状**（有没有 engine 取决运行时），所以 execute 里显式标注入参
      inputSchema: browserEngine
        ? z.object({
            url: urlField,
            engine: z
              .enum(['browser', 'fetch'])
              .optional()
              .describe('抓取引擎：browser=用 Playwright 无头浏览器跑 JS 渲染；fetch=用 Node 原生 fetch 取静态 HTML（默认）。拿不到 JS 渲染内容时改用 browser。'),
            timeoutMs: timeoutField,
            maxChars: maxCharsField
          })
        : z.object({ url: urlField, timeoutMs: timeoutField, maxChars: maxCharsField }),
      execute: async (raw, options) => {
        const { url, engine, timeoutMs, maxChars } = raw as WebFetchInput
        /**
         * **每条抓取一个自己的 AbortController**，并与「整轮中止」的信号并联：
         * - 用户点卡片上的「停止」→ 只 abort 这一条（宿主通过 `stopHooks` 拿到入口）；
         * - 用户点输入框的「停止」/ 断连 → `options.abortSignal` 触发，一起 abort。
         *
         * 不这么做的话，卡片上那颗停止钮只能退化成「中止整轮」，而抓一个卡住的境外站点
         * 动辄等 30s，用户没理由为此废掉整轮对话。
         */
        const stopCtrl = new AbortController()
        const outerSignal = options.abortSignal
        const onOuterAbort = (): void => stopCtrl.abort()
        if (outerSignal) {
          if (outerSignal.aborted) stopCtrl.abort()
          else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
        }
        const signal = stopCtrl.signal
        const toolCallId = options.toolCallId ?? ''
        if (toolCallId) stopHooks.onStart?.(toolCallId, () => stopCtrl.abort())

        const clampedMax = Math.max(
          1000,
          Math.min(100_000, Math.trunc(maxChars ?? DEFAULT_MAX_CHARS))
        )
        const timeout = Math.max(1000, Math.min(60_000, Math.trunc(timeoutMs ?? DEFAULT_TIMEOUT)))

        // URL 合法性 + 协议白名单：只允许 http(s)，挡掉 file:/data:/javascript: 等
        let target: URL
        try {
          target = new URL(url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return `web_fetch 拒绝抓取非 http(s) 地址：${url}（协议：${target.protocol}）`
          }
        } catch {
          return `web_fetch 收到非法 URL：${url}。请传入形如 https://example.com 的完整地址。`
        }

        if (signal.aborted) return 'web_fetch 已被中止（未发起请求）。'

        try {
          const page =
            engine === 'browser'
              ? await fetchByBrowser(target, timeout, signal)
              : await fetchByHttp(target, timeout, signal)
          return await formatPage(page, target.toString(), clampedMax, spillBackend)
        } catch (err) {
          // 缺运行时：给能执行的下一步，别让模型以为「换个 URL 再试 browser」就行
          if (err instanceof BrowserRuntimeMissingError) {
            return (
              `web_fetch 的 browser 引擎需要内置浏览器（Playwright headless shell，约 150MB），` +
              `这台机器上还没装，web_fetch 不会替你下载。两条路：` +
              `① 用 engine="fetch" 重抓（文档站 / 博客这类静态 HTML 够用；别原样重试 browser 引擎）；` +
              `② 告诉用户去「设置 → 浏览器」点「安装」，装好后重试。`
            )
          }
          // 先剥掉 playwright 附带的终端样式（Call log 是灰字），再做超时判定：
          // 判据看的是错误码与 timeout 字样，样式字节对正则没影响，但多余的 ESC 会让
          // 模型看到 `[2m` 这种残渣（与 bash 同一个问题，见 ansi.ts）
          const msg = pageErrorMessage(err)
          // 用户主动点了「停止」（单条或整轮）：别当成抓取失败，模型据此直接收场、不要重试
          if (signal.aborted) {
            return 'web_fetch 已被用户中止（点了「停止」），本轮不再重试。'
          }
          // 超时单独说清：国内访问境外站点（google / github 等）时 connect 阶段就可能
          // 挂到超时，这时重试通常没用，模型该换可达的镜像源或改用 fetch 引擎。
          // 两种引擎的超时都收敛成同一句带「timeout」的文案（见 fetchByHttp / fetchByBrowser）。
          if (/timeout|超时|timed out/i.test(msg)) {
            return (
              `web_fetch 抓取 ${url} 超时（${timeout}ms 内没拿到响应）。` +
              `常见原因是该站点在本机网络不可达（如境外站点被墙）或响应极慢；` +
              `不要原样重试，可改抓可达的镜像 / 文档站，或把 timeoutMs 调大（上限 60000）再试一次。`
            )
          }
          // 目录在、可执行文件缺（卸载被打断 / 杀软清掉了）：同样不是「换个 URL」能解决的，
          // 让用户去设置里点一次「安装」把它补回来
          if (/Executable doesn't exist|executable doesn't exist|Failed to launch/i.test(msg)) {
            return (
              `web_fetch 的 browser 引擎启动失败：内置浏览器的可执行文件缺失或不完整（${msg}）。` +
              `请让用户到「设置 → 浏览器」点「安装」修好运行时后再试；这期间可先用 engine="fetch"。`
            )
          }
          return `web_fetch 抓取 ${url} 失败：${msg}`
        } finally {
          // 无论成功 / 失败 / 中止都要注销，否则停止表会一直挂着一个已经结束的条目
          if (toolCallId) stopHooks.onEnd?.(toolCallId)
          outerSignal?.removeEventListener('abort', onOuterAbort)
        }
      }
    })
  }
}
