/** 防止 DOCX 被当二进制透传、段落表格丢失，以及坏编码 / 压缩炸弹 / 超长正文拖垮文档投递。 */
import { describe, expect, it } from 'vitest'
import { createZip } from '../lib/zip'
import { extractDocumentText, formatDocumentText, MAX_DOCUMENT_TEXT_CHARS } from './documents'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const docx = (body: string, prefix = 'w') => createZip([{
  name: 'word/document.xml',
  data: Buffer.from(`<${prefix}:document xmlns:${prefix}="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`)
}])

describe('文档文字提取', () => {
  it.each(['text/plain', 'text/markdown', 'text/csv', 'application/json'])('%s 保留正文，而不是 base64 文本', (mime) => {
    const document = extractDocumentText(mime, Buffer.from('你好, world\n[1,2]'))!
    expect(document).toEqual({ text: '你好, world\n[1,2]', textOnly: false, truncated: false })
    expect(formatDocumentText('文档.txt', document)).toContain('【文档 "文档.txt"】\n你好')
  })

  it('支持 UTF-8 BOM 与 UTF-16 BOM，不把无 BOM 二进制强行当文本', () => {
    expect(extractDocumentText('text/plain', Buffer.from('\ufeff你好'))?.text).toBe('你好')
    expect(extractDocumentText('text/plain', Buffer.from('\ufeff你好', 'utf16le'))?.text).toBe('你好')
    const be = Buffer.from('\ufeff你好', 'utf16le').swap16()
    expect(extractDocumentText('text/plain', be)?.text).toBe('你好')
    expect(() => extractDocumentText('text/plain', Buffer.from([0xff, 0x80]))).toThrow('UTF-8')
    expect(() => extractDocumentText('text/plain', Buffer.from([1, 0, 2]))).toThrow('二进制')
  })

  it('长文档截断并带说明，不切断末尾 emoji', () => {
    const document = extractDocumentText('text/plain', Buffer.from('a'.repeat(MAX_DOCUMENT_TEXT_CHARS - 1) + '😀end'))!
    expect(document.truncated).toBe(true)
    expect(document.text).toBe('a'.repeat(MAX_DOCUMENT_TEXT_CHARS - 1))
    expect(formatDocumentText('long.md', document)).toContain('已截断')
  })

  it('DOCX 截断点恰好是空格时仍提示截断，前导空白不耗尽正文额度', () => {
    const long = extractDocumentText(DOCX, docx(`<w:p><w:r><w:t>${'a'.repeat(MAX_DOCUMENT_TEXT_CHARS)} omitted</w:t></w:r></w:p>`))!
    expect(long.truncated).toBe(true)
    const leading = extractDocumentText(DOCX, docx(`<w:p><w:r><w:t>${' '.repeat(MAX_DOCUMENT_TEXT_CHARS + 1)}正文</w:t></w:r></w:p>`))!
    expect(leading.text).toBe('正文')
  })

  it('DOCX 保留跨 run 文字、实体、段落、换行与表格内容，忽略属性 / 字段指令', () => {
    const document = extractDocumentText(DOCX, docx(
      '<w:p><w:r><w:t>Hello &amp; &#x4E16;&#30028;</w:t></w:r><w:r><w:tab/><w:t>next</w:t><w:br/><w:t>end</w:t><w:instrText>HIDDEN</w:instrText></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    ))!
    expect(document.text).toContain('Hello & 世界\tnext\nend')
    expect(document.text).toContain('甲')
    expect(document.text).toContain('乙')
    expect(document.text).not.toContain('HIDDEN')
    expect(document.textOnly).toBe(true)
    expect(formatDocumentText('report.docx', document)).toContain('不含图片')
  })

  it('Word XML 的命名空间别名与 CDATA 正文也能提取', () => {
    const bytes = docx('<x:p><x:r><x:t><![CDATA[A < B]]></x:t></x:r></x:p>', 'x')
    expect(extractDocumentText(DOCX, bytes)?.text).toBe('A < B')
  })

  it('只解压 DOCX 正文，不展开内嵌图片；正文本身过大则拒绝', () => {
    const archive = createZip([
      { name: 'word/document.xml', data: Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>') },
      { name: 'word/media/image.png', data: Buffer.alloc(5 * 1024 * 1024) }
    ])
    expect(extractDocumentText(DOCX, archive)?.text).toBe('正文')
    expect(() => extractDocumentText(DOCX, docx(`<w:p><w:r><w:t>${'x'.repeat(4 * 1024 * 1024)}</w:t></w:r></w:p>`))).toThrow('过大')
  })

  it('空文档、损坏 DOCX 和实体声明在投递前报错', () => {
    expect(() => extractDocumentText('text/plain', Buffer.from(' \n '))).toThrow('没有可提取')
    expect(() => extractDocumentText(DOCX, Buffer.from('not a zip'))).toThrow()
    expect(() => extractDocumentText(DOCX, createZip([{ name: 'other.xml', data: Buffer.from('x') }]))).toThrow('正文缺失')
    expect(() => extractDocumentText(DOCX, docx('<!DOCTYPE x><w:p/>'))).toThrow('XML 声明')
    expect(() => extractDocumentText(DOCX, docx('<w:p/>'))).toThrow('没有可提取')
  })

  it('PDF 和图片继续交给原生附件链路', () => {
    expect(extractDocumentText('application/pdf', Buffer.from('pdf'))).toBeNull()
    expect(extractDocumentText('image/png', Buffer.from('png'))).toBeNull()
  })
})
