/**
 * 内置插件：让 Agent 执行的 shell 命令**透明地**走一遍 RTK（https://www.rtk-ai.app）。
 *
 * `git status` → `rtk git status`。输出过滤发生在 `rtk` 进程内部，所以这里**不需要**
 * `tool:result` 钩子，也不需要自己解析任何输出格式 —— 插件只负责「把命令串换成另一条命令串」。
 *
 * ## 为什么挂在 `tool:call` 上，而不是包一层执行器
 *
 * `bash`（旧名 `execute_command`）里已经有输出落盘（`.fizz/tool-output/`）、进程树 kill、
 * `guardWrite` 审批、`onCommandOutput` 流式回调。改那条路等于把这些全部重做一遍，而且
 * `run_in_terminal`（客户端 PTY）根本不走它。`tool:call` 是唯一的公共咽喉：
 *
 *   - 它在**审批闸外层**（`packages/agent/src/agent.ts` 先 `wrapToolsWithApproval`、
 *     后 `wrapToolsWithHooks`），所以确认卡上显示的就是**真正要跑的那条**命令；
 *   - 它不改模型的 tool-call 入参（AI SDK 早已记录），历史里永远是 `git status`，
 *     上下文不会被 `rtk` 前缀污染；
 *   - `bash` 与 `run_in_terminal` 一条代码覆盖两种执行环境。
 *
 * ## ⚠️ 监听器必须同步
 *
 * `waterfall`（`packages/plugin/src/context.ts`）没有 `await`，`wrapToolsWithHooks` 也是
 * 同步调用它。监听器返回 Promise 会被当成**工具入参**原样交给模型，症状是工具报
 * 「command 不是字符串」。所以这里只能用 `execFileSync`，不能用 `execFile` / `spawn`。
 * 代价是阻塞服务端事件循环，用「300ms 超时 + 结果缓存」把窗口压到 RTK 自己宣称的 <10ms。
 *
 * ## 为什么**默认关**
 *
 * RTK 是第三方二进制，装没装、装在哪个 PATH 上，每台机器都不一样；而内置插件对所有
 * 使用者生效。默认改写别人的命令不可接受，所以出厂态是「装上了、但一条命令都不碰」。
 *
 * 出厂默认走的是**设置项 `enabled`（默认 false）**，不是 `plugins/plugins.yml` 的
 * `enabled: false`。后者是**硬关**：`discoverPlugins` 算的是
 * `(entry.enabled ?? true) && !disabled.has(id)`，而 `PluginSettings` 只有 `disabled`
 * 停用名单、没有「显式启用」名单 —— 写了 yml 的 false，用户在面板上勾「启用」也翻不过来
 * （勾选只是把 id 从 disabled 里移除，`false && …` 仍是 false），于是变成一个「开关点了没用」
 * 的 bug。设置项这条路是软的：勾上保存即生效（设置值进了挂载指纹，服务端会重新 mount）。
 *
 * ## Windows 的 PATH 坑
 *
 * `spawnSync` 不走 shell，只认得到 `.exe`。winget 装出来的是 `rtk.exe`，正常；
 * 若只解析到 `.cmd` shim 会 ENOENT —— 那种情况把「rtk 可执行文件」填成绝对路径。
 *
 * ## 退出码（**必须看 `rtk rewrite --help` 的口径，别凭「非零就是失败」直觉写**）
 *
 * `rtk rewrite` 有四个退出码，其中**两个都会打印改写结果**：
 *
 * | 码 | 含义 | 这里怎么处理 |
 * | --- | --- | --- |
 * | 0 | 有改写，且 allow 规则覆盖每条命令 | 用 stdout |
 * | 1 | 没有等价写法（或命令被排除 / 含 `$(...)`、重定向等不处理的构造） | 原命令 |
 * | 2 | deny 规则命中 | 原命令（本插件只负责改写，不替 RTK 拦命令） |
 * | 3 | **有改写**，但 ask 规则命中 / allow 规则没覆盖全部 | **用 stdout** |
 *
 * ⚠️ 码 3 是「没配 Claude Code 那种 hook / 一条 allow 规则都没有」时的**常态** ——
 * 按「非零 = 没改写」处理会让插件在默认配置下**一条命令都不改写**（真发生过：
 * 开关打开、`git status` 照旧直跑）。所以这里用 `spawnSync` 读 `status`，不用
 * `execFileSync`（它对非零退出直接抛，只能靠 catch 把码 3 的 stdout 一起丢掉）。
 *
 * ## 单条命令不过滤：`rtk bypass`，不是 `RTK_DISABLED=1`
 *
 * rtk 自己认命令前缀 `RTK_DISABLED=1 git status`（`rtk rewrite` 返回 exit 1，本插件走到
 * exit 1 就原样放行，端到端是通的）。但那是 **POSIX 的 `VAR=val cmd` 语法**：Windows 上
 * `bash` 优先 Git Bash 时能用，退回 cmd / PowerShell 就变成「不是内部或外部命令」
 * —— 看起来像插件的锅，其实是 shell 语法。
 *
 * 所以给用户 / 模型的建议一律是 **`rtk bypass <命令>`**：它就是一条普通命令，各 shell 都合法，
 * 语义也正好是「执行但不过滤」（仍统计用量）。插件看到命令以 `rtk ` 开头会直接放行
 * （`^\s*rtk\b`），不会套娃。输出过滤完才发现不够看，还有 `rtk recall <hash>` 把省略的部分捞回来。
 *
 * ## 降级约定
 *
 * 任何异常都回退原命令（与 RTK 自己的 hook 同一条规矩：永不阻塞命令执行）。只有
 * ENOENT / EACCES（装了没装、有没有执行权限）才 `warn` 一次，其余静默。
 */
import { spawnSync } from 'node:child_process'

/**
 * 会跑 shell 命令的工具 → 改写它的 `command` 字段，其余入参原样透传。
 *
 * ⚠️ 名字必须与 `packages/tools/src/tools.ts` 里的注册名**逐字一致**：钩子按下发的
 * 工具名匹配，匹配不上一律原样放行 —— 不报错、不打日志，症状是「开关打开了，命令照旧直跑」。
 * 改名时漏了这里就是一次静默失效（2026-11 `execute_command` → `bash` 已经踩过一次）。
 */
export const SHELL_TOOLS = new Set(['bash', 'run_in_terminal'])

/** 重写缓存上限（命令串 → 改写后的命令串）。纯函数，同一进程内可复用 */
const CACHE_MAX = 200
const cache = new Map<string, string>()
/** 「rtk 不可用」只提醒一次：否则开了开关却没装 rtk 会把日志刷满 */
let warnedUnavailable = false

/**
 * 插件图标：一个终端窗口 + 提示符（自绘 SVG，全部绝对坐标、无弧命令）。
 *
 * 别改成凭印象抄来的官方 logo path —— 坐标里混进非法数字会**整条 path 被浏览器丢弃**，
 * 界面上只剩一个空白占位块，而服务端侧一切正常（`ctx.ui.icon` 只校验是不是 data:image/*）。
 */
const ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2" y="4" width="20" height="16" rx="3"/>' +
    '<path d="M7 10l3 2.5-3 2.5"/>' +
    '<path d="M13 15h4"/>' +
    '</svg>'
)}`

/** 插件设置（键名 = `ctx.ui.setting` 的 id，见 `pluginRuntimeConfig`） */
interface RtkConfig {
  enabled?: boolean
  terminal?: boolean
  bin?: string
  timeoutMs?: number
}

/**
 * 插件 ctx 的最小结构化类型（不 import `@fizz/plugin`）：内置插件根虽然在仓库里，
 * 但插件目录的解析规则不该依赖 workspace 包能解析到 —— 类型只写用得到的那几项。
 */
interface PluginCtx {
  logger: { warn: (...args: unknown[]) => void }
  inject(deps: string[], cb: (c: PluginCtx) => void | (() => void)): unknown
  ui: { icon(uri: string): unknown; setting(item: unknown): unknown }
  hooks: {
    on(
      name: string,
      listener: (toolName: string, input: unknown, next: () => unknown) => unknown
    ): unknown
  }
}

function readSettings(config: RtkConfig | undefined) {
  return {
    /**
     * 出厂默认**关**：`default` 只是界面初值、不会进 config（见 create-fizz-plugin skill 3.3），
     * 所以「没配过」必须按关处理 —— 用 `=== true` 而不是 `!== false`。
     */
    enabled: config?.enabled === true,
    terminal: config?.terminal === true,
    bin: typeof config?.bin === 'string' && config.bin.trim() ? config.bin.trim() : 'rtk',
    timeoutMs: Number.isFinite(config?.timeoutMs) ? Number(config?.timeoutMs) : 300
  }
}

function remember(command: string, rewritten: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(command, rewritten)
}

/**
 * 把一条命令交给 `rtk rewrite`，拿回改写后的命令串。
 *
 * 契约：**退出码 0 与 3 都表示「stdout 是改写后的命令」**（区别只在审批要不要交给宿主，
 * 见文件头那张表）；1 = 没有等价写法（stdout 空）；2 = deny 命中。所以判据是
 * 「状态码 ∈ {0,3} 且 stdout 非空」，**不是**「进程没抛异常」。
 *
 * 缓存只在**确定答案**时写：0 / 1 / 3。ENOENT、超时、deny 都不缓存 —— 那几种都可能
 * 只是「rtk 还没装好 / 这次配置挡了」，下一条命令该重新问一次。
 */
function rewriteCommand(
  command: string,
  bin: string,
  timeoutMs: number,
  ctx: PluginCtx
): string {
  const hit = cache.get(command)
  if (hit !== undefined) return hit

  const result = spawnSync(bin, ['rewrite', command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })

  if (result.error) {
    // 不缓存：可能只是「rtk 还没装好」，用户装完之后下一条命令就该生效
    const code = (result.error as NodeJS.ErrnoException).code
    if ((code === 'ENOENT' || code === 'EACCES') && !warnedUnavailable) {
      warnedUnavailable = true
      ctx.logger.warn(
        `[rtk] 命令重写不可用（${bin}：${code}）；已回退为原命令执行。` +
          '装了 rtk 仍报这个，就在「设置 → 插件 → RTK 命令重写」里把可执行文件填成绝对路径。'
      )
    }
    return command
  }

  const status = result.status
  const text = (result.stdout ?? '').trim()
  // 0 = 改写且 allow 覆盖；3 = 改写但审批交给宿主。两者都用 stdout
  if ((status === 0 || status === 3) && text && text !== command) {
    remember(command, text)
    return text
  }
  // 1 = 没有等价写法；0/3 但 stdout 为空或就是原命令 = 明确不改写。都能缓存
  if (status === 0 || status === 1 || status === 3) {
    remember(command, command)
    return command
  }
  // 2 = deny 命中（RTK 自己的权限规则）：本插件只负责改写，不替它拦命令 → 原样执行、不缓存
  return command
}

/**
 * 关掉 rtk 自己那条「没装 hook」的推销提示。
 *
 * rtk 每次启动（**任何子命令**，不只 `rewrite`）都会往 stderr 打一行：
 *
 * ```
 * [rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings
 * ```
 *
 * 它默认宿主是 Claude Code，而我们的接入方式是本插件（不装它的 hook），所以这行是**常态**。
 * 关键问题是它**不会白打**：`bash` 把 stdout 与 stderr 一起拼进
 * 工具结果（`packages/tools/src/tools.ts`），于是**每一条被改写的命令都多付一行 + 一条
 * 无用的行动建议**，纯噪音、纯 token。
 *
 * rtk 认 `RTK_SUPPRESS_HOOK_WARNING`（实测 `=1` 后 stdout/stderr 都干净，改写结果与退出码
 * 不变），但它是**进程级**开关：插件能改的只有命令串，而 `bash` 是拿
 * `process.env` 起子进程的 —— 所以只能往服务端进程的环境里塞一次，让所有子命令继承。
 * 这个键只有 rtk 会读，对别的命令无副作用。
 *
 * ⚠️ 终端里的 `run_in_terminal` 是客户端 PTY 起的进程，继承不到服务端环境，那边仍会看到
 * 这行 —— 但那是用户自己看的，不进模型上下文，不算浪费。
 */
function suppressHookWarning(): void {
  if (process.env.RTK_SUPPRESS_HOOK_WARNING) return
  process.env.RTK_SUPPRESS_HOOK_WARNING = '1'
}

export default {
  name: 'RTK 命令重写',

  /**
   * 顶层不声明依赖 = **任何 context 都 apply**：设置项与图标必须在设置页那次 inspect 里
   * 被收集到，而那里没有 `hooks`；反过来 turn context 里又没有 `ui`。所以两半各自
   * `ctx.inject` 声明依赖（同 `oss.ts` / `storage-to.ts` 的写法）。
   */
  inject: [],

  apply(ctx: PluginCtx, config?: RtkConfig) {
    const settings = readSettings(config)

    // ---- 设置项与图标：只要宿主提供 ui（设置页 inspect 有，长驻 context 也有）----
    ctx.inject(['ui'], (c) => {
      c.ui.icon(ICON)
      c.ui.setting({
        id: 'enabled',
        title: '启用 RTK 命令重写',
        type: 'boolean',
        default: false,
        description:
          '打开后 git status 这类命令会被改写成 rtk git status（输出在 rtk 进程里过滤，省 token）。' +
          '想对单条命令不过滤：写成 rtk bypass <命令> —— 各平台各 shell 都合法。' +
          'Windows 上别用 RTK_DISABLED=1 <命令>：那是 POSIX 语法，没有 Git Bash 时会直接报「不是内部或外部命令」。'
      })
      c.ui.setting({
        id: 'terminal',
        title: '也改写终端里的命令',
        type: 'boolean',
        default: false
      })
      c.ui.setting({
        id: 'bin',
        title: 'rtk 可执行文件',
        type: 'string',
        default: 'rtk'
      })
      c.ui.setting({
        id: 'timeoutMs',
        title: '单次重写超时（毫秒）',
        type: 'number',
        default: 300
      })
    })

    // 默认关：没显式打开就一条命令都不碰，连钩子都不注册
    if (!settings.enabled) return

    suppressHookWarning()

    ctx.inject(['hooks'], (c) => {
      c.hooks.on('tool:call', (toolName, _input, next) => {
        /**
         * around 范式：先 `next()` 放行、拿到下游的入参，再加工返回。
         * 不能写成 `next(新值)` —— 框架恒以原始 args 调用链上下一个监听器，新值传不过去。
         */
        const current = next()
        if (!current || typeof current !== 'object') return current
        if (!SHELL_TOOLS.has(toolName)) return current
        // 终端里的命令用户自己看得见，加前缀是噪音 → 单独开关、默认不开
        if (toolName === 'run_in_terminal' && !settings.terminal) return current

        const command = (current as { command?: unknown }).command
        if (typeof command !== 'string' || !command.trim()) return current
        /**
         * 已经是 rtk 的：别套娃。
         *
         * ⚠️ 这里**刻意不读 `process.env.RTK_DISABLED`**（原来有一句，已删）。两件事别搞混：
         *
         * - 「单条命令不过滤」是 **rtk 自己**的机制：命令前缀 `RTK_DISABLED=1 git status`，
         *   `rtk rewrite` 认它并返回 exit 1（实测 `rtk hook check` 也是 `No rewrite for: …`），
         *   本插件走到 exit 1 就原样放行 —— 端到端本来就通，不需要这一层再判一次。
         * - 而**进程环境**里的 `RTK_DISABLED=1` rtk 根本不认（实测：设进环境后 `rewrite`
         *   照样返回改写结果）。留着那个判断只会变成第二个总开关：设置页显示「已启用」、
         *   实际一条命令都不改写，且没有任何界面提示 —— 排查时只能靠猜。
         *
         * 总开关只有设置项 `enabled` 一个（见文件头「为什么默认关」）。
         */
        if (/^\s*rtk\b/.test(command)) return current

        const rewritten = rewriteCommand(command, settings.bin, settings.timeoutMs, ctx)
        if (rewritten === command) return current
        return { ...(current as Record<string, unknown>), command: rewritten }
      })
    })
  }
}
