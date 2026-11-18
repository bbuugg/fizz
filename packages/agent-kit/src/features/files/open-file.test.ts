/**
 * 「打开文件」请求的认领规则。
 *
 * 防的回归：同一个工作区同时挂着多套文件面板（分屏 / 后台标签）时，只按 `workspaceId`
 * 认领会被最先跑 effect 的那套面板消费掉 —— 发起方这边面板被切出来了，文件却开在
 * 别的标签里（用户看到的就是「只打开文件面板、文件没打开」）。
 */
import { describe, expect, it } from 'vitest'
import { matchesOpenFileRequest, type OpenFileRequest } from './open-file'

const request: OpenFileRequest = {
  panelKey: 'conv-a',
  workspaceId: 'ws-1',
  path: 'docs/plan.md',
  nonce: 1,
}

describe('matchesOpenFileRequest', () => {
  it('只认发起方那个标签的面板', () => {
    expect(matchesOpenFileRequest(request, 'conv-a', 'ws-1')).toBe(true)
  })

  it('同一工作区的其它标签不能消费', () => {
    expect(matchesOpenFileRequest(request, 'conv-b', 'ws-1')).toBe(false)
  })

  it('工作区对不上不能消费', () => {
    expect(matchesOpenFileRequest(request, 'conv-a', 'ws-2')).toBe(false)
  })

  it('没有请求或面板没有 key 时不认领', () => {
    expect(matchesOpenFileRequest(null, 'conv-a', 'ws-1')).toBe(false)
    expect(matchesOpenFileRequest(request, undefined, 'ws-1')).toBe(false)
    expect(matchesOpenFileRequest(request, 'conv-a', undefined)).toBe(false)
  })
})
