/**
 * Agent 对话编排：系统提示词、历史消息转换、流事件适配。
 * 工具集见 @fizz/tools；streamText 的实际调用由主进程（持有模型配置）完成。
 */
/** Agent 消息 / 历史转换已抽到独立文件（对 ai 只有 type-only import，可被验证脚本独立加载） */
import type { AgentMessagePart } from './model-messages'
export type { AgentMessagePart } from './model-messages'
export {
  attachmentParts,
  attachmentsToParts,
  createInlineBudget,
  MAX_INLINE_TOTAL_BYTES,
  planAttachments,
  toModelMessages
} from './model-messages'
export type {
  InlineBudget,
  PlannedAttachment,
  ResolvedAttachment,
  ResolveAttachment,
  UploadLikeFile
} from './model-messages'
import { buildAgentTools, type AgentPermissionMode, type AgentToolOptions, BROWSER_PROMPT_SECTION } from '@fizz/tools'
import { buildSkillsPromptSection, type AgentSkill } from '@fizz/skills'
import { buildProjectDocSection, type ProjectDoc } from './project-doc'
import { getLanguage } from '@fizz/i18n'
import { DEFAULT_MAX_STEPS } from '@fizz/contracts/agent-api'

/**
 * Agent 单轮对话的最大工具步数（**缺省值**，调用方可用 `RunAgentOptions.maxSteps` 覆盖）。
 *
 * 常量本体在契约里（`DEFAULT_MAX_STEPS`）：设置 → AI → 偏好 那一页要读同一个数，而
 * 浏览器侧不能 import 本包（会把整个运行时拖进前端产物）。这里保留导出，是为了让
 * 「不传 `maxSteps` 时走多少」在这一层一眼可见；取值理由（为什么 80 而不是 500）见契约。
 */
export const MAX_STEPS = DEFAULT_MAX_STEPS

export type { AgentPermissionMode, AgentToolOptions, AgentSkill }
export { buildAgentTools }

export interface AgentHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentMessagePart[]
  createdAt: number
}

/** 流事件（reasoning-delta 为思考内容增量；形状与 AiStreamEvent 的历史约定一致） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      isError?: boolean
    }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; message: string }

/**
 * 「每次工具调用都要填 `intent`」这条使用约定。
 *
 * **单独成段、由 `buildAgentSetup` 按开关追加**，不写进 `buildAgentSystemPrompt` 的正文：
 * 这条约定只有在真的往工具 schema 注入了 `intent` 时才成立（见 `engine.ts` 的
 * `withToolIntent` 与设置里的「工具意图」开关）。schema 里没有这个字段却让模型填，
 * 模型只会把它塞进别的参数里，或者开始编造字段名。
 */
export function toolIntentHint(): string {
  return getLanguage() === 'en'
    ? [
        '',
        '- Every tool call must fill `intent`: one short sentence (≤20 chars, in the user’s language) saying what this step should achieve — it is shown as the card title, so do not restate the tool name or arguments.'
      ].join('\n')
    : [
        '',
        '- 每次调用工具都要填 `intent`：一句话（≤20 字，用用户的语言）说明这一步要达成什么 —— 它就是工具卡的标题，不要复述工具名或参数。'
      ].join('\n')
}

/**
 * 「这一轮有步数预算」这条约定（系统提示词里的**静态**一段）。
 *
 * 为什么值得花这几十个 token：模型不知道有闸，就会把「再查一个文件 / 再跑一次命令」无限
 * 续下去，直到被 `stepCountIs` 硬停 —— 那时它连一句「做到哪了」都没机会说。提前告诉它
 * 有预算，它才会先规划、把验证与结论排进前 N 步。
 *
 * ⚠️ **只能放常量预算，绝不能放「还剩几步」**：系统提示词是请求最前面的那几 k token，
 * 一旦它随步数变化，上游前缀缓存就从第一个 token 起全部失效 —— 每一步都按全价重读整段
 * 历史（第 N 步的成本本来就是第 1 步的 N 倍，再乘一次就是灾难）。动态的剩余步数走
 * `stepBudgetReminder`（步骤边界注入到消息尾部，只影响尾部那一小段前缀）。
 *
 * 由 `buildAgentSetup` 按调用方传入的 `maxSteps` 追加（见那里的说明），
 * 一轮只出现一次。
 */
export function stepBudgetHint(maxSteps: number): string {
  return getLanguage() === 'en'
    ? [
        '',
        `- This turn has a budget of **${maxSteps} tool steps** (1 step = one model request + one round of tool execution; several parallel tool calls in one batch still count as 1 step). When the budget runs out the turn is stopped immediately and you get no chance to reply — so plan for it:`,
        '  - do the work that answers the user first, verification second, extra exploration last;',
        '  - as the budget runs low, stop opening new threads and land the answer: what is done, what is left, what you would do next;',
        '  - do **not** skip necessary verification just to save steps (that trades a wrong answer for a cheap one).'
      ].join('\n')
    : [
        '',
        `- 本轮有 **${maxSteps} 步**工具预算（1 步 = 一次模型请求 + 一轮工具执行；一次并行下发多个工具调用也只算 1 步）。预算用完会被立即停下、来不及再说一句话，所以要按预算规划：`,
        '  - 先做「回答用户问题必需」的事，验证其次，额外的探索最后；',
        '  - 快用完时停止开新战线，把结论落地：做完了什么、还差什么、下一步打算怎么做；',
        '  - 但**不要为了省步数跳过必要的验证**（那是拿错误答案换便宜）。'
      ].join('\n')
}

/**
 * 步骤边界注入的「预算提醒」的固定前缀。
 *
 * 两个用途：
 * 1. 模型一眼看出这是**系统提示**而不是用户的新指令（框题必须明确，否则它会把「快收尾」
 *    当成新任务，把正在做的事丢掉 —— 与插话注入踩过的坑完全一样）；
 * 2. `agent.ts` 据此在消息数组里**找到上一次那条提醒并原地替换**（幂等）。不能记下标：
 *    轮中压缩会把数组重排，下标一失效就会堆出好几条互相矛盾的提醒。
 */
export const STEP_BUDGET_MARKER = '【系统提示 · 步数预算】'

/** 预算提醒要用到的两个数 */
export interface StepBudgetState {
  /** 本轮的总预算（用户设置的那个数） */
  maxSteps: number
  /** 已经跑完的步数 */
  used: number
}

/** 还剩几步（含即将发出的这一步）：`1` = 这次就是最后一步 */
export function stepBudgetRemaining(state: StepBudgetState): number {
  return state.maxSteps - state.used
}

/**
 * 提醒从「还剩几步」开始出现。绝对值与比例取小的那个，再夹进 [3, 8]：
 * - 预算很小（比如 12）时按比例只有 1~2 步，来不及收尾；
 * - 预算很大（500）时按 8 步收尾又太仓促，所以取 15%。
 */
export function stepBudgetWarnSteps(maxSteps: number): number {
  return Math.max(3, Math.min(8, Math.ceil(maxSteps * 0.15)))
}

/**
 * 注入给模型的一条预算提醒（步骤边界、消息尾部）。
 *
 * `remaining <= 1` 时是「最后一步」的硬口吻：**明确禁止再调工具**（`agent.ts` 同时会把
 * 这一步的 `toolChoice` 钉成 `'none'`，两边一起说才不会出现「提示说别调、模型还是调了」）。
 */
export function stepBudgetReminder(state: StepBudgetState): string {
  const remaining = stepBudgetRemaining(state)
  if (remaining <= 1) {
    return getLanguage() === 'en'
      ? `${STEP_BUDGET_MARKER} This is the **last step** of this turn (${state.used} / ${state.maxSteps} used). Do not call any more tools — reply in text now: what you finished, what is still open, and what you would do next.`
      : `${STEP_BUDGET_MARKER}这是本轮的**最后一步**（已用 ${state.used} / ${state.maxSteps} 步）。**不要再调用任何工具**，现在就用文字收尾：做完了什么、还差什么、下一步打算怎么做。`
  }
  return getLanguage() === 'en'
    ? `${STEP_BUDGET_MARKER} ${state.used} / ${state.maxSteps} steps used, ${remaining} left. Stop opening new threads: finish what is in hand and land the answer (done / left / next). If you cannot finish, say so in one sentence and let the user decide whether to continue. Do not repeat this notice.`
    : `${STEP_BUDGET_MARKER}已用 ${state.used} / ${state.maxSteps} 步，还剩 ${remaining} 步。不要再开新战线：把手上的事做完并把结论落地（做完了什么 / 还差什么 / 下一步）。真做不完就一句话说清、把是否继续交给用户。不要复述这段提示。`
}

/**
 * 构建 Agent 系统提示词：说明工作区、工具约定与安全边界。
 *
 * `skills` 非空时追加「可用技能」段落（只有名称 + 描述，正文由 read_skill 按需加载，
 * 见 skills.ts 的渐进式披露说明）。
 *
 * `projectDoc` 是全局 + 工作区根合并后的规则文档（调用方用 `readProjectDoc` 读好传进来）：
 * 非空时追加「项目约束文档」段落，把项目自己的规则全文喂给模型 —— 见 project-doc.ts
 * 里「为什么全文注入」的说明。它排在技能之前：全程适用的规则，比「有哪些技能」
 * 更该被先看到。
 *
 * `previewPort` 只在**容器型项目**传（值 = 项目配置里那个容器内预览端口）：非 `undefined`
 * 时追加「预览服务端口」段落，告诉容器里的模型该监听哪个端口、该绑哪个地址 ——
 * 这是容器里唯一拿不到的上下文（宿主端口是动态分配的、也不该让模型知道），见
 * `buildPreviewPortSection`。
 *
 * ⚠️ **权限模式不写进系统提示词**（曾经有一段 `buildPermissionSection`，已删）。
 * 系统提示词是请求**最前面的那几 k token**，一旦它随权限档变化，前缀缓存就从第一个
 * token 起全部失效 —— 用户每切一次「确认 / 完全访问」就要按全价重算整段历史。
 * 而提示词里的权限说明本来也不是闸（闸是 `@fizz/tools` 的 `guardWrite`、项目工具与
 * 客户端工具各自的闸），模型被拦时拿到的拒绝文案已经写清「当前是只读模式，请让用户
 * 去设置里切换」，信息一点没少。
 */
export function buildAgentSystemPrompt(
  workspacePath: string,
  workspaceName: string,
  skills: AgentSkill[] = [],
  projectDoc?: ProjectDoc | null,
  browser?: boolean,
  previewPort?: number,
  /**
   * 容器型项目传 true：追加「容器启动脚本」段落（`.fizz/container/start.mjs`）。
   * 与 `previewPort` 分开传是因为**没有配预览端口的容器项目也应该有这个入口**。
   */
  containerStart?: boolean,
  /**
   * 镜像自带的自动启动命令（`CONTAINER_ENV_IMAGES[].autoStart`，目前只有 Web 栈镜像
   * —— `vite` / `nextjs` —— 的 `dev`）。
   *
   * 有值时提示词要**明确说「别再写启动脚本」**：模型看到「想让服务随容器起来就写
   * `.fizz/container/start.mjs`」会照做，而写了脚本反而会**顶掉**镜像的自动启动
   * （bootstrap 里两者互斥），把一个本来开箱能跑的模板改坏。
   */
  containerAutoStart?: string
): string {
  /*
   * ⚠️ 这里**刻意不列工具清单**：每个工具的 description 与参数说明已经随 schema
   * 一起发出去（模型看得到），在提示词里再抄一遍等于同一份信息付两次钱 ——
   * 这是一轮请求里最没必要的固定开销（见 context.ts 的 estimateBaseTokens）。
   *
   * 提示词只写 schema 里**装不下**的东西：身份、跨工具的使用约定、安全边界。
   * opencode / pi agent 都是这个取舍 —— 工具用法写在工具自己的 description 里。
   */
  const en = getLanguage() === 'en'
  const lines = en
    ? [
        `You are an AI Agent running in Fizz (a coding and operations assistant). The workspace is “${workspaceName}” (${workspacePath}).`,
        'Your job: understand the user’s intent and proactively use tools to complete development and operations tasks inside the workspace.',
        'Conventions:',
        '- Always use paths relative to the workspace root;',
        '- Call tools directly. Never narrate calls or results in prose such as “[calling tool xxx]”;',
        '- For oversized output (execute_command / web_fetch), return only the beginning and end. The full text is saved to a workspace file under .fizz/tool-output/ and the result includes its path, total lines, and which lines were returned. ' +
          'To read the middle, call read_file on that path with offset/limit, or search it with search_files — do not stop at the summary and do not re-run the command or re-fetch the page for the same content;',
        '- Before dangerous operations (rm -rf, git push --force, deleting/overwriting files), explain the impact first;',
        '- After editing, verify with execute_command when possible — prefer the project’s own typecheck/lint, the fastest static check;',
        '- When done, summarize concisely what you did, how you verified it, and what remains.'
      ]
    : [
        `你是一个运行在 Fizz 中的 AI Agent（编程与运维助手），工作区是「${workspaceName}」（${workspacePath}）。`,
        '你的职责：理解用户意图，主动使用工具在工作区内完成开发与运维任务。',
        '使用约定：',
        '- 所有路径一律使用相对工作区根目录的路径；',
        '- 需要工具时直接调用，不要在正文里用「[调用工具 xxx]」这类文字复述调用过程或结果；',
        '- 超长输出（execute_command / web_fetch）只回「开头 + 结尾」，但全文已落盘到结果里给出的那' +
          '个工作区文件（.fizz/tool-output/ 下），里面写着路径、全文行数与本次返回了哪几行。' +
          '需要中段时用 read_file 传那个 path 加 offset / limit 按行读回来，或 search_files 检索它 ——' +
          '不要停在摘要上、也不要为同一段内容反复重跑命令或重新抓页面；',
        '- 危险操作（rm -rf、git push --force、删除 / 覆盖文件）先说明影响再执行；',
        '- 改完文件后尽量用 execute_command 验证 —— 优先跑项目自带的类型检查 / lint，这是最快的静态验证；',
        '- 任务完成时用简洁的中文总结做了什么、验证结果如何、有何遗留。'
      ]
  lines.push('', buildPlanningSection())
  if (projectDoc) lines.push('', buildProjectDocSection(projectDoc))
  const skillsSection = buildSkillsPromptSection(skills)
  if (skillsSection) lines.push('', skillsSection)
  if (browser) lines.push('', BROWSER_PROMPT_SECTION)
  if (previewPort !== undefined) lines.push('', buildPreviewPortSection(previewPort))
  if (containerStart) lines.push('', buildContainerStartSection(previewPort, containerAutoStart))
  return lines.join('\n')
}

/**
 * 容器型项目的「预览端口」约定（只在容器型项目里追加）。
 *
 * **不写这一段，模型只会自己挑一个顺眼的端口**（3000 / 5173 / 8000…），结果是：用户在
 * 预览标签里看到一片空白，且**没有任何报错** —— 排查成本极高
 * （用户报过「容器内的 agent 好像不知道它应该使用什么端口来暴露服务」）。
 *
 * 端口是**平台按镜像分配的**（用户不填、也看不到）：用户那边只有一条
 * `https://<slug>.<域名>`，由服务端公网入口按 slug 现查当前映射转发过来。
 *
 * 两条必须说清：
 * 1. 监听**容器内的 `previewPort`**。宿主那个随机端口（`127.0.0.1:<41000-41999>`）每次
 *    启动重新分配、模型看不到也不该看到 —— 提它只会让模型去写死一个错的端口；
 * 2. 必须绑 **`0.0.0.0`**：绑 `127.0.0.1` / `localhost` 时 docker 的端口转发**进不到
 *    容器里**（与「本机直接跑没事」的直觉相反，是 docker 的经典坑）。
 */
function buildPreviewPortSection(previewPort: number): string {
  if (getLanguage() === 'en') {
    return [
      '## Preview service port',
      `This workspace runs in a container. The platform has exposed container port ${previewPort} — users see a fixed domain; the port is assigned by the platform and you neither need to care about nor change it.`,
      `For users to see your page in the “Preview” tab, the service must listen on container port ${previewPort} and bind to \`0.0.0.0\` — with \`127.0.0.1\` / \`localhost\` docker port forwarding cannot reach the container, and the page will be blank with no error.`,
      `Always use ${previewPort} for ports in startup scripts/config (e.g. \`PORT=${previewPort} npm run dev\`, \`--port ${previewPort}\`); never substitute 3000 / 5173 / 8000.`
    ].join('\n')
  }
  return [
    '## 预览服务端口',
    `这个工作区跑在容器里。平台已经把容器内的 ${previewPort} 端口接出去了 —— 用户那边看到的是` +
      '一条固定域名，端口由平台分配，你不用关心也不需要改它。',
    `想让用户在「预览」标签里看到你的页面，服务必须监听容器内的 ${previewPort}，` +
      '并且要绑 `0.0.0.0` —— 绑 `127.0.0.1` / `localhost` 时 docker 的端口转发进不到' +
      '容器里，页面会一片空白而且没有任何报错。',
    `启动脚本 / 配置里的端口一律用 ${previewPort}（例如 \`PORT=${previewPort} npm run dev\`、` +
      `\`--port ${previewPort}\`），不要顺手换成 3000 / 5173 / 8000 这类端口。`
  ].join('\n')
}

/**
 * 容器型项目的「启动脚本」约定（只在容器型项目里追加）。
 *
 * 入口是**约定路径**，模型不知道就等于不存在：用户说「让这个服务随容器自动起来」时，
 * 模型只会去改 `package.json` 或者干脆说「请手动启动」。把路径、执行方式与失败语义
 * 一次说清，才能让它自己去写那个文件。
 *
 * 三条对齐镜像里的 `bootstrap.mjs`（改任一侧都要改另一侧）：
 * 1. 只认 `.fizz/container/start.mjs` 与 `start.cjs`（`.js` 的语义取决于 package.json，不猜）；
 * 2. 脚本在**子进程**里后台跑，失败只进日志、不影响容器与 Agent 启动；
 * 3. 工作目录是容器内的工作区根 `/workspace`。
 *
 * `autoStart` 非空（镜像自带自动启动）时追加一段「别再写启动脚本」—— 两者在 bootstrap 里
 * 是**互斥**的（有脚本就听脚本的），模型好心写一个脚本反而会把开箱能跑的模板顶掉。
 */
function buildContainerStartSection(previewPort?: number, autoStart?: string): string {
  const en = getLanguage() === 'en'
  const lines = en
    ? [
        '## Container startup script',
        'This workspace runs in a container. On every start the container first runs `.fizz/container/start.mjs` (skipped if absent), then starts the Agent service itself.',
        '- To make a service **start automatically with the container** (dev server / background job / one-time setup), write that file. Restart the container (stop then start) for changes to take effect;',
        '- The script runs in a **child process** in the background: exceptions, syntax errors, and non-zero exits do **not** affect the container or Agent startup. They only go to container logs (the launcher records a `[fizz-start]` line; the script’s own output goes to the log unchanged);',
        '- This is suitable for **long-running services** (`npm run dev`, `node server.js`) and also one-time actions (installing dependencies, migrations) — make the latter idempotent yourself;',
        '- Only `.fizz/container/start.mjs` (ESM) and `.fizz/container/start.cjs` (CJS) are recognized; `.js` is not executed. The script’s working directory is the workspace root `/workspace`, so relative paths work.'
      ]
    : [
        '## 容器启动脚本',
        '这个工作区跑在容器里。容器每次启动会先执行 `.fizz/container/start.mjs`（不存在就跳过），' +
          '再启动 Agent 服务本身。',
        '- 想让某个服务**随容器自动起来**（开发服务器 / 后台任务 / 一次性初始化），就写这个文件；' +
          '改完需要重启容器才生效（停止再启动）；',
        '- 脚本在**子进程**里后台执行：抛错、语法错误、非 0 退出都**不会**影响容器与 Agent 启动，' +
          '只会写进容器日志（启动器会记一行 `[fizz-start]` 前缀的结果，脚本自己的输出原样进日志）；',
        '- 所以这里适合放**常驻服务**（`npm run dev`、`node server.js`），也放得下一次性动作' +
          '（装依赖、跑迁移），后者请自己保证幂等；',
        '- 只认 `.fizz/container/start.mjs`（ESM）与 `.fizz/container/start.cjs`（CJS）两个文件名，' +
          '`.js` 不会被执行；脚本的工作目录是工作区根 `/workspace`，用相对路径即可。'
      ]
  if (previewPort !== undefined) {
    lines.push(
      en
        ? `- A service started by the script must listen on the preview port ${previewPort} and bind to \`0.0.0.0\` to be visible to users.`
        : `- 脚本里起的服务若要对用户可见，必须监听上面说的预览端口 ${previewPort} 并绑 \`0.0.0.0\`。`
    )
  }
  if (autoStart) {
    lines.push(
      '',
      en
        ? `**This image already has autostart; do not write a startup script**: when the workspace has no \`.fizz/container/start.mjs\`, container startup prepares the template (only if there is no \`package.json\`) and runs \`npm run ${autoStart}\`` +
            (previewPort === undefined
              ? ''
              : `; the image supplies framework-specific arguments that bind the service to \`0.0.0.0\` port ${previewPort}`) +
            '. The service itself listens on the preview port.'
        : `**这个镜像已经自带自动启动，不需要你写启动脚本**：工作区没有 \`.fizz/container/start.mjs\` 时，` +
            `容器启动会自动准备模板（仅当工作区还没有 \`package.json\`）并执行 \`npm run ${autoStart}\`` +
            (previewPort === undefined
              ? ''
              : `，启动参数由镜像自带（按各自框架的 CLI 口径）把服务绑到 \`0.0.0.0\` 的 ${previewPort} 端口`) +
            '，服务本身就监听预览端口。',
      en
        ? '- Writing a startup script **overrides** autostart (only one runs), so write one only when you really need a different command;'
        : `- 写启动脚本会**顶掉**自动启动（容器只跑其中一个），所以只有确实要换启动命令时才写；`,
      en
        ? '- If the dev server dies or breaks: check the `[fizz-start]` lines in the container log first, fix it, then restart the container;'
        : '- dev server 挂了或改坏了：先看容器日志里 `[fizz-start]` 那几行，修好后重启容器即可；',
      en
        ? '- On the first start of an empty workspace, logs will show template setup and dependency installation — that is normal.'
        : '- 空工作区第一次启动时日志里会出现「铺模板」和「安装依赖」，属于正常流程。'
    )
  }
  return lines.join('\n')
}

/**
 * 任务规划与动态重规划。
 *
 * `todo_write` 的 schema 里已经写了怎么用它；这里补的是**跨工具的行为约定**：
 * 什么时候该建清单、**做到一半发现计划不对时要主动改**（这才是「动态规划」的关键，
 * 光给工具不说这句，模型会倾向于把最初那份清单当成不可改的合同一路跑到底）、
 * 以及「清单是给自己对进度用的、不是给用户看的交付物」这个边界。
 */
function buildPlanningSection(): string {
  if (getLanguage() === 'en') {
    return [
      'Task planning (multi-step tasks):',
      '- For tasks with **three or more steps**, or that need repeated verification, first list the work in a todo list with `todo_write`, then proceed step by step;',
      '- **Planning is dynamic, not fixed upfront**: maintain the list as you go — mark finished items and set the next one in progress. More importantly, if later arrangements turn out wrong, drift from the user’s goal, or new needs appear, rewrite the remaining items (add/remove/edit/reorder) instead of blindly finishing the original list;',
      '- Keep exactly one item in progress at a time; make items specific (“one sentence, one action”), not vague phases;',
      '- Do not use a todo list for simple or single-step tasks. The list is for your own tracking; do not repeat it in the reply.'
    ].join('\n')
  }
  return [
    '任务规划（多步骤任务）：',
    '- 遇到**三步以上**、或需要来回验证的任务，先用 `todo_write` 把要做的事列成待办清单，再逐步推进；',
    '- **规划是动态的，不是一次定死**：边做边维护清单 —— 完成一项就更新它的状态、把下一项设为进行中。' +
      '更关键的是，做到某一步时如果发现**后面的安排不对 / 偏离了用户目标 / 冒出了新需求**，' +
      '要主动回头改写后续条目（增、删、改、换序都行），而不是硬按最初的清单跑完；',
    '- 同一时刻只留一条进行中；清单要具体到「一句话一个动作」，不要写成泛泛的大阶段；',
    '- 简单任务、单步操作不要用清单；清单是给你自己对进度用的，不必在正文里复述一遍它。'
  ].join('\n')
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 将 AI SDK 流事件转换为 Agent 流事件（兼容字段名差异） */
export function adaptAgentPart(
  part: { type: string } & Record<string, unknown>
): AgentStreamEvent | null {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', delta: String(part.text ?? '') }
    // AI SDK 7 的 fullStream 里思考内容是 reasoning-delta（增量在 text 字段），
    // reasoning-start / reasoning-end 只是起止标记，不带内容
    case 'reasoning-delta':
      return { type: 'reasoning-delta', delta: String(part.text ?? '') }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        input: part.input ?? part.args ?? null
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        output: part.output ?? part.result ?? null
      }
    case 'tool-error':
      return {
        type: 'tool-result',
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        output: `工具执行失败: ${describeError(part.error)}`,
        isError: true
      }
    case 'error':
      return { type: 'error', message: describeError(part.error) }
    case 'abort':
      return { type: 'finish', finishReason: 'aborted' }
    default:
      return null
  }
}
