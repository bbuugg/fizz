/** 防止文档选择器、客户端上传和服务端白名单对同一文件给出不同 MIME，或误放行 HTML / SVG。 */
import { describe, expect, it } from 'vitest'
import { isTextDocumentMime, normalizeUploadMediaType, UPLOAD_DOCUMENT_ACCEPT } from './agent-api'

describe('文档上传类型归一化', () => {
  it.each([
    ['notes.TXT', '', 'text/plain'],
    ['notes.md', 'application/octet-stream', 'text/markdown'],
    ['notes.markdown', 'text/x-markdown', 'text/markdown'],
    ['data.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['data.json', 'text/plain', 'application/json'],
    ['report.docx', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['report.pdf', 'application/pdf', 'application/pdf'],
    ['photo.jpeg', '', 'image/jpeg']
  ])('%s 的浏览器 MIME %s 归一为 %s', (name, mime, expected) => {
    expect(normalizeUploadMediaType(name, mime)).toBe(expected)
  })

  it.each([
    ['page.html', 'text/html'], ['photo.svg', 'image/svg+xml'],
    ['report.txt', 'text/html'], ['report.doc', 'application/msword'],
    ['book.xlsx', ''], ['archive.zip', 'application/zip'], ['txt', '']
  ])('拒绝范围外文件 %s', (name, mime) => {
    expect(normalizeUploadMediaType(name, mime)).toBeNull()
  })

  it('PDF 不走文字提取，所有首批文档扩展名都在选择器内', () => {
    expect(isTextDocumentMime('application/pdf')).toBe(false)
    expect(isTextDocumentMime('application/json')).toBe(true)
    for (const ext of ['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.json']) {
      expect(UPLOAD_DOCUMENT_ACCEPT.split(',')).toContain(ext)
    }
  })
})
