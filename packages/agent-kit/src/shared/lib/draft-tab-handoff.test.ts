/** Regression coverage for keeping async draft creation tied to its originating tab. */
import { describe, expect, it } from 'vitest'
import { consumeDraftConversation, markDraftConversation } from './draft-tab-handoff'

describe('draft tab handoff', () => {
  it('returns only the originating tab key and consumes each conversation once', () => {
    markDraftConversation('conv-a', 'chat:1')
    markDraftConversation('conv-b', 'chat:2')

    expect(consumeDraftConversation('conv-b')).toEqual({ tabKey: 'chat:2' })
    expect(consumeDraftConversation('conv-b')).toBeNull()
    expect(consumeDraftConversation('conv-a')).toEqual({ tabKey: 'chat:1' })
    expect(consumeDraftConversation('conv-a')).toBeNull()
  })

  it('does not consume a different conversation\'s pending source', () => {
    markDraftConversation('conv-a', 'chat:1')

    expect(consumeDraftConversation('conv-b')).toBeNull()
    expect(consumeDraftConversation('conv-a')).toEqual({ tabKey: 'chat:1' })
  })

  it('records a missing source as a consumed handoff instead of falling back to another draft', () => {
    markDraftConversation('conv-a', null)

    expect(consumeDraftConversation('conv-a')).toEqual({ tabKey: null })
    expect(consumeDraftConversation('conv-a')).toBeNull()
  })
})
