/** 防止延迟完成的图片预览在取消或切会话后仍发起附件上传。 */
import { describe, expect, it } from 'vitest'
import { shouldStartAttachmentUpload } from './attachments'

describe('shouldStartAttachmentUpload', () => {
  it('拒绝预览完成前已取消的上传', () => {
    const controller = new AbortController()
    controller.abort()
    expect(shouldStartAttachmentUpload(controller.signal, 'conversation-a', 'conversation-a')).toBe(false)
  })

  it('拒绝已经切换到其它会话的延迟预览', () => {
    const controller = new AbortController()
    expect(shouldStartAttachmentUpload(controller.signal, 'conversation-a', 'conversation-b')).toBe(false)
  })

  it('只在仍属当前会话且未取消时允许开始上传', () => {
    expect(shouldStartAttachmentUpload(new AbortController().signal, 'conversation-a', 'conversation-a')).toBe(true)
  })
})
