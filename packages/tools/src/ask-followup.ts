/**
 * `ask` 工具（**传输无关**的共享实现，桌面端 / server 共用）。
 *
 * 这是「AI 在回合中途向用户收集结构化选择题答案」的工具：一次可以问一道或多道
 * （每道 single 单选 / multiSelect 多选，选项 2-4 个）。模型拿到答案后继续往下跑。
 *
 * 与「命令确认卡」机制一致：工具执行时挂起，通过注入的 `AskFollowupSink` 把提问
 * 表单交给用户（桌面端走 IPC 广播、server 端走 SSE 帧），用户作答后回填，
 * **同一个回合继续往下跑**。机制由调用方用不同的 sink 实现。
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AskFollowupAnswer } from '@fizz/contracts/types'

/** 工具名：模型用它向用户提问（对应工具定义里的 `name`） */
export const ASK_FOLLOWUP_TOOL = 'ask'

/**
 * 追加到系统提示词末尾的提示：工具光存在没用，模型得知道「什么时候该问、怎么问」。
 * 少了这一句，绝大多数模型会自己猜着往下做，工具一次都不会被调用。
 */
export const ASK_FOLLOWUP_HINT = [
  '',
  '需要用户做决定或补充信息时，用 ask 工具向他提问：一次可以问一道或多道结构化选择题，',
  '每道题 single 单选 / multiSelect 多选，选项 2-4 个（可以是纯文本，也可以带说明对象）。',
  '非「是/否」型题目的选项里用户可以选「其他」并自行输入，回答会带 other 字段（此时 selected 可能为空）。',
  '这个「其他」项由界面自动追加：options 里不要自己写「其他 / 其它 / Other」类的兜底项，写了会被丢弃。',
  '用户不作答（跳过）时按最合理的方式继续，不要反复追问同一个问题。'
].join('\n')

/**
 * 提问如何送达用户、答案如何回填，由调用方注入：
 * - 桌面端：`askFollowupBroker` 走 IPC 广播卡片；
 * - server：把提问推成 `ask-followup` SSE 帧，等客户端 POST `/api/chat/followup`。
 */
export interface AskFollowupSink {
  /**
   * 弹出一张提问表单并等待用户作答。
   * 返回 `AskFollowupAnswer` = 已作答；返回 `null` = 跳过 / 超时 / 中止。
   */
  ask(req: Omit<AskFollowupRequest, 'id'>): Promise<AskFollowupAnswer | null>
  /**
   * 这一轮是不是**被中断**了（用户点了停止 / 应用退出 / 进程收尾时的 abort）。
   *
   * 为什么要它：`ask` 返回 `null` 有三种来源 —— 用户点「跳过」、超时、被中止。
   * 前两种是用户的决定（历史里就该显示「已跳过」），第三种是**根本没等到答复**，
   * 前端会把它渲染成可补答的卡片（答案当新消息发出去，见 `formatFollowupAnswer`）。
   * 不实现 = 一律按「跳过」处理（老行为）。
   */
  interrupted?(): boolean
}

/** 归一化后的问题选项：纯 `label` + `description` 形态（与契约 FollowupOption 对齐） */
interface FollowupOption {
  label: string
  description?: string
}

/** sink 入参里的一道题（结构与契约 FollowupQuestion 一致，id 由 ask 侧补齐） */
interface FollowupQuestion {
  id: string
  question: string
  header: string
  options: FollowupOption[]
  multiSelect: boolean
}

/** sink 入参（与契约 AskFollowupRequest 同构，仅缺 id） */
interface AskFollowupRequest {
  requestId: string
  toolCallId: string
  title?: string
  questions: FollowupQuestion[]
}

/**
 * 组装 `ask` 工具。
 *
 * ⚠️ 刻意**不走确认流程**：提问本身就是让用户在卡片上做决定，
 * 再套一层「是否允许执行该工具？」只会多一次没意义的点击。
 */
export function buildAskFollowupTool(
  sink: AskFollowupSink,
  requestId: string
): ToolSet {
  return {
    [ASK_FOLLOWUP_TOOL]: tool({
      description:
        'Collect structured multiple-choice answers from the user. Provide one or more questions with ' +
        'options, and set multiSelect when multi-select is appropriate. MUST be invoked via the native ' +
        'tool_calls protocol; NEVER emit it as inline XML or pseudo-XML in assistant text (e.g. ' +
        '"<ask>..."). Only use this tool when you are highly uncertain and must clarify ' +
        'the issue with the user. You should prefer resolving the problem through reasoning and other tools ' +
        'whenever possible.',
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .describe('Optional title for the questions form'),
        questions: z
          .array(
            z.object({
              question: z.string().min(1).describe('The complete question to ask the user. Should be clear and specific.'),
              header: z
                .string()
                .max(12)
                .describe(
                  'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library".'
                ),
              options: z
                .array(
                  z.union([
                    z.string(),
                    z.object({ label: z.string(), description: z.string().optional() })
                  ])
                )
                .min(1)
                .describe(
                  'The available choices for this question. 2-4 options. Each option can be a string or an ' +
                    'object with "label" and optional "description". Do NOT add an "Other" / "其他" catch-all ' +
                    'option: the UI appends one automatically and duplicates are dropped.'
                ),
              multiSelect: z
                .boolean()
                .optional()
                .describe(
                  'Set to true to allow the user to select multiple options instead of just one. Default false.'
                ),
              id: z
                .string()
                .optional()
                .describe('Optional unique identifier for the question. Auto-generated if absent.')
            })
          )
          .min(1)
          .describe(
            '1 to 4 questions as an array filled with JSON objects. Example: ' +
              '[{"question":"Which framework?","options":[{"label":"React"},{"label":"Vue"}]}]'
          )
      }),
      execute: async (
        input: {
          title?: string
          questions: Array<{
            question: string
            header: string
            options: Array<string | { label: string; description?: string }>
            multiSelect?: boolean
            id?: string
          }>
        },
        opts: { toolCallId: string }
      ) => {
        const answer = await sink.ask({
          requestId,
          toolCallId: opts.toolCallId,
          title: input.title,
          questions: input.questions.map((q, i) => ({
            id: q.id?.trim() || `q${i + 1}`,
            question: q.question,
            header: q.header,
            options: q.options.map((o) =>
              typeof o === 'string' ? { label: o } : { label: o.label, description: o.description }
            ),
            multiSelect: !!q.multiSelect
          }))
        })
        if (!answer) {
          /**
           * `interrupted` 标出「不是用户跳过，而是这一轮被中止了」：前端据此把这张卡
           * 渲染成**可补答**（那一轮已经结束，答案只能当新消息发出去）。
           * 用户主动点「跳过」时不带这个标记 —— 他刚刚说不要了，别再把表单弹回来。
           */
          const interrupted = sink.interrupted?.() ?? false
          return {
            answered: false,
            ...(interrupted ? { interrupted: true } : {}),
            note: interrupted
              ? '这一轮被中断了，没有拿到用户的答案。请先说明情况，等用户决定是否继续。'
              : '用户没有作答（已跳过）。请按你自己的判断继续，不要再追问同一个问题。'
          }
        }
        return { answered: true, answers: answer.answers }
      }
    })
  }
}