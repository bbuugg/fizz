/**
 * 提问卡的归一化、选项判据、「补答」判据与文案拼装（纯逻辑，vitest 覆盖）。
 *
 * 背景：那一轮已经结束（应用退出 / 点了停止 / 进程崩了）时，`ask`
 * 的答案再也回填不到工具里 —— 前端把这张卡重新渲染成可作答的表单，答案当一条新消息
 * 发出去。这里钉住几条最容易错的边界：
 *
 * 1. **用户自己点「跳过」的不能变成可补答**（他刚说不要了，别把表单弹回来）；
 * 2. 只有带 `interrupted: true`（服务端 abort 时打的标记）或干脆没有结果的才算；
 * 3. 拼出去的那条消息必须带题目，否则模型不知道在回答什么；
 * 4. **选项 label 不许重复**：卡片的 React key、勾选状态、回传给模型的答案全都按
 *    label 走，重复会让 React 报「two children with the same key」（控制台刷
 *    「Encountered two children with the same key, `其他`」）并且单选时勾一个两个都亮；
 * 5. **「其他」只由界面加**：模型写的「其他」「其它」「Other」「其他（请说明）」一律在
 *    归一化时剔掉（记成 `otherRequested`），卡片统一在末尾追加那一个哨兵项。
 *
 *    这条是踩出来的：原先的规则是「模型给了其他类项就不再补哨兵」，但自由输入框只在
 *    `label === '其他'` 时才展开 —— 于是模型写「其他」的那道题能输入，写「其他（请说明）」
 *    的那道题点上去只是个普通选项、连输入框都不出现，同一个面板里两题行为还不一样。
 *    选项该不该开放输入是**界面**的决定，不该由模型措辞决定。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from '@fizz/contracts/types'
import {
  OTHER_OPTION_LABEL,
  formatFollowupAnswer,
  getResumedFollowup,
  isUnansweredFollowup,
  markFollowupResumed,
  needsOtherOption,
  normalizeFollowup,
  type NormalizedQuestion
} from './ask-followup'

/** 一张 ask 的 tool-call part */
function followupPart(extra: Partial<AgentMessagePart> = {}): AgentMessagePart {
  return {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'ask',
    input: {
      title: '新建项目的配置',
      questions: [
        {
          question: '用哪个框架？',
          header: '框架',
          options: ['React', 'Vue']
        }
      ]
    },
    ...extra
  } as AgentMessagePart
}

/** 一道最小的题（`options` 由各用例给） */
function question(overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion {
  return {
    id: 'q1',
    question: '选一个',
    header: '选择',
    options: [{ label: 'React' }, { label: 'Vue' }],
    multiSelect: false,
    otherRequested: false,
    ...overrides
  }
}

describe('normalizeFollowup · 选项去重', () => {
  it('同名选项只留第一条（重复会让 React key 撞车、单选勾一个两处都亮）', () => {
    const out = normalizeFollowup({
      questions: [
        {
          question: '选一个',
          options: ['A', { label: 'A', description: '重复的第二份' }, 'B']
        }
      ]
    })
    expect(out.questions[0]?.options.map((o) => o.label)).toEqual(['A', 'B'])
    expect(out.questions[0]?.options[0]?.description).toBeUndefined()
  })

  it('去重按 trim 后的原文比，不误伤只差大小写的不同项', () => {
    const out = normalizeFollowup({
      questions: [{ question: '选一个', options: ['Yes', 'yes'] }]
    })
    expect(out.questions[0]?.options.map((o) => o.label)).toEqual(['Yes', 'yes'])
  })
})

describe('normalizeFollowup · 「其他」只由界面加', () => {
  const labels = (input: unknown): string[] =>
    normalizeFollowup(input).questions[0]?.options.map((o) => o.label) ?? []

  it('模型写的「其他」类选项一律剔除（含括号说明 / 英文 / 其它）', () => {
    for (const label of [
      OTHER_OPTION_LABEL,
      '其它',
      '其他（请说明）',
      '其他 (please specify)',
      'Other',
      'OTHER'
    ]) {
      expect(labels({ questions: [{ question: '选一个', options: ['React', label, 'Vue'] }] })).toEqual([
        'React',
        'Vue'
      ])
    }
  })

  it('剔除的同时记下「模型本来就想开放输入」', () => {
    const out = normalizeFollowup({
      questions: [{ question: '选一个', options: ['React', '其他（请说明）'] }]
    })
    expect(out.questions[0]?.otherRequested).toBe(true)

    const plain = normalizeFollowup({ questions: [{ question: '选一个', options: ['React', 'Vue'] }] })
    expect(plain.questions[0]?.otherRequested).toBe(false)
  })

  it('只给了「其他」的题不能整道吃掉：题干仍要显示（卡片就剩那个自由输入）', () => {
    const out = normalizeFollowup({
      questions: [{ question: '还有什么要求？', options: ['其他（请说明）'] }]
    })
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0]?.options).toEqual([])
    expect(out.questions[0]?.otherRequested).toBe(true)
  })

  it('形近但不是哨兵的文本不动：「其他情况」「其他说明」都是正经选项', () => {
    expect(
      labels({ questions: [{ question: '选一个', options: ['其他情况', '其他说明'] }] })
    ).toEqual(['其他情况', '其他说明'])
  })
})

describe('needsOtherOption', () => {
  it('普通单选 / 多选：末尾补一项「其他」', () => {
    expect(needsOtherOption(question())).toBe(true)
    expect(needsOtherOption(question({ multiSelect: true }))).toBe(true)
  })

  it('是 / 否题不补（语义封闭，开放输入只会让答案变模糊）', () => {
    expect(needsOtherOption(question({ options: [{ label: '是' }, { label: '否' }] }))).toBe(false)
    expect(needsOtherOption(question({ options: [{ label: 'Yes' }, { label: 'no' }] }))).toBe(false)
  })

  it('模型明确要过「其他」的是 / 否题：照补（它本来就想让用户自己写）', () => {
    expect(
      needsOtherOption(
        question({ options: [{ label: '是' }, { label: '否' }], otherRequested: true })
      )
    ).toBe(true)
  })
})

describe('isUnansweredFollowup', () => {
  it('没有结果 = 没答（abort 时 tool-result 可能压根没到）', () => {
    expect(isUnansweredFollowup(followupPart())).toBe(true)
  })

  it('用户点「跳过」的结果不带 interrupted，不算可补答', () => {
    expect(
      isUnansweredFollowup(
        followupPart({
          output: { answered: false, note: '用户没有作答（已跳过）' }
        })
      )
    ).toBe(false)
  })

  it('被中断的结果（interrupted: true）算可补答', () => {
    expect(
      isUnansweredFollowup(
        followupPart({
          output: { answered: false, interrupted: true, note: '这一轮被中断了' }
        })
      )
    ).toBe(true)
  })

  it('已经答过的不算', () => {
    expect(
      isUnansweredFollowup(
        followupPart({ output: { answered: true, answers: [{ id: 'q1', question: '', selected: ['React'] }] } })
      )
    ).toBe(false)
  })

  it('工具报错的不算（渲染层另有失败态）', () => {
    expect(isUnansweredFollowup(followupPart({ isError: true }))).toBe(false)
  })

  it('别的工具、或解析不出题目的不算', () => {
    expect(isUnansweredFollowup(followupPart({ toolName: 'read' }))).toBe(false)
    expect(isUnansweredFollowup(followupPart({ input: { questions: [] } }))).toBe(false)
  })
})

describe('formatFollowupAnswer', () => {
  it('带标题、选中项与「其他」自由输入', () => {
    const text = formatFollowupAnswer(
      {
        answers: [
          { id: 'q1', question: '用哪个框架？', selected: ['React'] },
          { id: 'q2', question: '需要什么功能？', selected: [], other: '导出 PDF' }
        ]
      },
      '新建项目的配置'
    )
    expect(text).toBe(
      [
        '（补答你之前的提问：新建项目的配置）',
        '- 用哪个框架？ → React',
        '- 需要什么功能？ → 导出 PDF'
      ].join('\n')
    )
  })

  it('没有标题时用通用抬头；一题没选也给出「未选」', () => {
    const text = formatFollowupAnswer({ answers: [{ id: 'q1', question: '继续吗？', selected: [] }] })
    expect(text).toBe(['（补答你之前的提问）', '- 继续吗？ → （未选）'].join('\n'))
  })
})

describe('markFollowupResumed', () => {
  it('记下之后能查回来（渲染层据此收成「已回答」）', () => {
    expect(getResumedFollowup('call-resumed')).toBeUndefined()
    markFollowupResumed('call-resumed', { answers: [{ id: 'q1', question: '继续吗？', selected: ['是'] }] })
    expect(getResumedFollowup('call-resumed')?.answers[0]?.selected).toEqual(['是'])
  })
})
