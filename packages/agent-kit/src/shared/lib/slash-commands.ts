/**
 * 斜线命令（slash commands）：输入框里以 `/` 开头触发的命令系统。
 *
 * 形态对齐 Claude Code 的输入体验：`/` 浮出命令列表（渲染在输入框上方，见
 * Composer 的 SlashCommandPalette），↑↓ 选择、Tab 补全、Enter 执行；认不出的
 * `/xxx` 按**普通文本**发送（用户明确要求 —— 拦下正文比发错一句话更糟）。
 *
 * 注册表就是一个普通数组：内置命令在 `builtinSlashCommands`（`/init`、`/git-commit`），
 * 调用方（ChatPanel）把它（或它的扩展）传给 Composer。**插话（steer）已不在这里** ——
 * 它改由发送钮上的「队列消息 / 插话」选择器承担（见 composer.tsx 的 `sendChooser`），
 * 不再占一个斜线命令。整套解析 / 分发 / 浮层 / 补全保留：往数组里加命令即生效。
 */
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 命令执行时拿到的上下文：app 门面 + 会话是否在跑（可用性与行为都看它） */
export interface SlashCommandContext {
  app: AgentApp
  /** 活跃会话是否有正在跑的 run（命令的可用性与行为都可能看它） */
  running: boolean
}

export interface SlashCommand {
  /** 命令名（不含斜线）：小写字母开头的 `[a-z0-9-]`，见 parseSlashInput 的正则 */
  name: string
  /** 展示名（命令列表里的中文名） */
  displayName: string
  /** 一句话说明（命令列表与悬浮提示共用） */
  description: string
  /** 参数提示（有参数的命令给，如「要插给 agent 的话」） */
  argsHint?: string
  /**
   * 这条命令**不收参数**（如 `/init`：落点固定，多打的字没有意义）。
   *
   * 为什么需要显式声明：分发的默认判据是「没给参数就 reject 并提示 argsHint」——
   * 那对**有**参数的命令是对的（用户意图明确是在敲命令却漏了参数，提示比照发出去好）。
   * 但对无参命令它会让命令**永远执行不了**：`/init` 必然落到 reject 分支。
   * 「有没有 argsHint」不能拿来当这个判据 —— 有参命令也可能不写 argsHint。
   */
  noArgs?: boolean
  /**
   * 可用性（返回 false 的命令不进列表）：命令存在 ≠ 此刻能用，比如只对某种会话
   * 后端有意义的命令（依赖服务端注入的那种，外部 agent 的协议给不了）。
   */
  available?: (ctx: SlashCommandContext) => boolean
  /** 执行：args 是去掉 `/{name}` 之后的剩余文本（已 trim） */
  run: (ctx: SlashCommandContext, args: string) => void
}

/** 解析 `/name args…`；不是命令形状（不以 / 开头 / 名字非法）返回 null */
export function parseSlashInput(text: string): { command: string; args: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/.exec(text.trim())
  if (!match) return null
  return { command: match[1], args: (match[2] ?? '').trim() }
}

/**
 * `resolveSlashDispatch` 的裁决结果（**纯数据**：执行与提示都由调用方做）。
 */
export type SlashDispatch =
  /** 认成命令，执行它 */
  | { kind: 'run'; command: SlashCommand; args: string }
  /** 认成命令但办不了：提示用户、**不要发出去** */
  | { kind: 'reject'; message: string }
  /** 不是命令语境：按**普通文本**发送 */
  | { kind: 'text' }

/**
 * 这条输入该不该当命令执行。**纯函数**（不碰 app、不发消息），所以能单测。
 *
 * ## `/` 开头 ≠ 命令：认不出的全部按普通文本发送
 *
 * 这个方向上用户报过两次：
 *
 * 1. 发以 `/` 开头的正文（路径 `/usr/local/bin`、正则、带 `/` 的说明），被整条吞掉
 *    回「未知命令」。根子是早先的判据写成「**以 `/` 开头就是命令**」；后来收成
 *    「`/名字` 形状成立」（名字 = `[a-z][a-z0-9-]*`），路径、正则写法、连续斜杠
 *    这些**天然不可能**匹配，直接走 text。
 *
 * 2. 形状对但名字不在表里（`/stre` 敲错、或用户根本没想敲命令的单词 `/done`），
 *    最初也拦下提示「未知命令」——但「发不出去」比「agent 收到一句带斜杠的话」
 *    更糟（用户明确要求改成照发）：命令表会不断扩充，拦下的那一刻用户只看到
 *    一句报错、写的正文没了。所以**名字认不出的一律按正文发送**。
 *
 * 仍然拦下的只剩两种「命令是真的」情况：缺参数（提示 argsHint）、命令存在但
 * 当前会话不可用 ——这两种用户意图明确就是在敲命令，把命令原文发给 agent 才是害他。
 */
export function resolveSlashDispatch(text: string, commands: SlashCommand[]): SlashDispatch {
  const parsed = parseSlashInput(text)
  if (!parsed) return { kind: 'text' }
  const command = commands.find((c) => c.name === parsed.command)
  // 名字不在表里 = 不是命令（哪怕形状像）：按普通文本发送，别拦（见上方文档第 2 条）
  if (!command) return { kind: 'text' }
  // ⚠️ 这里**刻意不看** `command.available`：它要 ctx，纯函数拿不到。
  // 可用性归 resolveSlashDispatchFor 的 isAvailable 管；本函数只回答「形状 / 名字 /
  // 参数」三件事。想在无 ctx 的场景（单测、纯静态分析）判可用性，调用方自己
  // 先 filter 好再传进来即可。
  if (!parsed.args) {
    // 无参命令（`/init`、`/git-commit`）直接进 run：它们的落点是固定的，走 reject
    // 就永远执行不了。
    // ⚠️ 这条**不能**反过来放宽成「有 argsHint 就拦、没就放行」—— 命令名认不出时
    // 上一步已经归 text 了，能走到这里的都是表里的命令，缺参数对它们就是漏了。
    if (command.noArgs) return { kind: 'run', command, args: '' }
    return { kind: 'reject', message: `/${command.name} ${command.argsHint ?? '需要参数'}` }
  }
  return { kind: 'run', command, args: parsed.args }
}

/**
 * `resolveSlashDispatch` 的**带上下文**版本：`isAvailable` 由调用方按 ctx 现算
 * （`available` 的签名要 ctx，纯函数拿不到）。
 *
 * ChatPanel 走这个：它那边 `slashContext` 是现成的。
 */
export function resolveSlashDispatchFor(
  text: string,
  commands: SlashCommand[],
  isAvailable: (c: SlashCommand) => boolean
): SlashDispatch {
  const outcome = resolveSlashDispatch(text, commands)
  // 「run」还要再过一道可用性：命令存在 ≠ 此刻能用（steer 在 ACP 会话上就用不了）
  if (outcome.kind !== 'run') return outcome
  if (!isAvailable(outcome.command)) {
    return { kind: 'reject', message: `/${outcome.command.name} 在当前会话不可用` }
  }
  return outcome
}

/** 按输入前缀过滤命令（`/st` → steer）；`token` 含开头斜线或不含都行 */
export function filterCommands(commands: SlashCommand[], token: string): SlashCommand[] {
  const prefix = token.replace(/^\//, '').toLowerCase()
  return commands.filter((c) => c.name.startsWith(prefix))
}

/**
 * 内置斜线命令。
 *
 * 注册表就是下面这个数组：加进来浮层、补全、`resolveSlashDispatch*` 立刻认它。
 *
 * 两条命令都**交给模型**，也没有参数：
 *
 * - `/init`：读项目、写 AGENTS.md。AGENTS.md 的价值全在正文（每轮全文注入的硬约束），
 *   一份「标题 + 空小节」的骨架等于让用户自己再写一遍 —— 早先就是这么做的，用户
 *   拿到手发现是空模板。所以它发一条提示词，让模型读项目、自己写（见 `INIT_PROMPT`）。
 * - `/git-commit`：把当前改动提交一次。提交信息由模型看 diff、照着仓库既有风格生成
 *   （见 `GIT_COMMIT_PROMPT`）—— 不接受用户手写的信息，免得两套入口。
 *
 * 本文件里没有 fs / fetch，只有「发消息 + 出提示」。
 */
export function builtinSlashCommands(ctx: SlashCommandContext): SlashCommand[] {
  /**
   * 「这个工作区能不能动」：**只有一条判据 —— `activeWorkspace.path` 要在**。
   *
   * 内置「任务」是**虚拟工作区**（path 为空，它没有磁盘目录）；聊天页本身已经
   * `disabled: !activeWorkspace`，所以「连没连线」不必在这里再判一遍（真没连上的话
   * 这条路会走到 store 的 `getApi()` 返回 null，得到一句「未连接」—— 那是对的提示）。
   *
   * 顺带记一条同源的教训（文件面板 `canReveal/canDownload` 踩过）：**只看「有没有这个
   * 方法」会漏判平台**。这里反过来 —— 只看 `path` 就够，git 与落点都由服务端按工作区
   * 登记的路径算，前端无从也无需预判。
   */
  const needsWorkspace = (c: SlashCommandContext): boolean => !!c.app.activeWorkspace?.path

  return [
    {
      // `/init` 是 AGENTS.md 生态的既有约定（Claude Code 与 opencode 的 `/init` 都是
      // 「为这个项目生成 AGENTS.md」），跟着它走的好处是从别的工具迁过来的人不用重学。
      //
      // ⚠️ **不发模板**：早先走 `scaffoldFile({kind:'agents'})`，落一份「标题 + 四个空
      // 小节」，用户敲完拿到的是还得自己填的骨架 —— 而这个文件的全部价值就在内容。
      // 现在改成把 `INIT_PROMPT` 发给模型：它读一遍项目，写出一份**已经能生效**的文档。
      name: 'init',
      displayName: '生成项目约束文档',
      description: '读一遍这个项目后生成 AGENTS.md（下一轮对话会被全文注入系统提示词）',
      noArgs: true,
      available: needsWorkspace,
      run: (c) => {
        void runInit(c)
      }
    },
    {
      // 提交信息一律由模型按改动生成：接受用户手写会多一套解析与「照抄还是润色」的
      // 争议，而这条命令要的只是「看一眼改动，写清楚，提交」。
      name: 'git-commit',
      displayName: '提交改动',
      description: '让模型看当前改动、生成提交信息并提交',
      noArgs: true,
      available: needsWorkspace,
      run: (c) => {
        void runGitCommit(c)
      }
    }
  ]
}

/**
 * `/init` 发给模型的提示词。
 *
 * 这几条必须在提示词里说死，否则模型很容易交出一份「项目介绍」：
 *
 * 1. **先读再写**（README / 依赖清单 / 目录结构 / 抽读入口文件），不许按框架名猜；
 * 2. **只写每轮都要在场的硬约束**，不写项目介绍、功能清单、目录树、安装教程 ——
 *    这份文件每轮全文注入，写多了就是每轮多付一次 token（上限见 `project-doc.ts`
 *    的 `MAX_PROJECT_DOC_CHARS`，超了会被截断）；
 * 3. **已存在就改、不重写**：那可能已经是用户手写过的资产，整份覆盖等于毁数据
 *    （与 scaffold 的「已存在 409」同一个立场）。
 *
 * 落点写死「项目根目录的 AGENTS.md」：`PROJECT_DOC_NAMES[0]` 就是它，模型建到子目录
 * 或改名成 CLAUDE.md 都读不到（根文档只读工作区根）。
 */
const INIT_PROMPT = `读一遍这个项目，然后在**项目根目录**生成 AGENTS.md（与 README、依赖清单同级；不要建在子目录，不要改名成 CLAUDE.md）。

先读，再动笔：
- 读 README / 依赖清单（package.json、pyproject.toml、Cargo.toml、go.mod 之类）/ 顶层目录结构；
- 跳过 node_modules、dist、build、.git、vendor 这类产物或第三方目录；
- 技术栈、构建命令、目录职责只写你在文件里**看到**的；不确定就抽读几个入口文件确认，别按框架名猜。

内容只写「每一轮对话都必须遵守」的硬约束，不要项目介绍、功能清单、目录树、安装教程。建议按这几节组织（用不上的删掉）：
- 验证纪律：怎么算验证过了、哪些检查默认不跑
- 架构：主要目录 / 模块各自的职责，新增代码该放哪
- 硬约束：违反就会静默出错或破坏数据的规则（一条一行）
- 环境速查：构建 / 测试命令、平台差异、已知的坑

每条都要具体到能照做（写清命令、路径、写法）；没有依据的宁可不写。

如果项目根已经有 AGENTS.md：先读它，在原内容上补充 / 修正，**不要整份重写**，已有的正确条目一律保留。
如果根目录只有 CLAUDE.md（没有 AGENTS.md）：先读它，把里面的规则整理进新写的 AGENTS.md —— 两个文件同时存在时只读 AGENTS.md，留在 CLAUDE.md 里的东西会失效。

写完告诉我：新增或改了哪些条目，以及哪些地方你还不确定、要我确认。`

/**
 * `/init` 的执行：发一条提示词，让模型自己读项目、写 AGENTS.md。
 *
 * 用 `app.send` 而不是把提示词塞进输入框：敲完命令就该开跑，不该再让用户按一次回车
 * （Claude Code 的 `/init` 也是这个手感）。这一轮与普通对话一样进消息列表 —— 模型读了
 * 什么、写了什么用户都看得见，本来也该可审。
 *
 * 正在跑的时候 `send` 会把这条塞进「待发送」队列（`enqueueMessage`），命令仍然成立：
 * 上一轮结束就接着分析项目。真正发不出去（没会话 / 被本地守卫拦下）才提示。
 */
async function runInit(c: SlashCommandContext): Promise<void> {
  if (!c.app.activeWorkspace?.path) {
    // 正常走不到（`available` 已经拦过），兜住「命令表被别处复用」的情况
    c.app.setError('先选一个有磁盘目录的项目（内置「任务」没有目录，写不了 AGENTS.md）')
    return
  }
  const ok = await c.app.send(INIT_PROMPT)
  if (!ok) c.app.setError('没能发出 /init：这一下被拦住了（压缩上下文中 / 没有可用会话），稍后再试')
}

/**
 * `/git-commit` 的提示词。
 *
 * 提交信息由模型根据改动生成 —— 不给用户手写入口，所以这里要把「怎么写」说清楚：
 * 先看 status / diff，再参考 `git log` 的既有风格；一句话说清做了什么、为什么。
 *
 * 边界同样写死：只提交这次改动相关的文件（无关文件 / 密钥 / 构建产物不碰）、
 * **不 push**（提交与推送是两个决定）、失败要贴 git 的原话而不是一句「提交失败」。
 */
const GIT_COMMIT_PROMPT = `为当前工作区做一次提交。

先看，再决定：
- \`git status\` / \`git diff\`（必要时 \`git diff --staged\`）弄清楚改了哪些文件、改了什么；
- \`git log --oneline -10\` 看一眼这个仓库的提交信息风格，照着写。

提交信息由你根据改动生成：一句话说清「做了什么、为什么」，具体到一眼能看懂；仓库已有固定风格（比如 Conventional Commits）就照它写，没有就别硬加前缀。

只把这次改动相关的文件加入暂存区；无关文件、密钥、构建产物一律不要提交。
不要 push —— 这条命令只做提交。
如果工作区没有可提交的改动，直接告诉我，不要造空提交。
完成后把提交 hash 与提交信息告诉我；失败就把 git 的原话贴出来。`

/**
 * `/git-commit` 的执行：和 `/init` 同一条路 —— 发一条提示词，让模型自己在工作区里提交。
 *
 * 不在前端直接调 `gitAction('commit')` 的原因：提交前要先弄清「哪些文件该进这次提交」
 * 并生成提交信息，那正是模型看 diff 的活；前端只负责把边界（不 push / 不碰无关文件）
 * 用提示词钉死。
 */
async function runGitCommit(c: SlashCommandContext): Promise<void> {
  if (!c.app.activeWorkspace?.path) {
    c.app.setError('先选一个有磁盘目录的项目（内置「任务」没有目录，提交不了）')
    return
  }
  const ok = await c.app.send(GIT_COMMIT_PROMPT)
  if (!ok) c.app.setError('没能发出 /git-commit：这一下被拦住了（压缩上下文中 / 没有可用会话），稍后再试')
}
