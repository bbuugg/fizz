/**
 * 助手会话存档（localStorage）的语义。
 *
 * 这块是「保存下来 + 助手间共享 + 支持切换」的地基，坏了的后果都不是报错而是**悄悄丢历史**，
 * 所以几条约束必须钉住：
 *
 * 1. 消息为空 = 删掉这一段（不留空壳）；
 * 2. 份数超上限丢最老的，但**刚写的那段**永远留着；
 * 3. 单段就超容量上限时宁可不落盘（不要写爆配额把别的会话一起挤掉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import {
  assistantConversationTitle,
  dropAssistantConversation,
  loadAssistantStore,
  saveAssistantActiveId,
  saveAssistantConversation
} from './assistant-history'

const V2_KEY = 'fizz.agent.assistant.conversations.v2'

/** 最小 localStorage 替身（node 环境下没有） */
class FakeStorage {
  map = new Map<string, string>()
  /** 置 true = 每次写都抛配额错误（隐私模式 / 满盘） */
  failWrites = false

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }
}

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
  vi.stubGlobal('localStorage', storage)
})

it('SSH 目标与会话一起落盘恢复，旧存档不凭空绑定目标', () => {
  saveAssistantConversation('ssh', turn('日志'), 100, { hostId: 'h1', cwd: '/var/log' })
  saveAssistantConversation('old', turn('项目'), 101)
  expect(loadAssistantStore().conversations.ssh.remoteTarget).toEqual({ hostId: 'h1', cwd: '/var/log' })
  expect(loadAssistantStore().conversations.old.remoteTarget).toBeUndefined()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function message(role: 'user' | 'assistant', text: string, id = `${role}-${text.slice(0, 6)}`): AgentChatMessage {
  return { id, role, parts: [{ type: 'text', text }], createdAt: 1 }
}

const turn = (text: string): AgentChatMessage[] => [
  message('user', text, `u-${text}`),
  message('assistant', `回答：${text}`, `a-${text}`)
]

describe('assistant-history · 读写', () => {
  it('存进去能原样读回来（含 activeId）', () => {
    saveAssistantConversation('asst-1', turn('你好'), 111)
    saveAssistantActiveId('asst-1')

    const store = loadAssistantStore()

    expect(store.activeId).toBe('asst-1')
    expect(store.conversations['asst-1'].messages).toHaveLength(2)
    expect(store.conversations['asst-1'].updatedAt).toBe(111)
  })

  it('消息为空 = 删掉这一段，不留空壳', () => {
    saveAssistantConversation('asst-1', turn('你好'), 111)
    saveAssistantConversation('asst-1', [], 222)

    expect(loadAssistantStore().conversations).toEqual({})
    // 空了就整份清掉，别在 localStorage 里留一个 {"conversations":{}}
    expect(storage.getItem(V2_KEY)).toBe(null)
  })

  it('drop 掉当前会话时指针一起归零（读的人会退回最近一段）', () => {
    saveAssistantConversation('asst-1', turn('你好'), 111)
    saveAssistantActiveId('asst-1')

    dropAssistantConversation('asst-1')

    const store = loadAssistantStore()
    expect(store.conversations).toEqual({})
    expect(store.activeId).toBe(null)
  })

  it('activeId 指向一段还没落盘的会话时原样保留（新建后没说话）', () => {
    saveAssistantConversation('asst-1', turn('你好'), 111)
    saveAssistantActiveId('asst-new')

    // 这里不校验悬空指针：校验会把指针抹掉，下一句写进来时反而丢了当前会话
    expect(loadAssistantStore().activeId).toBe('asst-new')
  })

  it('坏数据整份丢弃（宁可空，也不拿半个对象去渲染消息列）', () => {
    storage.map.set(V2_KEY, '{ 这不是 json')

    expect(loadAssistantStore()).toEqual({ activeId: null, conversations: {} })
  })

  it('键与内部 sessionId 不一致的那条丢掉（否则会拿错 run 键）', () => {
    storage.map.set(
      V2_KEY,
      JSON.stringify({
        activeId: null,
        conversations: {
          'asst-1': { sessionId: 'asst-9', messages: turn('串了'), updatedAt: 1 }
        }
      })
    )

    expect(loadAssistantStore().conversations).toEqual({})
  })
})

describe('assistant-history · 上限', () => {
  it('超过 20 段丢最老的，但刚写的那段一定留着', () => {
    // 21 段，越靠后越新；第 1 段最老
    for (let i = 1; i <= 21; i += 1) {
      saveAssistantConversation(`asst-${i}`, turn(`第 ${i} 段`), i * 1000)
    }

    const store = loadAssistantStore()
    const ids = Object.keys(store.conversations)

    expect(ids).toHaveLength(20)
    expect(ids).not.toContain('asst-1')
    expect(ids).toContain('asst-21')
  })

  it('单段就超容量上限：宁可不落盘，也不写爆配额', () => {
    // 一条 45 万字符的消息 → 整份 JSON 必然超过 40 万上限，且只有 1 条没法再砍
    saveAssistantConversation('asst-1', [message('user', 'x'.repeat(450_000))], 1)

    expect(storage.getItem(V2_KEY)).toBe(null)
    expect(loadAssistantStore().conversations).toEqual({})
  })
})

describe('assistant-history · 标题', () => {
  it('取第一条用户消息的首行并截断', () => {
    const messages = [
      message('assistant', '在的，请说'),
      message('user', '帮我看一下这个项目的构建脚本\n还有 CI'),
      message('user', '第二句不该当标题')
    ]

    const title = assistantConversationTitle(messages)

    expect(title.startsWith('帮我看一下这个项目的构建脚本')).toBe(true)
    expect(title).not.toContain('\n')
    expect(title).not.toContain('第二句')
  })

  it('超长标题截断到 24 字 + 省略号', () => {
    const title = assistantConversationTitle([message('user', '一'.repeat(50))])

    expect(title).toBe(`${'一'.repeat(24)}…`)
  })

  it('还没有用户消息 = 新会话', () => {
    expect(assistantConversationTitle([])).toBe('新会话')
    expect(assistantConversationTitle([message('assistant', '我先说话')])).toBe('新会话')
  })
})
