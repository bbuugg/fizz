/**
 * 标签身份模型：**标签 key 是身份，不是地址**。
 *
 * 这里钉的是整套重构的地基。每条用例对应一个真实报过的 bug，或一个「改回去就会复发」的
 * 不变量 —— 改 `panel-store` 的开标签 / 指向逻辑前先读一遍：
 *
 * 1. 草稿发出第一条消息 → 那颗草稿标签**原地**变成会话标签：key、位置、焦点都不动
 *    （用户报的「发个消息，右侧面板重建 / 终端历史没了」「又开了一个标签页」）；
 * 2. 一条会话最多一颗标签、草稿最多一颗（靠指向表查重，不靠 key）；
 * 3. 「当前会话变了」的对齐只有一条规则（`alignConversationTab`），三端共用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activeTabKey,
  alignConversationTab,
  allTabKeys,
  bindDraftTab,
  closeTab,
  conversationOfTab,
  draftTabKey,
  isDraftTab,
  openChatTab,
  openDraftTab,
  openTab,
  resetLayout,
  setSingleTabMode,
  staleConversationTabs,
  tabOfConversation
} from './panel-store'

beforeEach(() => {
  setSingleTabMode(false)
  resetLayout([])
})

afterEach(() => {
  setSingleTabMode(false)
})

describe('对话标签的指向表', () => {
  it('草稿标签指向「没有」，不是会话；工具标签根本不在表里', () => {
    const draft = openDraftTab()
    openTab('local:1')

    expect(isDraftTab(draft)).toBe(true)
    expect(conversationOfTab(draft)).toBeNull()
    expect(conversationOfTab('local:1')).toBeUndefined()
  })

  it('一条会话最多一颗标签：再开只是切过去，不新开', () => {
    const first = openChatTab('conv-a')
    const second = openChatTab('conv-a')

    expect(second).toBe(first)
    expect(allTabKeys()).toEqual([first])
    expect(tabOfConversation('conv-a')).toBe(first)
    expect(conversationOfTab(first)).toBe('conv-a')
  })

  it('草稿最多一颗：再开只是切过去', () => {
    const first = openDraftTab()
    openChatTab('conv-a') // 焦点挪走
    const second = openDraftTab()

    expect(second).toBe(first)
    expect(allTabKeys().filter(isDraftTab)).toEqual([first])
    expect(activeTabKey()).toBe(first)
  })

  it('标签关掉后指向回收；同一条会话再开是一颗全新的标签（不复用旧身份）', () => {
    const first = openChatTab('conv-a')
    closeTab(first)

    expect(tabOfConversation('conv-a')).toBeNull()
    expect(conversationOfTab(first)).toBeUndefined()

    const second = openChatTab('conv-a')
    expect(second).not.toBe(first)
    // 旧 key 不再被认作任何标签（按它索引的现场 / 守卫随之失效，正是想要的）
    expect(isDraftTab(first)).toBe(false)
  })

  it('会话 id 与标签 key 长得不一样（key 里解析不出会话 id）', () => {
    expect(openChatTab('conv-a')).not.toBe('conv-a')
    expect(openChatTab('conv-a')).toMatch(/^chat:\d+$/)
  })
})

describe('草稿 → 会话：只换指向，不换身份', () => {
  it('草稿是唯一标签时发出第一条消息：同一颗标签，位置 / 焦点都不动', () => {
    const draft = openDraftTab()

    alignConversationTab('conv-new', { draftHandoff: { tabKey: draft } })

    expect(allTabKeys()).toEqual([draft])
    expect(activeTabKey()).toBe(draft)
    expect(conversationOfTab(draft)).toBe('conv-new')
    expect(tabOfConversation('conv-new')).toBe(draft)
    expect(draftTabKey()).toBeNull()
  })

  /**
   * 用户报的「发个消息怎么又开了一个标签页」：旁边还开着别的标签时，草稿不能留着、
   * 旁边再冒出一条会话标签。
   */
  it('旁边还开着别的标签：只动草稿这一颗，其它标签原样保留、位置不变', () => {
    const a = openChatTab('conv-a')
    const draft = openDraftTab()
    expect(activeTabKey()).toBe(draft)

    alignConversationTab('conv-b', { draftHandoff: { tabKey: draft } })

    // 草稿还在第 2 颗的位置上，只是换了指向；没有新 key 混进来
    expect(allTabKeys()).toEqual([a, draft])
    expect(conversationOfTab(draft)).toBe('conv-b')
    expect(activeTabKey()).toBe(draft)
  })

  /**
   * 建会话是异步的（ACP 要起进程）：用户等不及切去看别的标签，回来时草稿已经不是焦点
   * —— 判据不能是「草稿此刻是不是焦点」，否则又回到「草稿留着 + 多出一条」。
   */
  it('等建会话时切去了别的标签：草稿照样接下这条会话，焦点留在用户正看的那颗上', () => {
    const draft = openDraftTab()
    openChatTab('conv-a') // 用户切走了
    expect(activeTabKey()).toBe(tabOfConversation('conv-a'))

    alignConversationTab('conv-new', { draftHandoff: { tabKey: draft } })

    expect(conversationOfTab(draft)).toBe('conv-new')
    expect(tabOfConversation('conv-new')).toBe(draft)
    // 焦点没被抢
    expect(activeTabKey()).toBe(tabOfConversation('conv-a'))
  })

  it('发起创建的草稿已关闭时，旧请求不会认领后来打开的新草稿', () => {
    const sourceDraft = openDraftTab()
    closeTab(sourceDraft)
    const replacementDraft = openDraftTab()

    alignConversationTab('conv-old-request', { draftHandoff: { tabKey: sourceDraft } })

    expect(isDraftTab(replacementDraft)).toBe(true)
    expect(conversationOfTab(replacementDraft)).toBeNull()
    expect(tabOfConversation('conv-old-request')).not.toBe(replacementDraft)
    expect(activeTabKey()).toBe(replacementDraft)
  })

  it('handoff 没有来源标签时也不把当前草稿误当成发起者', () => {
    const replacementDraft = openDraftTab()

    alignConversationTab('conv-without-source', { draftHandoff: { tabKey: null } })

    expect(isDraftTab(replacementDraft)).toBe(true)
    expect(conversationOfTab(replacementDraft)).toBeNull()
    expect(tabOfConversation('conv-without-source')).not.toBe(replacementDraft)
  })

  it('上一颗草稿已经指向会话后再来一条：没有草稿可指 → 新开一颗，不动已有标签', () => {
    const draft = openDraftTab()
    alignConversationTab('conv-1', { draftHandoff: { tabKey: draft } })

    alignConversationTab('conv-2', {})

    expect(conversationOfTab(draft)).toBe('conv-1')
    expect(tabOfConversation('conv-2')).not.toBe(draft)
    expect(allTabKeys()).toHaveLength(2)
  })

  it('草稿正被看着时恢复出会话（启动恢复）：由草稿接下，不并排多出一张「新对话」', () => {
    const draft = openDraftTab()

    alignConversationTab('conv-restored', {})

    expect(allTabKeys()).toEqual([draft])
    expect(conversationOfTab(draft)).toBe('conv-restored')
  })

  /**
   * 删掉当前会话时 store 会把当前会话切到邻居：这时**不能**把后台那张草稿指过去，
   * 否则草稿里的终端现场凭空变成邻居会话的。
   */
  it('草稿挂在后台、会话也不是草稿建的 → 正常新开，草稿不动', () => {
    const draft = openDraftTab()
    openChatTab('conv-a')

    alignConversationTab('conv-b', {})

    expect(isDraftTab(draft)).toBe(true)
    expect(tabOfConversation('conv-b')).not.toBe(draft)
    expect(allTabKeys().length).toBe(3)
  })

  it('没有草稿 → 正常新开', () => {
    openChatTab('conv-a')

    alignConversationTab('conv-b', {})

    expect(tabOfConversation('conv-b')).not.toBeNull()
  })

  it('会话已经有标签 → 什么都不做（连指向都不碰）', () => {
    const draft = openDraftTab()
    const existing = openChatTab('conv-a')

    alignConversationTab('conv-a', { draftHandoff: { tabKey: draft } })

    expect(allTabKeys()).toEqual([draft, existing])
    expect(isDraftTab(draft)).toBe(true)
  })

  it('bindDraftTab：三种结果各自明确', () => {
    expect(bindDraftTab('conv-x')).toBe('no-draft')

    const draft = openDraftTab()
    expect(bindDraftTab('conv-x')).toBe('bound')
    expect(conversationOfTab(draft)).toBe('conv-x')
    // 同一条会话再绑一次：已经有标签了，草稿（此时已不是草稿）不动
    expect(bindDraftTab('conv-x')).toBe('already-open')
  })
})

describe('alignConversationTab：首次挂载不抢焦点', () => {
  it('focus: false 时只补进来，焦点留在原来那颗上', () => {
    openTab('local:1')

    alignConversationTab('conv-a', { focus: false })

    expect(tabOfConversation('conv-a')).not.toBeNull()
    expect(activeTabKey()).toBe('local:1')
  })

  it('草稿正被看着时即便 focus: false 也由草稿接下（它本来就在焦点上）', () => {
    const draft = openDraftTab()

    alignConversationTab('conv-a', { focus: false })

    expect(conversationOfTab(draft)).toBe('conv-a')
    expect(activeTabKey()).toBe(draft)
  })
})

describe('staleConversationTabs：会话没了，标签跟着消失', () => {
  it('只挑出指向已消失 / 已归档会话的标签；草稿与工具标签不算', () => {
    const alive = openChatTab('conv-alive')
    const gone = openChatTab('conv-gone')
    const draft = openDraftTab()
    openTab('local:1')

    const stale = staleConversationTabs(new Set(['conv-alive']))

    expect(stale).toEqual([gone])
    expect(stale).not.toContain(alive)
    expect(stale).not.toContain(draft)
  })
})

describe('单标签模式（手机壳）', () => {
  it('草稿页发消息：还是那一颗标签，不新开', () => {
    setSingleTabMode(true)
    const draft = openDraftTab()

    alignConversationTab('conv-new', { draftHandoff: { tabKey: draft } })

    expect(allTabKeys()).toEqual([draft])
    expect(conversationOfTab(draft)).toBe('conv-new')
  })

  it('打开别的会话 = 替换当前视图（旧的收起）', () => {
    setSingleTabMode(true)
    openDraftTab()

    openChatTab('conv-a')

    expect(allTabKeys()).toHaveLength(1)
    expect(conversationOfTab(allTabKeys()[0])).toBe('conv-a')
  })
})

describe('清理', () => {
  it('resetLayout 清掉指向表', () => {
    openChatTab('conv-a')
    resetLayout([])

    expect(tabOfConversation('conv-a')).toBeNull()
    expect(draftTabKey()).toBeNull()
  })
})
