/** 防止延迟完成的图片预览在取消或切会话后仍发起附件上传。 */
import { describe, expect, it } from 'vitest'
import { fileRefsOfParts, sendableAttachments, shouldStartAttachmentUpload, splitUploadable } from './attachments'

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

/** 文档 MIME 为空时也能上传；发送 / 队列仍只携带引用，不能把预览塞进历史。 */
describe('文档附件引用', () => {
  it('放行首批文档并拒绝 HTML / SVG / 超限文件', () => {
    const docs = ['a.pdf', 'a.docx', 'a.txt', 'a.md', 'a.csv', 'a.json'].map((name) => new File(['content'], name))
    const rejected = [new File(['html'], 'page.html', { type: 'text/html' }), new File(['svg'], 'a.svg', { type: 'image/svg+xml' })]
    const result = splitUploadable([...docs, ...rejected])
    expect(result.ok).toEqual(docs)
    expect(result.rejected.map((item) => item.name)).toEqual(['page.html', 'a.svg'])
  })

  it('已上传文档仅携带 URL / MIME / 名称，未上传附件不进请求', () => {
    const ref = { name: 'notes.md', mediaType: 'text/markdown', url: '/api/uploads/notes.md' }
    const result = sendableAttachments([
      { ...ref, id: 'one', uploaded: true, progress: 100, previewUrl: 'data:fake;base64,AAAA' },
      { ...ref, id: 'two', uploaded: false, progress: 50 }
    ])
    expect(result).toEqual([ref])
    expect(fileRefsOfParts([{ type: 'file', ...ref }])).toEqual([ref])
    expect(JSON.stringify(result)).not.toContain('base64')
  })
})
