/**
 * 内置插件：把消息推到**企业微信群机器人 webhook**。
 *
 * 注册一个工具 `notify`：让 Agent 在需要「立刻告诉人」的时候发一条消息出去 —— 比如
 * 「依赖巡检跑完了，有两个包有 CVE」「构建失败了，详情如下」。这类需求的共同点是
 * **人在另一个地方**，所以走 IM 而不是留在会话里等人回来看。
 *
 * ## 为什么是 webhook 而不是企业微信应用
 *
 * 企业微信群机器人只要在群里「添加群机器人」拿一条 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`，
 * 就能 `POST {"msgtype":"text","text":{"content":"…"}}` 推消息 —— 无需注册应用、无需
 * access_token、密钥只在 URL 里。而「自建应用」要 corpid+secret、还要管理 agentid 与
 * 可信 IP，配额与审核都更重。通知场景要的是「一句话能推出去」，webhook 恰好够。
 *
 * ## 工具本身**不改任何东西**，所以 `mutating: false`
 *
 * 发通知是不可逆的对外动作（消息已经进群了），但它**不改动工作区、不动文件** ——
 * 所以不该在「完全访问」档之外强制弹审批卡，也不该在只读档被拒。
 * `mutating: false` 就是这个意思（见 `project-tools.ts` 里 `create_plugin` 的
 * `mutating` 参数说明）。
 *
 * ## 自动通知走会话状态钩子，而不是等模型调工具
 *
 * 除了 `notify` 工具，插件还接三个长驻钩子（见 `packages/plugin/src/hooks.ts` 的
 * `conversation:*`）：
 * - `conversation:finished`：一轮跑完（默认**不**发，避免刷群）；
 * - `conversation:confirm`：工具在等用户审批（默认发 —— 错过审批代价更高）；
 * - `conversation:followup`：Agent 在等用户回答问题（默认发）。
 *
 * 钩子由服务端按工作区建的长驻宿主分发（`apps/server/src/server/conversation-hooks.ts`），
 * 所以这里用 `ctx.inject(['hooks'], …)`，**不能**写进顶层 `inject`（设置页 inspect
 * 没有 hooks，写顶层会让整个插件被推迟、连设置表单都不出现）。
 *
 * ## 自动通知的三条纪律
 *
 * - **fire-and-forget**：钩子是同步总线，监听器里不能 await 网络；用 `void …catch`，
 *   失败只记日志，绝不把异常抛回会话收尾；
 * - **去重**：按 requestId / confirmId / followupId 记一份短表；
 * - **节流**：两次自动通知至少隔 3 秒（企业微信限流 20 条/分钟），宁可晚一点也别撞 45009。
 *
 * ## 失败必须能被看见
 *
 * 通知是**看不见结果**的一类功能：发成功了群里才有消息，发失败则什么都看不到。所以这条
 * 链路每一步都留日志（都走 `ctx.logger`，宿主接进应用日志 → 日志面板「插件」页）：
 * - 没挂上的原因（没配 webhook / 两个开关都关）—— 去重后只记一次，免得每轮刷一条；
 * - 挂上了哪几种通知（`自动通知已挂上：会话完成、待确认、待回答`）；
 * - 每次推送成功 / 失败（失败带企业微信的错误码原文）。
 *
 * 别把这些日志删成 `console.warn`：打包后的桌面端没有控制台，等于没记 —— 这正是
 * 「通知没发出去、界面上也查不到为什么」的由来。
 *
 * ## 三种消息类型，按「手机上读起来是否舒服」选
 *
 * - `text`：纯文本兜底（任何群都支持，最稳）。
 * - `markdown`：企业微信支持一小段 markdown（标题 / 粗体 / 链接 / 行内代码），信息密度更高；
 *   但**不支持表格与图片外链**，且 `content` 有 4096 字节上限。
 * - `markdown` 默认开着，模型自己选；正文超长时这里会**截断**并在末尾加省略标记
 *   —— 让它截，不要让它发一个 400。
 *
 * ## 安全：webhook key 绝不进代码，也绝不回传浏览器
 *
 * 那个 `key=` 等价于群机器人的密码。设置项标 `secret: true`，由宿主走 SecretBox 加密
 * 落盘、明文不回传浏览器。
 *
 * ⚠️ **只认设置页（系统配置），不读环境变量**：早先还支持 `WECOM_WEBHOOK_URL` 兜底，
 * 已经移除 —— 同一个凭据有两个真源时，排查「为什么发不出去」永远得先问「你到底配在哪」。
 * 容器 / 无界面部署用的是**同一个**设置页（同一个 server 托管 web 产物），不需要第二套入口。
 */
import { z } from 'zod'
import { tool } from 'ai'

/** 企业微信 markdown 的 `content` 上限（字节；超了直接 400） */
const MAX_CONTENT_BYTES = 4096
/** 单次请求超时（毫秒）—— 通知是「锦上添花」，不该把一轮对话挂在这儿 */
const TIMEOUT_MS = 15_000
/** 截断后追加的标记（字节数够短，不会顶到上限） */
const TRUNCATE_SUFFIX = '\n…（内容过长已截断）'
/** 自动通知之间的最小间隔（企业微信限流 20 条/分钟；留足余量） */
const MIN_NOTIFY_GAP_MS = 3_000
/** 去重表上限：id 都是新生成的，理论上不会重复，这里只防异常重复投递 */
const DEDUPE_LIMIT = 200

/**
 * 插件图标：**通知铃铛**（自绘 SVG，企业微信品牌绿 `#07C160`）。
 *
 * ## 为什么是自绘的铃铛，而不是企业微信官方 logo
 *
 * 早先想抄官方 logo 的 path 数据，但那串数据是**凭印象写的、而且是错的** —— 里面混进了
 * `05.716`、`2.72-.167` 这种非法写法（一个数里两个小数点、数字与数字之间缺分隔符）。
 * 浏览器遇到这种数据会**整条 path 丢弃**，症状是「图标位置只剩一个空白占位块」
 *（`PluginsPanel.tsx` 里那个 `Puzzle` 兜底图标），而**服务端侧一切正常**：
 * `ctx.ui.icon()` 只校验「是不是 data:image/* 的 data URI」，不校验 path 画不画得出来；
 * `inspectPluginUi` 也只查注册有没有发生。
 *
 * 也就是说「图标注册成功」与「图标画得出来」完全是两件事 —— 前者任何现有测试都测得到，
 * 后者测不到，于是错的那版一路绿灯走完了流程。**别再凭印象写 path。**
 *
 * 现在改成自己画一个形状简单、**坐标全是绝对值**的铃铛：每个坐标肉眼可核对；
 * 弧线一律用三次贝塞尔（`C`）而不是 `A` 弧命令 —— 弧命令 7 个参数里有 2 个是标志位，
 * 写错一位就整条 path 报废，而且比贝塞尔难读得多。
 *
 * 要换回官方 logo：从官网 favicon 重新导一份，**并跑 `node scripts/verify-plugin-icon.mjs`**
 * 看一眼字符画 —— 那个脚本把 path 栅格化出来，形状不对一眼就能看出来。
 *
 * 形状为什么够用：插件做的是「往 IM 推通知」，铃铛是这件事的通用符号、一眼能懂；
 * 而卡片里是 **40px** 展示（`PluginsPanel.tsx` 的 `size-10`），细节越多越糊。
 * 用法仍与其它内置插件一致：URL 编码的 data URI（不收远程 URL、不收裸 SVG 源码，
 * 规则见 `@fizz/plugin` 的 `ICON_RE`）。
 */
const ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%2224%22%20height%3D%2224%22%3E%3Cpath%20fill%3D%22%2307C160%22%20d%3D%22M12%203C8.1%203%205%206.1%205%2010L5%2015L3.5%2019.5L20.5%2019.5L19%2015L19%2010C19%206.1%2015.9%203%2012%203Z%22%2F%3E%3Cpath%20fill%3D%22%2307C160%22%20d%3D%22M9.8%2020.6C9.8%2023.2%2014.2%2023.2%2014.2%2020.6Z%22%2F%3E%3C%2Fsvg%3E'

/** 插件配置（宿主传进来的；值来自设置页，**不读环境变量**） */
interface WecomConfig {
  enabled?: boolean
  webhookUrl?: string
  defaultMentions?: string
  notifyOnFinish?: boolean
  notifyOnWait?: boolean
}

interface WecomSettings {
  enabled: boolean
  webhookUrl: string
  defaultMentions: string[]
  /** 一轮跑完自动推送（默认关：完成通知频繁，容易刷群） */
  notifyOnFinish: boolean
  /** 等审批 / 等回答自动推送（默认开：错过审批的代价更高） */
  notifyOnWait: boolean
}

/** 取配置值：只去首尾空白，空串当「没配」 */
function pick(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readSettings(config?: WecomConfig): WecomSettings {
  // 默认 @ 谁：逗号分隔的用户 id 或 `@all`；留空 = 不 @
  const mentions = pick(config?.defaultMentions)
  return {
    // 开关：缺省 = 开（只有显式存成 false 才关），与 oss 同一口径
    enabled: config?.enabled !== false,
    webhookUrl: pick(config?.webhookUrl),
    defaultMentions: mentions
      ? mentions
          .split(/[,，\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
    // 缺省口径与 UI 上的 default 保持一致：完成通知默认关，等待通知默认开
    notifyOnFinish: config?.notifyOnFinish === true,
    notifyOnWait: config?.notifyOnWait !== false
  }
}

/**
 * 校验 webhook URL。
 *
 * ⚠️ **只认企业微信官方域名**。这个值会被 POST 到任意地址上，而它本身就是一个凭证
 * —— 一个配错的 URL（比如手滑粘成了别的地方）等于把群机器人密钥发到第三方。
 * 所以这里 fail-closed：域名对不上就报错，而不是「试一下看看」。
 */
function validateWebhook(url: string): URL {
  if (!url) {
    throw new Error(
      '还没配企业微信 webhook：设置 →「插件」→ 企业微信通知 →「群机器人 Webhook 地址」'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`webhook 地址不是合法 URL：${url.slice(0, 60)}`)
  }
  if (parsed.protocol !== 'https:') throw new Error('webhook 地址必须用 https')
  if (parsed.hostname !== 'qyapi.weixin.qq.com') {
    throw new Error(
      `webhook 地址的域名是 ${parsed.hostname}，只接受企业微信官方的 qyapi.weixin.qq.com` +
        '（这个地址里带着群机器人的密钥，别的域名等于把它发出去）'
    )
  }
  if (!parsed.searchParams.get('key')) {
    throw new Error('webhook 地址里没有 key 参数 —— 从群机器人设置里复制完整的那条 URL')
  }
  return parsed
}

/** 超限时截断（按字节，留出标记的位置）；中文要按字节算，不能用 length */
function clampContent(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= MAX_CONTENT_BYTES) return { text, truncated: false }
  const suffix = Buffer.from(TRUNCATE_SUFFIX, 'utf8')
  // 留够 suffix 的位置，再往前找个别把一个多字节字符切成半截的位置
  let cut = MAX_CONTENT_BYTES - suffix.length
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--
  return { text: `${buf.subarray(0, cut).toString('utf8')}${TRUNCATE_SUFFIX}`, truncated: true }
}

/** 企业微信的错误体形如 `{ errcode: 40001, errmsg: 'invalid credential' }` */
interface WecomResponse {
  errcode?: number
  errmsg?: string
}

/** 错误码 → 人话（只列通知场景真会撞上的那几个） */
function explainCode(code: number, msg: string): string {
  switch (code) {
    case 40001:
      return '凭据无效（webhook key 错了，或这个机器人已被移除）'
    case 40014:
      return 'access_token 无效（本插件不用 token，所以基本是 webhook 地址本身有问题）'
    case 40058:
      return '这个 webhook 不合法 —— 确认是从「群机器人」里复制的完整地址'
    case 45009:
      return '接口调用超过频率限制（每机器人每分钟 20 条）—— 稍等再试，别重发'
    case 93000:
      return '不是有效的 webhook 地址'
    default:
      return msg || `错误码 ${code}`
  }
}

/** 真发一条 */
async function send(
  settings: WecomSettings,
  body: { msgtype: string; [k: string]: unknown }
): Promise<void> {
  const url = validateWebhook(settings.webhookUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    // 企业微信把业务错误放在 200 的 body 里（errcode 非 0），HTTP 状态码不可信
    const text = await res.text()
    let parsed: WecomResponse = {}
    try {
      parsed = JSON.parse(text) as WecomResponse
    } catch {
      // 不是 JSON：代理 / 网关插了别的内容，报原文更有用
      throw new Error(`企业微信返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      throw new Error(
        `企业微信拒绝了：${explainCode(parsed.errcode, parsed.errmsg ?? '')}`
      )
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`推送超时（${TIMEOUT_MS / 1000} 秒内没响应）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 联系人写法：企业微信要**裸 userid**，`<@userid>` / `<@all>` 是它**回显**时才加的。
 *
 * 所以两处输入都要归一成裸 id —— 用户自己写进正文的 `<@all>` 原样落到请求体里会变成
 * `<@<@all>>`，**@ 不到人**（看起来发出去了，群里没人被提醒，最难查的一种）。
 */
function mentionList(raw: string[], extra: string[] = []): string[] {
  const out: string[] = []
  for (const item of [...raw, ...extra]) {
    const t = item.trim()
    if (!t) continue
    // 已经是 `<@x>` 形态的原样收下，免得拼出 `<@<@all>>`
    const id = t.startsWith('<@') && t.endsWith('>') ? t.slice(2, -1) : t
    if (id === 'all') {
      out.push('<@all>')
      continue
    }
    // 企业微信的 mentioned_list 要的是**裸 id**，`<@…>` 是它回显时才加的
    out.push(id)
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// 会话状态钩子：payload 形态按 `@fizz/plugin` 的稳定窄接口手写（不 import）
// ---------------------------------------------------------------------------

interface ConversationHookBase {
  conversationId: string
  requestId: string
  title: string
  workspaceId?: string
  workspaceName?: string
}

interface ConversationFinishedEvent extends ConversationHookBase {
  finishReason: string
  excerpt?: string
  error?: string
  stopReason?: string
  steps?: number
  finishedAt: number
}

interface ConversationConfirmEvent extends ConversationHookBase {
  confirm: { id: string; toolName: string; command: string; intent?: string }
}

interface ConversationFollowupEvent extends ConversationHookBase {
  followup: { id: string; title?: string; questions: Array<{ question: string }> }
}

interface HookBus {
  on(name: string, listener: (payload: unknown) => void): unknown
}

/** 会话完成时的结果文案 */
function finishedStatus(event: ConversationFinishedEvent): string {
  if (event.finishReason === 'error') return '出错'
  if (event.finishReason === 'aborted') return '已停止'
  if (event.stopReason === 'max-steps') {
    return event.steps !== undefined ? `已用满 ${event.steps} 步上限` : '已用满步数上限'
  }
  return '已完成'
}

function whereOf(event: ConversationHookBase): string {
  return event.workspaceName ? ` · ${event.workspaceName}` : ''
}

function formatFinished(event: ConversationFinishedEvent): { title: string; content: string } {
  const status = finishedStatus(event)
  const lines = [`**${event.title}**`, `状态：${status}`]
  if (event.error) lines.push('', `**失败原因**：${event.error}`)
  else if (event.excerpt) lines.push('', event.excerpt)
  return { title: `会话${status}${whereOf(event)}`, content: lines.join('\n') }
}

function formatConfirm(event: ConversationConfirmEvent): { title: string; content: string } {
  const lines = [`**${event.title}** 正在等待你确认。`, '', `操作：${event.confirm.command}`]
  if (event.confirm.intent) lines.push(`意图：${event.confirm.intent}`)
  return { title: `待确认${whereOf(event)}`, content: lines.join('\n') }
}

function formatFollowup(event: ConversationFollowupEvent): { title: string; content: string } {
  const first = event.followup.questions[0]?.question
  const lines = [
    `**${event.title}** 正在等待你回答。`,
    '',
    first ? `问题：${first}` : 'Agent 发来了一个问题表单。'
  ]
  if (event.followup.questions.length > 1) {
    lines.push(`（共 ${event.followup.questions.length} 题，请回到 Fizz 作答）`)
  }
  return { title: `待回答${whereOf(event)}`, content: lines.join('\n') }
}

/** 短去重表：返回 true = 第一次见到这个 key */
function createOnce(limit = DEDUPE_LIMIT): (key: string) => boolean {
  const seen = new Set<string>()
  return (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > limit) {
      const first = seen.values().next().value
      if (first !== undefined) seen.delete(first)
    }
    return true
  }
}

/**
 * 同一个原因只播报一次。
 *
 * `apply` 会在**每个 context** 里各跑一遍（每轮对话、设置页 inspect、长驻钩子宿主），
 * 无条件 `logger.info` 会把日志面板刷满；而这几条恰恰是「通知为什么没挂上」的答案，
 * 又不能不打。所以按正文去重：同一句话进程内只记一次，原因变了才重新记。
 *
 * 模块级变量（不是 apply 内）才有这个效果：插件模块由 `@fizz/plugin/loader` 缓存，
 * 多次 apply 拿到的是同一个模块实例。
 */
let lastAnnounce = ''
function announce(logger: PluginCtx['logger'], message: string): void {
  if (lastAnnounce === message) return
  lastAnnounce = message
  logger.info(`[wecom] ${message}`)
}

/**
 * 插件参数类型是**结构化手写**的（不 import `@fizz/plugin`）：插件目录可能不在仓库里，
 * 指望解析到 workspace 包不可靠。`zod` / `ai` 是例外 —— 工具要用它们建 schema，
 * 而内置插件根随仓库分发，这条依赖是明确的（见 skills/create-fizz-plugin/SKILL.md）。
 */
interface PluginCtx {
  /**
   * `info` / `warn` 都会进应用日志（宿主用 `setPluginLogSink` 接了出口，见
   * `apps/server/src/server/plugin-log-sink.ts`）—— 打包后的桌面端没有控制台，
   * 只写 console 等于没记。
   */
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  inject(deps: string[], cb: (ctx: PluginCtx) => void | (() => void)): unknown
  ui: { icon(uri: string): unknown; setting(item: unknown): unknown }
  tools: { register(name: string, tool: unknown, opts?: unknown): unknown }
  /** 只在 `ctx.inject(['hooks'], …)` 里可用（长驻会话钩子宿主提供） */
  hooks?: HookBus
}

export default {
  name: '企业微信通知',

  /**
   * 顶层不声明依赖 = **任何 context 都 apply**。
   *
   * 设置项声明必须在设置页那次 inspect 里跑通，而那里没有 `tools` —— 写成
   * `inject: ['tools']` 会让整个插件在设置页**压根不出现**（连表单都看不到）。
   * 工具那一半自己用 `ctx.inject(['tools'])` 声明依赖（同 `oss.ts` 的两半式写法）。
   */
  inject: [],

  apply(ctx: PluginCtx, config?: WecomConfig) {
    const settings = readSettings(config)

    // ---- 设置项与图标：只要宿主提供 ui（设置页 inspect 有，长驻 context 也有）----
    ctx.inject(['ui'], (c) => {
      c.ui.icon(ICON)
      c.ui.setting({
        id: 'enabled',
        title: '启用企业微信通知',
        type: 'boolean',
        default: true,
        description:
          '开启后模型可以调用 notify 工具，并按下方开关自动推送会话状态；关掉则保留配置但不再注册任何能力'
      })
      c.ui.setting({
        id: 'webhookUrl',
        title: '群机器人 Webhook 地址',
        type: 'string',
        secret: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
        description:
          '在企业微信群里「添加群机器人 → 复制 Webhook 地址」。⚠️ 这条地址里的 key 等于机器人的密码，' +
          '**不要提交进 git**。'
      })
      c.ui.setting({
        id: 'defaultMentions',
        title: '默认 @ 谁',
        type: 'string',
        placeholder: '@all 或 zhangsan,lisi',
        description:
          '逗号分隔的企业微信用户 id（不是姓名），`@all` 表示所有人。notify 工具与「等待确认 / 等待回答」通知会用它；会话完成通知不 @。'
      })
      c.ui.setting({
        id: 'notifyOnFinish',
        title: '会话完成时自动通知',
        type: 'boolean',
        default: false,
        description:
          '一轮对话跑完（含出错 / 被停止）后自动推一条带摘要的消息。默认关：定时任务多时容易刷屏。'
      })
      c.ui.setting({
        id: 'notifyOnWait',
        title: '等待确认 / 回答时自动通知',
        type: 'boolean',
        default: true,
        description:
          '工具等你审批、Agent 等你回答时自动推一条（会按「默认 @ 谁」提醒）。默认开：错过等待往往比错过完成更要紧。'
      })
    })

    if (!settings.enabled) {
      announce(ctx.logger, '插件被关掉了：notify 工具与会话状态通知都不注册')
      return
    }

    // ---- 工具：挂有 tools 的回合（长驻 context 里没人用注册表，静默不注册）----
    ctx.inject(['tools'], (c) => {
      if (!settings.webhookUrl) {
        // 工具照样注册：调用时再报「还没配」，比「工具凭空消失」好查
        c.logger.warn('[wecom] 还没配 webhook，notify 调用会直接报错')
      }
      c.tools.register(
        'notify',
        tool({
          description:
            '往企业微信群推一条消息（群机器人 webhook）。用在「人不在电脑前、但这件事需要立刻知道」的场景：' +
            '后台任务跑完、巡检发现 CVE、构建失败、需要人工介入的卡点。' +
            'msgtype 默认 markdown（支持标题 / 粗体 / 行内代码），正文超长会自动截断。' +
            '⚠️ 消息发出去就收不回来了，且群里的每个人都会看到 —— 别拿它当「给自己留个备注」。',
          inputSchema: z.object({
            content: z.string().describe('消息正文（markdown）。想 @ 人就在正文里写 <@userid> 或 <@all>'),
            title: z
              .string()
              .optional()
              .describe('标题（仅 markdown 生效）。建议写「结论」而不是「日志」'),
            msgtype: z
              .enum(['markdown', 'text'])
              .optional()
              .describe('消息类型，默认 markdown；text 是最稳的纯文本（任何群都支持）'),
            mentions: z
              .array(z.string())
              .optional()
              .describe('额外 @ 的用户 id（不是姓名）。`all` 表示 @所有人；不给则用设置里的默认')
          }),
          execute: async ({
            content,
            title,
            msgtype,
            mentions
          }: {
            content: string
            title?: string
            msgtype?: 'markdown' | 'text'
            mentions?: string[]
          }) => {
            const text = content.trim()
            if (!text) throw new Error('消息内容不能为空')

            const kind = msgtype ?? 'markdown'
            // 超限截断在这里做，不丢给企业微信去报 400
            const clamped = clampContent(text)
            const ids = mentionList(
              // 显式传了就覆盖默认（空数组 = 明确不 @）；没传才用设置里的
              mentions !== undefined ? mentions : settings.defaultMentions
            )
            /**
             * `@` 的两种落法（企业微信的规矩，别自作聪明只写一种）：
             * - markdown：正文里要有 `<@userid>` 字面量，**且** `mentioned_list` 带上裸 id
             *   （两个都要，缺一个就只是显示一行文字、**不会真的提醒人**）；
             * - text：正文里写 `<@userid>` 就够了（text 没有 mentioned_list 这个字段）。
             *
             * `mentionList` 返回的已经是「可放进 mentioned_list」的形态
             * （裸 id，`all` → `<@all>`），正文那一段则要把裸 id 补上 `<@>` 尖括号。
             */
            const inlineMentions = ids.map((id) => (id.startsWith('<') ? id : `<@${id}>`)).join(' ')
            const mentionSuffix = inlineMentions ? `\n${inlineMentions}` : ''

            if (kind === 'text') {
              await send(settings, {
                msgtype: 'text',
                text: { content: `${clamped.text}${mentionSuffix}` }
              })
            } else {
              await send(settings, {
                msgtype: 'markdown',
                markdown: {
                  content: `${title ? `### ${title}\n` : ''}${clamped.text}${mentionSuffix}`
                },
                // text 类型没有这个字段，带上会被拒；markdown 必须带，否则 @ 不生效
                ...(ids.length ? { mentioned_list: ids } : {})
              })
            }
            return `已推送到企业微信群（${kind}）。${clamped.truncated ? '⚠️ 正文超长，已截断发送。' : ''}`
          }
        }),
        // mutating: false —— 发通知不改工作区、不动文件，所以不该被当成破坏性操作拦审批。
        { source: 'wecom', mutating: false }
      )
    })

    // ---- 自动通知：长驻会话钩子宿主（只有 hooks，没有 tools 也能工作）----
    // 这两条 return 就是「hook 没生效」的两种最常见原因，各记一条（去重后只出现一次）
    if (!settings.webhookUrl) {
      announce(ctx.logger, '自动通知没挂上：还没配「群机器人 Webhook 地址」')
      return
    }
    if (!settings.notifyOnFinish && !settings.notifyOnWait) {
      announce(ctx.logger, '自动通知没挂上：「会话完成」与「等待确认 / 回答」两个开关都关着')
      return
    }

    /** 自动通知这条半边的日志出口（宿主接进了应用日志，桌面端才看得见） */
    const log = ctx.logger

    /*
     * 节流队列：企业微信每机器人每分钟 20 条。钩子回调是同步的，不能 await；这里用一条
     * promise 链把「发送间隔至少 3 秒」串起来。链上某条失败不阻断后续（`chain = catch`），
     * 但调用方拿到的仍是会 reject 的 task —— 由监听器自己的 catch 记日志。
     */
    let sendChain: Promise<void> = Promise.resolve()
    let lastSentAt = 0
    const enqueueSend = (
      message: { title: string; content: string },
      mention: boolean,
      /** 通知种类（「会话完成」/「待确认」/「待回答」），只用于日志 */
      label: string
    ): Promise<void> => {
      const task = sendChain.then(async () => {
        const wait = lastSentAt + MIN_NOTIFY_GAP_MS - Date.now()
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        const ids = mention ? mentionList(settings.defaultMentions) : []
        const inline = ids.map((id) => (id.startsWith('<') ? id : `<@${id}>`)).join(' ')
        const content = `### ${message.title}\n${message.content}${inline ? `\n\n${inline}` : ''}`
        // 和 notify 工具同一条截断规则：宁可截断，也别让企业微信回 400
        const clamped = clampContent(content)
        await send(settings, {
          msgtype: 'markdown',
          markdown: { content: clamped.text },
          ...(ids.length ? { mentioned_list: ids } : {})
        })
        lastSentAt = Date.now()
        /*
         * 成功也记一条。只记失败的话，「日志里什么都没有」既可能是成功了、也可能是
         * 压根没触发 —— 排查「通知到底发没发」时这两种必须能区分开。
         */
        log.info(`[wecom] 已推送「${label}」通知`)
      })
      sendChain = task.catch(() => {})
      return task
    }

    ctx.inject(['hooks'], (c) => {
      const hooks = c.hooks
      if (!hooks) return
      const once = createOnce()
      const fail = (kind: string) => (err: unknown): void => {
        log.warn(`[wecom] ${kind}通知发送失败：`, err instanceof Error ? err.message : String(err))
      }

      const registered: string[] = []
      if (settings.notifyOnFinish) {
        hooks.on('conversation:finished', (payload) => {
          const event = payload as ConversationFinishedEvent
          // requestId 每轮唯一：同一轮重复投递只发一条
          if (!once(`finished:${event.requestId}`)) return
          void enqueueSend(formatFinished(event), false, '会话完成').catch(fail('会话完成'))
        })
        registered.push('会话完成')
      }

      if (settings.notifyOnWait) {
        hooks.on('conversation:confirm', (payload) => {
          const event = payload as ConversationConfirmEvent
          if (!event.confirm?.id || !once(`confirm:${event.confirm.id}`)) return
          void enqueueSend(formatConfirm(event), true, '待确认').catch(fail('待确认'))
        })
        hooks.on('conversation:followup', (payload) => {
          const event = payload as ConversationFollowupEvent
          if (!event.followup?.id || !once(`followup:${event.followup.id}`)) return
          void enqueueSend(formatFollowup(event), true, '待回答').catch(fail('待回答'))
        })
        registered.push('待确认', '待回答')
      }

      // 挂上了哪些：与宿主那条「宿主已就绪」一起，把「有没有接上事件」变成可查的事实
      announce(log, `自动通知已挂上：${registered.join('、')}`)
    })
  }
}

/** 只为验证脚本存在：把纯函数暴露出来，好让 `scripts/verify-wecom-webhook.mjs` 用
 * 假 fetch 钉住「校验 / 截断 / @ 拼接 / 错误码映射」这几件纯逻辑，不必真发消息。 */
export const __internals = {
  readSettings,
  validateWebhook,
  clampContent,
  mentionList,
  explainCode,
  createOnce,
  formatFinished,
  formatConfirm,
  formatFollowup
}
