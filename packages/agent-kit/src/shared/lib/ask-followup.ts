/**
 * ask 提问表单的防御式归一化（web / 桌面端同构）。
 *
 * 模型给的是任意 JSON，这里规整成能渲染出一张可用卡片的结构；缺字段就兜底。
 */
import type { AgentMessagePart, AskFollowupAnswer } from '@fizz/contracts/types'

export interface NormalizedOption {
  label: string
  description?: string
}

export interface NormalizedQuestion {
  id: string
  question: string
  header: string
  options: NormalizedOption[]
  multiSelect: boolean
  /**
   * 模型自己写过一项「其他」（`其他` / `其它` / `other` / `其他（请说明）`）。
   *
   * 那一项**已经从 `options` 里剔除**（统一由界面追加唯一哨兵，见 `needsOtherOption`），
   * 这个标记只留一个意思：它本来就想给用户一个自由输入的出口 —— 连是/否题也照补哨兵。
   */
  otherRequested: boolean
}

export interface NormalizedFollowup {
  title: string
  questions: NormalizedQuestion[]
}

/**
 * 「其他」自由输入的哨兵 label：选中它就展开一个输入框，让用户不选预设项也能自己写。
 *
 * ⚠️ 它同时是**卡片的 React key**、勾选状态的键、以及「这条答案是不是自由输入」的判据
 * （见 `followup-card.tsx` 的 `otherSelected`）。所以同一题的选项里**绝不会出现两个**：
 * 模型写的那一项在归一化时就被剔掉了（见 `normalizeFollowup`），卡片上这一个恒由界面追加。
 */
export const OTHER_OPTION_LABEL = '其他'

/**
 * 这个 label 是不是「其他」类的项（模型自己也可能列一项）。
 *
 * 认三种写法：`其他` / `其它` / `other`，并且忽略括号里的补充说明
 * （「其他（请说明）」「Other (please specify)」都算）。
 */
function isOtherLabel(label: string): boolean {
  const bare = label
    .trim()
    .replace(/[（(][^（()）]*[)）]\s*$/, '')
    .trim()
    .toLowerCase()
  return bare === OTHER_OPTION_LABEL || bare === '其它' || bare === 'other'
}

/**
 * 是/否 型问题（正好两个「是 / 否」类选项）不加「其他」——这两类问题的语义封闭，
 * 开放输入反而让答案变模糊。只对真正的「单选 / 多选」题开放自定义输入。
 */
export function isYesNoQuestion(q: NormalizedQuestion): boolean {
  if (q.options.length !== 2) return false
  const YES = new Set(['是', '是的', '对', '好', 'yes', 'y', 'true', 'ok'])
  const NO = new Set(['否', '不是', '不对', '不行', 'no', 'n', 'false'])
  const norm = (s: string): string => s.trim().toLowerCase()
  const a = norm(q.options[0].label)
  const b = norm(q.options[1].label)
  return (YES.has(a) && NO.has(b)) || (NO.has(a) && YES.has(b))
}

/**
 * 这道题要不要在选项末尾补一项「其他」（自由输入）。
 *
 * **「其他」只由界面加**：模型写的项在归一化时已经剔除，所以这里只管「该不该给这道题
 * 一个自由输入的出口」，不再看选项里有没有其他类项（那种情况下会有两个「其他」：
 * React 按 label 做 key 直接报重复 key，勾选状态也会串）。
 *
 * 不补的只有一种：是/否题（语义封闭，多一个开放输入只会让答案变模糊）。
 * 例外 —— 模型自己写过「其他」的是/否题照补（`otherRequested`）：它本来就想让用户自己写。
 */
export function needsOtherOption(q: NormalizedQuestion): boolean {
  if (q.otherRequested) return true
  return !isYesNoQuestion(q)
}

/**
 * 一题算不算「已作答」—— 决定主按钮是「提交」还是「下一题」、底部圆点实不实心。
 *
 * 判据两条取其一：**选了至少一个预设项**，或者**选了「其他」并且真的写了内容**。
 *
 * ⚠️ 空着的「其他」**不能否掉已经选好的预设项**。以前这里写的是「只要勾了其他却没写字，
 * 整题就算没答」，于是多选场景下会这样：勾了几项 → 主按钮变「提交」；随手点一下
 * 「其他补充…」（还没打字）→ 整题被打回未答、按钮退回「下一题」，用户只能去点输入框
 * 右边那颗 ✕ 才能变回「提交」。空「其他」的意思是「开了个输入框、还没写」，
 * 不是「撤掉了前面的选择」。
 *
 * 反过来的边界同样要守住：文字留在输入框里但哨兵已被取消（用户点了 ✕），那段文字
 * **不算**这次作答 —— 与 `FollowupForm` 的 `submit()` 一致（那里也按哨兵在不在决定带不带 `other`）。
 */
export function isQuestionAnswered(
  selected: readonly string[] | undefined,
  otherText: string | undefined
): boolean {
  const sel = selected ?? []
  const hasOther = sel.includes(OTHER_OPTION_LABEL)
  return sel.some((label) => label !== OTHER_OPTION_LABEL) || (hasOther && !!otherText?.trim())
}

/** 模型给的是任意 JSON，这里做一次防御式归一化（缺字段也要能渲染出一张能用的卡） */
export function normalizeFollowup(input: unknown): NormalizedFollowup {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const rawQs = Array.isArray(obj.questions) ? obj.questions : []
  const questions: NormalizedQuestion[] = []
  rawQs.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const q = raw as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!question) return
    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim() : `问题 ${i + 1}`
    const multiSelect = q.multiSelect === true
    const options: NormalizedOption[] = []
    /**
     * 同一题里同名选项只留第一条。
     *
     * 选项的 label 是**唯一标识**：卡片的 React key、`selected` 里的值、回传给模型的
     * 答案都按它走。模型偶尔会把同一项写两遍（「其他」尤其常见），重复会让 React 报
     * 「Encountered two children with the same key」、单选时点一个两个一起亮，
     * 而且用户看到的就是一列重复项。这里去重而不是在渲染层改 key —— 改 key 只能压掉
     * 控制台警告，勾选串台的语义问题还在。
     *
     * 比的是 trim 后的原文，不做大小写归一：`Yes` / `yes` 确实是两个不同选项。
     */
    const seen = new Set<string>()
    /** 模型自己写过「其他」类的项：那一项会被剔除，只留这个标记（见 `NormalizedQuestion`） */
    let otherRequested = false
    /** 入参里出现过可用选项 —— 用来区分「模型没给选项」和「只给了『其他』」 */
    let sawOption = false
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        const raw =
          typeof o === 'string'
            ? { label: o }
            : o && typeof o === 'object'
              ? (o as Record<string, unknown>)
              : null
        if (!raw) continue
        const label = typeof raw.label === 'string' ? raw.label.trim() : ''
        if (!label) continue
        sawOption = true
        /**
         * 「其他」类的项**一律剔除**，改成界面统一追加的那一个哨兵。
         *
         * 自由输入框只在 `label === OTHER_OPTION_LABEL` 时才展开（见 `followup-card.tsx`
         * 的 `otherSelected`）。模型写「其他（请说明）」时，留着它只是个普通选项 ——
         * 用户点上去连输入框都不出现；模型恰好写「其他」时又因为撞上哨兵而能用。
         * 同一张卡上两道题两种行为，全看模型怎么措辞。这个出口该不该有是界面的事，
         * 所以选项里不放任何模型写的「其他」，只留 `otherRequested` 这个意图。
         */
        if (isOtherLabel(label)) {
          otherRequested = true
          continue
        }
        if (seen.has(label)) continue
        seen.add(label)
        options.push({
          label,
          description:
            typeof raw.description === 'string' && raw.description.trim()
              ? raw.description.trim()
              : undefined
        })
      }
    }
    /**
     * 一个可用项都没有：模型没给选项的题渲染不出来，直接丢；
     * 但**只给了「其他」的题要留下** —— 题干还在，卡片就渲染成一个自由输入。
     */
    if (!sawOption) return
    questions.push({
      id: (typeof q.id === 'string' && q.id.trim()) || `q${i + 1}`,
      question,
      header,
      options,
      multiSelect,
      otherRequested
    })
  })
  return { title, questions }
}

/**
 * 把「补答」拼成一条用户消息。
 *
 * 用在哪：那一轮已经结束了（应用退出 / 用户点了停止 / 进程崩了），提问卡上的答案
 * **再也回填不到工具里** —— 只能当新的一轮发出去。所以题目必须一起带上：模型看到的
 * 是一句普通的话，不重复题目它不知道在回答什么。
 *
 * 格式刻意做成「一句说明 + 每行一题」：模型读得懂，用户在自己的消息里也看得懂
 * （这条会作为普通 user 气泡留在对话里）。
 */
export function formatFollowupAnswer(answer: AskFollowupAnswer, title?: string): string {
  const lines = answer.answers.map((item) => {
    const picked = [...item.selected]
    const other = item.other?.trim()
    if (other) picked.push(other)
    return `- ${item.question} → ${picked.length ? picked.join('、') : '（未选）'}`
  })
  const head = title?.trim() ? `（补答你之前的提问：${title.trim()}）` : '（补答你之前的提问）'
  return [head, ...lines].join('\n')
}

/**
 * 已经「补答」过的提问（toolCallId → 答案）。
 *
 * 补答 = 发一条新消息，**没有地方能把「这张卡答过了」写回历史**（那一轮的工具结果
 * 在服务端早就定格成 `answered: false` 了，历史是只读的）。所以用一份客户端现场把
 * 卡片收成「已回答」，避免用户对着同一张卡反复作答。
 *
 * 只活在内存里：刷新 / 重开后会再变回可作答一次 —— 那时对话里已经有他刚发的那条
 * 答案（紧接着就是回答），不至于误点。要彻底解决得让服务端在历史里记这个状态，
 * 代价是改会话文件结构，本次没做。
 */
const resumedFollowups = new Map<string, AskFollowupAnswer>()

/** 记下「这张卡已经补答过」（渲染层据此收成已回答的折叠条） */
export function markFollowupResumed(toolCallId: string, answer: AskFollowupAnswer): void {
  resumedFollowups.set(toolCallId, answer)
}

/** 补答过的答案（没补答过 = `undefined`） */
export function getResumedFollowup(toolCallId: string): AskFollowupAnswer | undefined {
  return resumedFollowups.get(toolCallId)
}

/** ask 的工具名（与 `shared/lib/parts.ts` 的常量同值，这里避开循环依赖） */
const ASK_FOLLOWUP_TOOL_NAME = 'ask'

/**
 * 这个 part 是不是**一张没拿到答案的提问卡**（可以补答）。
 *
 * 判据三件事：
 * 1. 是 `ask` 的 tool-call，且有题目（`normalizeFollowup` 能解析出来）；
 * 2. 工具没报错，而且**没拿到答案** —— 有 `output` 时必须带 `interrupted: true`
 *    （服务端 abort 时打的那个标记，见 `@fizz/tools` 的 `AskFollowupSink.interrupted`）。
 *    用户自己点「跳过」的结果没有这个标记：他刚说不要了，别再把表单弹回来；
 * 3. 没有活跃的待答请求 —— 那条由调用方判（`requests[toolCallId]`），这里拿不到。
 *
 * 「这一轮是不是已经结束」也由调用方判（`turnDone`，只有它知道消息是不是末条）。
 */
export function isUnansweredFollowup(part: AgentMessagePart): boolean {
  if (part.type !== 'tool-call' || part.toolName !== ASK_FOLLOWUP_TOOL_NAME) return false
  if (part.isError) return false
  if (part.output && typeof part.output === 'object') {
    const out = part.output as { answered?: unknown; interrupted?: unknown }
    if (out.answered === true) return false
    if (out.interrupted !== true) return false
  }
  return normalizeFollowup(part.input).questions.length > 0
}