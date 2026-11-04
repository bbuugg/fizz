/**
 * Redis 客户端 —— **从 dogi 项目 `plugins/redis-client`（main.js）迁移**，并按 Fizz 的
 * 插件界面机制重做形态。
 *
 * ## 它长什么样
 *
 * | 位置 | 内容 |
 * | --- | --- |
 * | 左侧图标栏 | **没有专属图标** —— 插件共用一颗「插件」，侧栏是插件列表 |
 * | **插件列表 → 「Redis 客户端」** | 打开下面两个标签页中的第一个 |
 * | **标签页 `connections`** | 连接管理器：列出所有连接（含状态）、新增 / 编辑 / 删除 |
 * | **标签页 `key`** | 某个连接的 Key 浏览（连接列表里点一条就开出来，一个连接一页） |
 *
 * 界面**都不是**服务端 `render()` 吐的块，而是插件自带的前端半画的（见下一节）。
 *
 * ## 双面包：本文件是服务端半，`client.jsx` 是前端半
 *
 * | 文件 | 角色 |
 * | --- | --- |
 * | `plugin.json` | 声明 `icon`、两个 `view` 面（`connections` / `key`）与 `client.entry` |
 * | **`index.ts`（本文件）** | 服务端半：只挂 `ctx.rpc` 处理器与 Redis 连接池，**不注册任何 `ctx.ui` 面** |
 * | `client.jsx` | 前端半源码：React 组件 + 按 surface id 认领渲染函数 |
 * | `client.js` | 前端半**构建产物**（`npm run build:plugins`，别手改） |
 *
 * 同一个面**只能有一个渲染者**：`plugin.json` 声明了，本文件就别再 `ctx.ui.view(...)` ——
 * 两边都声明时服务端会报「同时由服务端半和前端半声明」，只保留服务端那份（见
 * `apps/server/src/server/plugin-ui.ts`）。
 *
 * 清单里**只能声明 `view` 面**（标签页）：插件不占图标栏、也没有自己的侧栏。点插件时默认
 * 打开 `order` 最小的那一面，所以 `connections` 的 order 是 0、`key` 是 10。
 *
 * 「一个连接一个标签」走 `ctx.openView`（前端半里）：`key` 这个面配**不同 params**
 * 就能开出多屏，宿主负责标签 key、分屏与关闭保护（见 SKILL.md 3.7）。
 *
 * 状态（SCAN 游标、过滤器、命令行历史）**全在浏览器里**，每个标签页各一份 —— 服务端每个
 * handler 都必须能被并发调用，不存任何请求级状态。
 *
 * ## 连接存在哪（⚠️ 密码是明文）
 *
 * 存在**插件自己目录**下的 `.redis-connections.json`（`~/.fizz/plugins/`）。
 *
 * 为什么不是「设置项」：设置项是**插件声明的、一份固定的表单**，而连接是用户随时增删改的
 * **一组条目**（数量不定），塞不进那种形态。框架目前也**没有** `ctx.storage` 之类的
 * 持久化服务，所以这里由插件自己写文件 —— 若以后加了 `ctx.storage`，这一处应迁过去。
 *
 * ⚠️ 因此**密码以明文落盘**（设置项那种 SecretBox 加密用不上）。这是本机自用工具的取舍，
 * 但要心里有数：不要把生产库的高权限账号填进来。
 *
 * ## 客户端实现：来自 dogi
 *
 * `RedisClient` 与 RESP 编解码沿用 dogi 那份（它只用 `node:net` / `node:tls`，零依赖 ——
 * 用户级插件目录没有 node_modules，npm 的 redis 包在那儿解析不到）。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// RESP2 客户端（来自 dogi：命令串行 + 增量解析，尽量小）
// ---------------------------------------------------------------------------

const INCOMPLETE = Symbol('incomplete')

/** 把命令参数编成 RESP 数组帧 */
function encodeCommand(args: (string | Buffer)[]): Buffer {
  // 显式标成 `Buffer[]`：Node 的 Buffer 带了 `ArrayBufferLike` 泛型，不标的话数组会被
  // 推断成 `Buffer<ArrayBuffer>[]`，而入参里的 Buffer 是 `Buffer<ArrayBufferLike>`（装不进去）
  const frames: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')
    frames.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'))
  }
  return Buffer.concat(frames)
}

class RedisClient {
  private readonly cfg: RedisTarget
  private socket: { write: (b: Buffer) => void; destroy: () => void } | null = null
  private buf = Buffer.alloc(0)
  private pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** 是我们自己关的吗（用来区分「主动断开」与「被对端断掉」） */
  private selfClose = false
  connected = false
  currentDb: number
  error: Error | null = null
  /** 不是我们关的、那次断开的原因（侧栏的状态徽章要把它说出来） */
  droppedReason: string | null = null

  constructor(cfg: RedisTarget) {
    this.cfg = cfg
    this.currentDb = cfg.db
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port, username, password, db, tls, timeoutMs } = this.cfg
      const opts = { host: host || '127.0.0.1', port: port || 6379, timeout: timeoutMs || 10000 }
      const sock = tls ? tlsConnect({ ...opts, rejectUnauthorized: false }) : netConnect(opts)
      this.socket = sock as unknown as { write: (b: Buffer) => void; destroy: () => void }
      ;(sock as unknown as { setKeepAlive: (v: boolean) => void }).setKeepAlive(true)
      ;(sock as unknown as { setNoDelay: (v: boolean) => void }).setNoDelay(true)

      let done = false
      sock.on('error', (err: Error) => {
        this.error = err
        this.connected = false
        if (!done) {
          done = true
          reject(new Error(`连接失败：${err.message}`))
        }
      })
      sock.once('connect', () => {
        // 认证：优先 ACL(username password)，其次仅 password
        const args: string[] = []
        if (username) args.push('AUTH', username, password ?? '')
        else if (password) args.push('AUTH', password)
        args.push('PING')
        this.connected = true
        this.command(...args)
          .then(async () => {
            if (this.currentDb > 0) await this.command('SELECT', String(db))
            done = true
            resolve()
          })
          .catch((e: Error) => {
            this.connected = false
            if (!done) {
              done = true
              this.close()
              reject(e)
            }
          })
      })
      sock.on('data', (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk])
        if (this.connected) this.flush()
      })
      sock.on('close', () => {
        this.connected = false
        // 只有「不是我们主动关的」才算掉线：原因要显示给用户（对端重启 / 网络断了）
        if (!this.selfClose) {
          this.droppedReason = this.error?.message || '连接被对端关闭'
        }
      })
    })
  }

  /** 进队执行一条命令（严格串行：一次只允许一个在途命令） */
  command(...args: string[]): Promise<unknown> {
    const run = () => this.send(args)
    const res = this.chain.then(run, run)
    this.chain = res.catch(() => undefined)
    return res
  }

  private send(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) return reject(new Error('连接已断开'))
      this.pending = { resolve, reject }
      try {
        this.socket.write(encodeCommand(args))
      } catch (e) {
        this.pending = null
        reject(new Error(`写入失败：${(e as Error).message}`))
      }
      this.flush()
    })
  }

  private parse(at: number): { val: unknown; next: number } | typeof INCOMPLETE {
    const nl = this.buf.indexOf('\r\n', at)
    if (nl < 0) return INCOMPLETE
    const head = this.buf.toString('utf8', at, nl)
    const after = nl + 2
    switch (head[0]) {
      case '+':
        return { val: { _simple: head.slice(1) }, next: after }
      case '-':
        return { val: { _error: head.slice(1) }, next: after }
      case ':':
        return { val: parseInt(head.slice(1), 10), next: after }
      case '$': {
        const len = parseInt(head.slice(1), 10)
        if (len === -1) return { val: null, next: after }
        if (this.buf.length < after + len + 2) return INCOMPLETE
        return { val: this.buf.subarray(after, after + len), next: after + len + 2 }
      }
      case '*': {
        const count = parseInt(head.slice(1), 10)
        if (count === -1) return { val: null, next: after }
        if (count > 5_000_000) throw new Error('回复数组过长，疑似异常')
        const arr: unknown[] = []
        let cur = after
        for (let i = 0; i < count; i++) {
          const r = this.parse(cur)
          if (r === INCOMPLETE) return INCOMPLETE
          arr.push(r.val ?? null)
          cur = r.next
        }
        return { val: arr, next: cur }
      }
      default:
        throw new Error(`未知 RESP 类型：${head[0]}`)
    }
  }

  private flush(): void {
    while (this.pending) {
      let r: { val: unknown; next: number } | typeof INCOMPLETE
      try {
        r = this.parse(0)
      } catch (e) {
        const p = this.pending
        this.pending = null
        this.connected = false
        this.close()
        p.reject(e as Error)
        return
      }
      if (r === INCOMPLETE) break
      this.buf = this.buf.subarray(r.next)
      const p = this.pending
      this.pending = null
      const val = r.val as { _error?: string; _simple?: string } | null
      if (val && val._error) p.reject(new Error(val._error))
      else if (val && val._simple) p.resolve(val._simple)
      else p.resolve(r.val)
    }
  }

  close(): void {
    this.selfClose = true
    this.connected = false
    if (this.pending) {
      this.pending.reject(new Error('连接已关闭'))
      this.pending = null
    }
    try {
      this.socket?.destroy()
    } catch {
      /* 已关就算了 */
    }
    this.socket = null
  }
}

// ---------------------------------------------------------------------------
// 值处理 / 格式化（同样来自 dogi）
// ---------------------------------------------------------------------------

/** 是不是「非法 UTF-8」的二进制值 */
function isBinaryBuf(buf: unknown): boolean {
  if (!Buffer.isBuffer(buf)) return false
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/** Buffer → 人可读文本；二进制的给出 hex（这样界面上不会糊成一团乱码） */
function textVal(buf: unknown): string {
  if (buf == null) return ''
  if (!Buffer.isBuffer(buf)) return String(buf)
  return isBinaryBuf(buf) ? buf.toString('hex') : buf.toString('utf8')
}

/**
 * 解析 `INFO` 文本：`# 小节` + `key:value`。小节键统一**小写**（Redis 里是 `# Server`
 * 这种首字母大写），否则查 `sections.server` 取不到值。
 */
function parseInfo(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let cur = 'misc'
  const ensure = (name: string): Record<string, string> => {
    const key = String(name || 'misc').trim().toLowerCase() || 'misc'
    if (!sections[key]) sections[key] = {}
    return sections[key]
  }
  for (const line of String(text || '').split('\n')) {
    const l = line.trim()
    if (!l) continue
    if (l.startsWith('#')) {
      cur = l.slice(1).trim()
      ensure(cur)
      continue
    }
    const i = l.indexOf(':')
    if (i < 0) continue
    ensure(cur)[l.slice(0, i)] = l.slice(i + 1)
  }
  return sections
}

function fmtBytes(n: number | null): string {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtUptime(sec: unknown): string {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  return d > 0 ? `${d}天 ${h}小时` : h > 0 ? `${h}小时 ${m}分` : `${m}分`
}

function ttlLabel(ttl: unknown): string {
  const t = Number(ttl)
  if (!Number.isFinite(t)) return '-'
  if (t === -1) return '永不过期'
  if (t === -2) return '不存在'
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m ${t % 60}s`
  if (t < 86400) return `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m`
  return `${Math.floor(t / 86400)}d`
}

// ---------------------------------------------------------------------------
// 连接数据（持久化到插件自己目录下的 JSON）
// ---------------------------------------------------------------------------

interface RedisTarget {
  host: string
  port: number
  username: string
  password: string
  db: number
  tls: boolean
  /** 连接超时（毫秒，dogi 默认 10000） */
  timeoutMs: number
}

/** 一条连接配置（用户可在侧栏里增删改） */
interface Conn extends RedisTarget {
  id: string
  name: string
  /** Key 浏览页打开时的 MATCH 表达式（界面上还能改，改了以界面上的为准） */
  pattern?: string
}

/**
 * jiti 通常把插件转成 **CJS** 执行，那时模块里会有 `__filename`（实测就是插件文件的真实
 * 路径）。ESM 形态下没有这个绑定 —— `typeof` 对未声明的标识符**不抛错**，所以下面的
 * 判空在两种形态下都安全。
 *
 * 顺带记一笔反直觉的事实：`import.meta.url` 在 jiti 下是 `data:text/javascript;base64,…`
 * （jiti 用 eval 跑模块），喂给 `fileURLToPath` 会抛 `The URL must be of scheme file` ——
 * 而它是**模块级**表达式，一抛就是整个插件加载失败。所以这里不碰它。
 */
declare const __filename: string | undefined

/**
 * 连接文件的位置：**插件自己旁边**（真机上就是 `~/.fizz/plugins/.redis-connections.json`）。
 *
 * 兜底顺序：`__filename` → 用户级插件目录。写得啰嗦是因为「插件在哪」这件事在 jiti 下
 * 没有唯一可靠的问法（见上面那段实测）。
 */
const DATA_FILE = ((): string => {
  const dirs: string[] = []
  if (typeof __filename === 'string' && __filename) dirs.push(dirname(__filename))
  dirs.push(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.fizz', 'plugins'))
  return join(dirs[0], '.redis-connections.json')
})()

let conns: Conn[] | null = null
/** 各连接的客户端（按 id；配置变了就丢弃重建） */
const clients = new Map<string, { client: RedisClient; key: string }>()
/** 各连接最近一次出错的原因（侧栏的状态徽章显示它） */
const errors = new Map<string, string>()

/*
 * 这里原本有一张 `browsing` 表：每个连接的「已加载 key / 游标 / 当前哪一屏 / 过滤词 /
 * 点开哪个 key / 命令行输出」都存在**服务端模块作用域**里。
 *
 * 那是块式界面的产物（服务端渲染必须自己攒状态），而且有个真问题：**同一连接开两个标签页
 * 会共用一个 `cursor`**，一边「继续加载」就让另一边跳页。现在这些状态全在浏览器里（每个
 * 标签页各一份），服务端只回答「下一页给我什么」。
 */

/** 命令行里「会改动数据」的命令：命中就在执行后自动刷新（dogi 同款白名单） */
const WRITE_CMD =
  /^(SET|DEL|HSET|HDEL|LPUSH|RPUSH|LSET|LREM|SADD|SREM|ZADD|ZREM|EXPIRE|PERSIST|RENAME)$/i

/** 命令行分词（支持引号包起来的带空格参数） */
function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 切 DB（并把「最后用的 DB」记回连接配置，dogi 同款） */
async function selectDb(conn: Conn, db: number): Promise<void> {
  await withConn(conn, (c) => c.command('SELECT', String(db)))
  conn.db = db
  await saveConns()
}

/** 把任意回复画成一行文字（命令行输出用） */
function stringifyReply(value: unknown): string {
  if (value == null) return '(nil)'
  if (Array.isArray(value)) {
    if (!value.length) return '(empty array)'
    return value
      .map((item, i) => `${String(i + 1)}) ${Buffer.isBuffer(item) ? textVal(item) : String(item)}`)
      .join('\n')
  }
  if (Buffer.isBuffer(value)) return textVal(value)
  if (typeof value === 'object') {
    const v = value as { _simple?: string; _error?: string }
    if (v._simple) return v._simple
    if (v._error) return `(error) ${v._error}`
    return JSON.stringify(value)
  }
  return String(value)
}

async function loadConns(): Promise<Conn[]> {
  if (conns) return conns
  try {
    const text = await readFile(DATA_FILE, 'utf8')
    const parsed = JSON.parse(text)
    conns = Array.isArray(parsed)
      ? parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => normalizeConn(item))
      : []
  } catch {
    // 没有文件 / 文件坏了 = 「还没有连接」，不是错误
    conns = []
  }
  return conns
}

/** 从任意对象读出一条连接（落盘的东西也当不可信输入：只留认识的字段、类型收敛） */
function normalizeConn(raw: Record<string, unknown>): Conn {
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    id: str(raw.id) || randomUUID(),
    name: str(raw.name) || '未命名连接',
    host: str(raw.host, '127.0.0.1'),
    port: num(raw.port, 6379),
    username: str(raw.username),
    password: str(raw.password),
    db: num(raw.db, 0),
    // 弹窗里给的是字符串（'true' / 'false'），落盘的也可能是布尔 —— 两种都认
    tls: raw.tls === true || raw.tls === 'true',
    timeoutMs: num(raw.timeoutMs, 10000),
    ...(str(raw.pattern) ? { pattern: str(raw.pattern) } : {})
  }
}

async function saveConns(): Promise<void> {
  if (!conns) return
  const text = JSON.stringify(conns, null, 2)
  try {
    await writeFile(DATA_FILE, text, 'utf8')
  } catch (err) {
    throw new Error(`连接写不进 ${DATA_FILE}：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 连接与命令
// ---------------------------------------------------------------------------

/** 配置的指纹：变了就重连 */
function keyOf(conn: Conn): string {
  return JSON.stringify([conn.host, conn.port, conn.username, conn.password, conn.db, conn.tls])
}

async function clientFor(conn: Conn): Promise<RedisClient> {
  const key = keyOf(conn)
  const held = clients.get(conn.id)
  if (held && held.key === key && held.client.connected) return held.client
  if (held) held.client.close()
  const client = new RedisClient(conn)
  await client.connect()
  clients.set(conn.id, { client, key })
  errors.delete(conn.id)
  return client
}

/**
 * 跑一批命令；**只有连接真的断了**才记进状态徽章。
 *
 * 这里踩过一次：早先任何命令报错都记进 `errors`，于是「改名的目标 key 已存在」这种
 * **应用级**错误也会让侧栏显示「出错」—— 连接其实好好的。判据是「客户端还连着吗」：
 * `-ERR …` 这类回复不会断开连接，socket 出错 / 解析失败才会（`connected` 变 false）。
 */
async function withConn<T>(conn: Conn, run: (c: RedisClient) => Promise<T>): Promise<T> {
  const client = await clientFor(conn)
  try {
    return await run(client)
  } catch (e) {
    // ⚠️ 只有**连接真的断了**才关它：Redis 的 `-ERR …` 回复（如「目标 key 已存在」）
    // 是应用级报错，连接还是好的 —— 早先一律 `close()`，于是改个名失败就把连接关了，
    // 侧栏徽章也跟着变成「未连接」（其实它一点事都没有）。
    if (!client.connected) {
      client.close()
      clients.delete(conn.id)
      errors.set(conn.id, e instanceof Error ? e.message : String(e))
    }
    throw e
  }
}

interface ScannedKey {
  key: string
  type: string
  binary: boolean
}

/**
 * 扫一页 key（`SCAN` 天然就是「游标 + 一批」）。
 *
 * ⚠️ **跨页判重挪到界面那边**：`SCAN` 文档明确写着「同一个元素可能被返回多次」（它只
 * 保证「遍历开始时就存在的元素至少返回一次」），而「继续加载」是往**同一个数组**追加的。
 * 不判重就会出现两条同 key 的项，界面按 `key` 做 React 列表标识 → 直接报
 * `Encountered two children with the same key`。
 *
 * 界面手里有完整列表，判重比这里准；这一页内部的重复仍在这里去掉（省掉 `TYPE` 往返）。
 */
async function scanPage(
  conn: Conn,
  pattern: string,
  cursor: number
): Promise<{ cursor: number; done: boolean; keys: ScannedKey[] }> {
  // 一整页在**一次** `withConn` 里跑完：`TYPE` 每条 key 一次往返，拆开就要重复取客户端
  return withConn(conn, async (c) => {
    const res = (await c.command(
      'SCAN',
      String(cursor || 0),
      'MATCH',
      pattern || '*',
      'COUNT',
      '200'
    )) as unknown[]
    const next = Number(textVal(res?.[0])) || 0
    const raw = Array.isArray(res?.[1]) ? (res[1] as unknown[]) : []
    const keys: ScannedKey[] = []
    const seen = new Set<string>()
    for (const k of raw) {
      // 非法 UTF-8 的 key 名会被整体 hex 化，那**不是**真 key（拿它去 GET/DEL 只会落空）——
      // 标出来，界面上这一项就不带点击动作，免得点一个永远取不到数据的死条目。
      const binary = isBinaryBuf(k)
      const name = textVal(k)
      if (seen.has(name)) continue
      seen.add(name)
      let type = 'unknown'
      // 二进制 key 名没法按文本发回去（`TYPE` 只会落空）→ 不白跑一次往返
      if (!binary) {
        try {
          type = textVal(await c.command('TYPE', name))
        } catch {
          /* 类型取不到就留 unknown */
        }
      }
      keys.push({ key: name, type, binary })
    }
    return { cursor: next, done: next === 0, keys }
  })
}


type Args = Record<string, unknown>

interface Entry {
  /** 这一条在该类型里的标识：hash=字段名、list=下标、set/zset=成员、stream=entry id */
  id: string
  /** 界面上显示的短名（list 是 `#0`、stream 是 entry id） */
  label: string
  /** 副文本（值 / 分数 / 字段数） */
  detail?: string
}

/**
 * 集合条目按类型该发什么命令（改 / 删 / 新增）。
 *
 * 「hash 两栏、list 一个值、zset 成员+分数」这些差异在这里只写一遍，rpc 那边就只剩
 * 「取参数 → 跑」两步。返回 null 的类型不支持逐条改（string 整块改、stream 只读）。
 */
function entryCommands(type: string): {
  fields: { id: string; label: string; multiline?: boolean }[]
  save: (c: RedisClient, key: string, entry: string, args: Args) => Promise<void>
  add: (c: RedisClient, key: string, args: Args) => Promise<void>
  remove: (c: RedisClient, key: string, entry: string) => Promise<void>
} | null {
  switch (type) {
    case 'hash':
      return {
        fields: [
          { id: 'field', label: '字段' },
          { id: 'value', label: '值', multiline: true }
        ],
        save: async (c, key, entry, args) => {
          const field = String(args.field ?? entry).trim()
          if (!field) throw new Error('字段名不能为空')
          // 字段名被改了 → 先删旧的（HSET 只在同名字段上覆盖）
          if (field !== entry) await c.command('HDEL', key, entry)
          await c.command('HSET', key, field, String(args.value ?? ''))
        },
        add: async (c, key, args) => {
          const field = String(args.field ?? '').trim()
          if (!field) throw new Error('字段名不能为空')
          await c.command('HSET', key, field, String(args.value ?? ''))
        },
        remove: async (c, key, entry) => {
          await c.command('HDEL', key, entry)
        }
      }
    case 'list':
      return {
        fields: [{ id: 'value', label: '元素值', multiline: true }],
        save: async (c, key, entry, args) => {
          const index = Number(entry)
          if (!Number.isInteger(index) || index < 0) throw new Error('下标不对')
          await c.command('LSET', key, String(index), String(args.value ?? ''))
        },
        add: async (c, key, args) => {
          await c.command('RPUSH', key, String(args.value ?? ''))
        },
        // Redis 没有「按下标删」，dogi 的写法：先 LSET 成一个随机哨兵，再 LREM 掉它
        remove: async (c, key, entry) => {
          const index = Number(entry)
          if (!Number.isInteger(index) || index < 0) throw new Error('下标不对')
          const sentinel = `__fizz_del_${randomUUID()}`
          await c.command('LSET', key, String(index), sentinel)
          await c.command('LREM', key, '1', sentinel)
        }
      }
    case 'set':
      return {
        fields: [{ id: 'member', label: '成员' }],
        save: async (c, key, entry, args) => {
          const member = String(args.member ?? entry).trim()
          if (!member) throw new Error('成员不能为空')
          if (member !== entry) await c.command('SREM', key, entry)
          await c.command('SADD', key, member)
        },
        add: async (c, key, args) => {
          const member = String(args.member ?? '').trim()
          if (!member) throw new Error('成员不能为空')
          await c.command('SADD', key, member)
        },
        remove: async (c, key, entry) => {
          await c.command('SREM', key, entry)
        }
      }
    case 'zset':
      return {
        fields: [
          { id: 'member', label: '成员' },
          { id: 'score', label: '分数' }
        ],
        save: async (c, key, entry, args) => {
          const member = String(args.member ?? entry).trim()
          const score = Number(args.score)
          if (!member) throw new Error('成员不能为空')
          if (!Number.isFinite(score)) throw new Error('分数要是数字')
          if (member !== entry) await c.command('ZREM', key, entry)
          await c.command('ZADD', key, String(score), member)
        },
        add: async (c, key, args) => {
          const member = String(args.member ?? '').trim()
          const score = Number(args.score)
          if (!member) throw new Error('成员不能为空')
          if (!Number.isFinite(score)) throw new Error('分数要是数字')
          await c.command('ZADD', key, String(score), member)
        },
        remove: async (c, key, entry) => {
          await c.command('ZREM', key, entry)
        }
      }
    default:
      return null
  }
}

/** 编辑弹窗里要带出的当前值（按类型取那一条） */
async function currentEntry(
  conn: Conn,
  type: string,
  key: string,
  entry: string
): Promise<Record<string, string>> {
  switch (type) {
    case 'hash':
      return {
        field: entry,
        value: textVal(await withConn(conn, (c) => c.command('HGET', key, entry)))
      }
    case 'list':
      return { value: textVal(await withConn(conn, (c) => c.command('LINDEX', key, entry))) }
    case 'set':
      return { member: entry }
    case 'zset':
      return {
        member: entry,
        score: textVal(await withConn(conn, (c) => c.command('ZSCORE', key, entry)))
      }
    default:
      return {}
  }
}

/** 丢掉一个连接上的客户端（配置改了 / 连接被删了） */
function dropClient(id: string): void {
  const held = clients.get(id)
  if (held) held.client.close()
  clients.delete(id)
  errors.delete(id)
}

/** 取值封顶（与 dogi 的 `VCAP` 对齐）：误点开一个百万成员的 key 也不至于把界面拖死 */
const VCAP = 500

/*
 * `editable` 由 `keyPayload` 逐类型给：hash / list / set / zset 可逐条改，string 只能整块改
 * （且二进制值连整块改都不给），stream 只读。别在这一层搞一张「可编辑类型表」——
 * 判断逻辑就在各自的分支里，多一张表迟早会不同步。
 */

/**
 * 按类型取一个 key 的内容。
 *
 * 返回值是**纯数据**（不是块）：界面按 `kind` 决定怎么画。每种类型都给 `total`，
 * 「只画了前 N 条」由界面自己提示 —— 服务端不替它组织文案。
 */
async function keyPayload(conn: Conn, key: string, type: string): Promise<Record<string, unknown>> {
  switch (type) {
    case 'string': {
      const buf = await withConn(conn, (c) => c.command('GET', key))
      const binary = isBinaryBuf(buf)
      return {
        kind: 'string',
        text: textVal(buf),
        // 二进制值不给编辑入口：写回去必然写坏数据（dogi 也是把编辑器设成只读）
        editable: !binary,
        binary,
        bytes: Buffer.isBuffer(buf) ? buf.length : String(buf ?? '').length
      }
    }
    case 'hash': {
      const [flat, total] = await withConn(conn, async (c) => [
        (await c.command('HGETALL', key)) as unknown[],
        Number(await c.command('HLEN', key))
      ])
      const arr = Array.isArray(flat) ? flat : []
      const entries: Entry[] = []
      for (let i = 0; i + 1 < arr.length && entries.length < VCAP; i += 2) {
        entries.push({ id: textVal(arr[i]), label: textVal(arr[i]), detail: textVal(arr[i + 1]) })
      }
      return { kind: 'hash', total, entries, editable: true }
    }
    case 'list': {
      const [arr, total] = await withConn(conn, async (c) => [
        (await c.command('LRANGE', key, '0', String(VCAP - 1))) as unknown[],
        Number(await c.command('LLEN', key))
      ])
      const entries: Entry[] = (Array.isArray(arr) ? arr : []).map((v, i) => ({
        id: String(i),
        label: `#${i}`,
        detail: textVal(v)
      }))
      return { kind: 'list', total, entries, editable: true }
    }
    case 'set': {
      const [arr, total] = await withConn(conn, async (c) => [
        (await c.command('SMEMBERS', key)) as unknown[],
        Number(await c.command('SCARD', key))
      ])
      const entries: Entry[] = (Array.isArray(arr) ? arr : [])
        .slice(0, VCAP)
        .map((v) => ({ id: textVal(v), label: textVal(v) }))
      return { kind: 'set', total, entries, editable: true }
    }
    case 'zset': {
      const [flat, total] = await withConn(conn, async (c) => [
        (await c.command('ZRANGE', key, '0', String(VCAP - 1), 'WITHSCORES')) as unknown[],
        Number(await c.command('ZCARD', key))
      ])
      const arr = Array.isArray(flat) ? flat : []
      const entries: Entry[] = []
      for (let i = 0; i + 1 < arr.length && entries.length < VCAP; i += 2) {
        entries.push({ id: textVal(arr[i]), label: textVal(arr[i]), detail: textVal(arr[i + 1]) })
      }
      return { kind: 'zset', total, entries, editable: true }
    }
    case 'stream': {
      const [body, total] = await withConn(conn, async (c) => [
        (await c.command('XRANGE', key, '-', '+', 'COUNT', String(VCAP))) as unknown[],
        Number(await c.command('XLEN', key))
      ])
      // stream 只读（dogi 的 `EDITABLE` 里也没有它）：改它没有意义，只能追加
      const entries: Entry[] = (Array.isArray(body) ? body : []).map((item) => {
        const pair = Array.isArray(item) ? item : []
        const fieldCount = Array.isArray(pair[1]) ? (pair[1] as unknown[]).length / 2 : 0
        return { id: textVal(pair[0]), label: textVal(pair[0]), detail: `${fieldCount} 个字段` }
      })
      return { kind: 'stream', total, entries, editable: false }
    }
    default:
      return { kind: 'other', type }
  }
}

/** payload 是不可信输入：每条 rpc 都从这里取值，别直接 `p.xxx` */
const asStr = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback
const asNum = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 按 id 找连接；找不到就说清楚（多半是在另一个窗口把它删了） */
async function connById(id: unknown): Promise<Conn> {
  const list = await loadConns()
  const conn = list.find((item) => item.id === asStr(id))
  if (!conn) throw new Error('这条连接已经不在了（可能在别的窗口被删掉）')
  return conn
}

/**
 * 连接状态（侧栏徽章）：只回答「现在什么样」，**不主动连**。
 *
 * 侧栏刷新一下不该把所有没在用的连接都拨一遍 —— 那既慢又会在对端留下连接日志。
 */
function connStatus(conn: Conn): { label: string; tone: 'success' | 'muted' | 'danger' } {
  if (errors.has(conn.id)) return { label: `出错：${errors.get(conn.id)}`, tone: 'danger' }
  const held = clients.get(conn.id)
  if (held?.client.connected) return { label: '已连接', tone: 'success' }
  // 连过又掉了：**把掉线原因说出来**（对端关的 / 网络断了）—— 只说「未连接」，
  // 用户看不出是「压根没连」还是「刚刚断了」。
  if (held?.client.droppedReason) {
    return { label: `已断开：${held.client.droppedReason}`, tone: 'danger' }
  }
  return { label: '未连接', tone: 'muted' }
}

/**
 * 给浏览器看的连接。
 *
 * **不带密码**，只带「有没有设」：界面编辑时留空就表示不改。早先那份是把明文塞进
 * 弹窗字段里过一遍的，没必要。
 */
function connView(conn: Conn) {
  return {
    id: conn.id,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    hasPassword: Boolean(conn.password),
    db: conn.db,
    tls: conn.tls,
    timeoutMs: conn.timeoutMs,
    ...(conn.pattern ? { pattern: conn.pattern } : {}),
    status: connStatus(conn)
  }
}

// ---------------------------------------------------------------------------
// rpc：界面能做的每一件事
// ---------------------------------------------------------------------------

/** 插件目录里不 import `@fizz/plugin`：只声明本插件用到的那一点形状 */
interface RpcLike {
  handle(method: string, handler: (payload?: Args) => unknown): unknown
}

interface PluginCtx {
  rpc: RpcLike
}

/**
 * 前端半的全部后端入口。
 *
 * 一条纪律：**每个 handler 都要能被并发调用**。插件实例每次调用都会现挂一份
 * （和块式渲染同一口径），所以这里不存任何请求级状态 —— 状态在浏览器那边。
 */
export default {
  name: 'redis',
  inject: ['rpc'],
  apply(ctx: PluginCtx) {
    // ---- 连接管理 ---------------------------------------------------------
    ctx.rpc.handle('conns.list', async () => ({ conns: (await loadConns()).map(connView) }))

    ctx.rpc.handle('conns.get', async (p) => connView(await connById(p?.id)))

    ctx.rpc.handle('conns.save', async (p) => {
      const list = await loadConns()
      const id = asStr(p?.id)
      const held = id ? list.find((item) => item.id === id) : undefined
      const password = asStr(p?.password)
      const next: Conn = {
        id: held?.id ?? randomUUID(),
        name: asStr(p?.name).trim() || '未命名连接',
        host: asStr(p?.host).trim() || '127.0.0.1',
        port: asNum(p?.port, 6379),
        username: asStr(p?.username).trim(),
        // 密码留空 = 不改（界面不回显明文，只回「已设置」这个事实）
        password: password || held?.password || '',
        db: asNum(p?.db, 0),
        tls: p?.tls === true || p?.tls === 'true',
        timeoutMs: asNum(p?.timeoutMs, 10000)
      }
      // 配置改了就把旧客户端丢掉：否则下次用还是连着旧地址
      if (!held || keyOf(held) !== keyOf(next)) dropClient(next.id)
      conns = held ? list.map((item) => (item.id === next.id ? next : item)) : [...list, next]
      await saveConns()
      return { id: next.id }
    })

    ctx.rpc.handle('conns.remove', async (p) => {
      const id = asStr(p?.id)
      const list = await loadConns()
      conns = list.filter((item) => item.id !== id)
      await saveConns()
      dropClient(id)
      return {}
    })

    // ---- Key 浏览 ---------------------------------------------------------
    ctx.rpc.handle('keys.scan', async (p) => {
      const conn = await connById(p?.conn)
      return scanPage(conn, asStr(p?.pattern).trim(), asNum(p?.cursor, 0))
    })

    ctx.rpc.handle('key.detail', async (p) => {
      const conn = await connById(p?.conn)
      const key = asStr(p?.key)
      const { type, ttl } = await withConn(conn, async (c) => ({
        type: textVal(await c.command('TYPE', key)),
        ttl: Number(await c.command('TTL', key))
      }))
      const payload = await keyPayload(conn, key, type)
      return { key, type, ttl: Number.isFinite(ttl) ? ttl : -1, payload }
    })

    ctx.rpc.handle('key.set', async (p) => {
      const conn = await connById(p?.conn)
      await withConn(conn, (c) => c.command('SET', asStr(p?.key), asStr(p?.value)))
      return {}
    })

    ctx.rpc.handle('key.remove', async (p) => {
      const conn = await connById(p?.conn)
      await withConn(conn, (c) => c.command('DEL', asStr(p?.key)))
      return {}
    })

    ctx.rpc.handle('key.rename', async (p) => {
      const conn = await connById(p?.conn)
      const from = asStr(p?.key)
      const to = asStr(p?.to).trim()
      if (!to) throw new Error('新名字不能为空')
      if (to === from) return {}
      await withConn(conn, (c) => c.command('RENAME', from, to))
      return { key: to }
    })

    ctx.rpc.handle('key.expire', async (p) => {
      const conn = await connById(p?.conn)
      const key = asStr(p?.key)
      const ttl = asNum(p?.ttl, 0)
      await withConn(conn, (c) =>
        ttl > 0 ? c.command('EXPIRE', key, String(ttl)) : c.command('PERSIST', key)
      )
      return {}
    })

    // ---- 集合条目 ---------------------------------------------------------
    ctx.rpc.handle('entry.get', async (p) => {
      const conn = await connById(p?.conn)
      const type = asStr(p?.type)
      const spec = entryCommands(type)
      if (!spec) throw new Error(`这个类型（${type}）不支持逐条修改`)
      return {
        fields: spec.fields,
        values: await currentEntry(conn, type, asStr(p?.key), asStr(p?.entry))
      }
    })

    ctx.rpc.handle('entry.save', async (p) => {
      const conn = await connById(p?.conn)
      const type = asStr(p?.type)
      const spec = entryCommands(type)
      if (!spec) throw new Error(`这个类型（${type}）不支持逐条修改`)
      await withConn(conn, (c) =>
        spec.save(c, asStr(p?.key), asStr(p?.entry), (p?.args ?? {}) as Args)
      )
      return {}
    })

    ctx.rpc.handle('entry.add', async (p) => {
      const conn = await connById(p?.conn)
      const type = asStr(p?.type)
      const spec = entryCommands(type)
      if (!spec) throw new Error(`这个类型（${type}）不支持逐条修改`)
      await withConn(conn, (c) => spec.add(c, asStr(p?.key), (p?.args ?? {}) as Args))
      return {}
    })

    ctx.rpc.handle('entry.remove', async (p) => {
      const conn = await connById(p?.conn)
      const type = asStr(p?.type)
      const spec = entryCommands(type)
      if (!spec) throw new Error(`这个类型（${type}）不支持逐条修改`)
      await withConn(conn, (c) => spec.remove(c, asStr(p?.key), asStr(p?.entry)))
      return {}
    })

    // ---- DB / 信息 / 命令行 -----------------------------------------------
    ctx.rpc.handle('db.select', async (p) => {
      const conn = await connById(p?.conn)
      const db = asNum(p?.db, -1)
      if (!Number.isInteger(db) || db < 0 || db > 15) throw new Error('DB 编号要是 0-15')
      await withConn(conn, (c) => c.command('SELECT', String(db)))
      conn.db = db
      await saveConns()
      // 已经在那个库上了：把指纹对齐，免得下次当成「配置变了」重连一次
      const held = clients.get(conn.id)
      if (held) held.key = keyOf(conn)
      return { db }
    })

    ctx.rpc.handle('info', async (p) => {
      const conn = await connById(p?.conn)
      const [raw, dbsize] = await withConn(conn, async (c) => [
        textVal(await c.command('INFO', 'ALL')),
        Number(await c.command('DBSIZE'))
      ])
      const sections = parseInfo(raw)
      const stats = sections.stats ?? {}
      const hits = Number(stats.keyspace_hits ?? 0)
      const misses = Number(stats.keyspace_misses ?? 0)
      return {
        raw,
        dbsize: Number.isFinite(dbsize) ? dbsize : 0,
        // 分节给成数组：`Object.entries` 的原样搬运，**顺序就是 Redis 输出的顺序**
        // （对象键序在 JS 里对非数字键是插入序，但插件不该赌这件事）
        sections: Object.entries(sections).map(([name, rows]) => ({
          name,
          rows: Object.entries(rows)
        })),
        overview: {
          version: sections.server?.redis_version ?? '-',
          uptime: sections.server?.uptime_in_seconds ?? '-',
          clients: sections.clients?.connected_clients ?? '-',
          memory: sections.memory?.used_memory ?? '-',
          commands: stats.total_commands_processed ?? '-',
          /** 命中率（0-100，算不出来时给 null，界面上显示 -） */
          hitRate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null
        }
      }
    })

    ctx.rpc.handle('command', async (p) => {
      const conn = await connById(p?.conn)
      const args = tokenize(asStr(p?.line).trim())
      if (!args.length) throw new Error('先写一条命令')
      const wrote = WRITE_CMD.test(args[0].toUpperCase())
      try {
        const value = await withConn(conn, (c) => c.command(...args))
        return { ok: true, text: `$ ${args.join(' ')}\n${stringifyReply(value)}`, wrote }
      } catch (e) {
        /**
         * 命令报错是**正常结果**（`-ERR` 也是数据），不是 rpc 失败：
         * 原样交给命令行区显示，别让宿主弹「调用失败」。
         */
        return {
          ok: false,
          text: `$ ${args.join(' ')}\n(error) ${e instanceof Error ? e.message : String(e)}`,
          wrote: false
        }
      }
    })
  }
}
