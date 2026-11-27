/** 上传时校验、投递时提取文字；不改原文件、不落解析副本，也不执行文档里的任何内容。 */
import { isTextDocumentMime, UPLOAD_MAX_BYTES } from '@fizz/contracts/agent-api'
import { readZip } from '../lib/zip'

export const MAX_DOCUMENT_TEXT_CHARS = 32_000
const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 支持 UTF-8、带 BOM 的 UTF-16；错误编码明确报错，不能把乱码作为文档正文。 */
function decodeText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new Error('文档编码不支持，请另存为 UTF-8 后重新上传')
  }
  if (text.includes('\0')) throw new Error('文档包含二进制内容，请上传有效的文本文件')
  return text
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, value: string) => {
    if (!value.startsWith('#')) return named[value] ?? entity
    const code = value[1].toLowerCase() === 'x' ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1))
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '\ufffd'
  })
}

/** 有界提取 WordprocessingML 的正文文字与表格分隔，不把 XML 属性、关系或脚本当正文。 */
function docxText(bytes: Uint8Array): Pick<DocumentText, 'text' | 'truncated'> {
  const entries = readZip(Buffer.from(bytes), {
    maxEntries: 2048,
    maxFileBytes: MAX_DOCX_XML_BYTES,
    maxTotalBytes: MAX_DOCX_XML_BYTES,
    include: (name) => name === 'word/document.xml'
  })
  if (entries.length !== 1) throw new Error('不是有效的 DOCX 文档，或正文缺失')
  const xml = decodeText(entries[0].data)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 正文包含不支持的 XML 声明')
  const namespace = /xmlns(?::([\w.-]+))?\s*=\s*["'](?:http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/wordprocessingml\/main)["']/.exec(xml)
  if (!namespace) throw new Error('DOCX 正文格式不支持')
  const prefix = namespace[1] ? `${namespace[1]}:` : ''
  let inBody = false
  let foundBody = false
  let inText = false
  let length = 0
  let truncated = false
  const output: string[] = []
  const append = (text: string): void => {
    if (length === 0) text = text.trimStart()
    const piece = text.slice(0, MAX_DOCUMENT_TEXT_CHARS + 1 - length)
    if (text.slice(piece.length).trim()) truncated = true
    if (piece) output.push(piece)
    length += piece.length
  }
  // 注释 / CDATA / processing instruction 单独识别；普通标签允许属性值里含 >。
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g
  for (const token of xml.matchAll(tokens)) {
    if (truncated) break
    const raw = token[0]
    if (raw.startsWith('<!--') || raw.startsWith('<?')) continue
    if (raw.startsWith('<![CDATA[')) {
      if (inBody && inText) append(token[1])
      continue
    }
    if (!raw.startsWith('<')) {
      if (inBody && inText) append(decodeEntities(raw))
      continue
    }
    const tag = /^<(\/?)([\w:.-]+)(?:\s|\/?>)/.exec(raw)
    if (!tag || !tag[2].startsWith(prefix)) continue
    const local = tag[2].slice(prefix.length)
    const closing = tag[1] === '/'
    if (local === 'body') {
      inBody = !closing
      foundBody = true
      continue
    }
    if (!inBody) continue
    if (local === 't') inText = !closing && !raw.endsWith('/>')
    else if (!closing && ['br', 'cr'].includes(local)) append('\n')
    else if (!closing && local === 'tab') append('\t')
    else if (closing && local === 'tc') append('\t')
    else if (closing && (local === 'p' || local === 'tr')) append('\n')
  }
  if (!foundBody) throw new Error('DOCX 正文缺失')
  return { text: output.join(''), truncated }
}

export interface DocumentText {
  text: string
  truncated: boolean
  /** DOCX 不包含版式与内嵌图片，必须让模型和用户知道。 */
  textOnly: boolean
}

export function extractDocumentText(mediaType: string, bytes: Uint8Array): DocumentText | null {
  if (!isTextDocumentMime(mediaType)) return null
  if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new Error('文档不能超过 10MB')
  const textOnly = mediaType === DOCX_MIME
  const extracted = textOnly ? docxText(bytes) : { text: decodeText(bytes), truncated: false }
  const text = extracted.text.trim()
  if (!text) throw new Error('文档中没有可提取的文字')
  const truncated = extracted.truncated || text.length > MAX_DOCUMENT_TEXT_CHARS
  return {
    text: text.slice(0, MAX_DOCUMENT_TEXT_CHARS).replace(/[\uD800-\uDBFF]$/u, ''),
    truncated,
    textOnly
  }
}

export function documentWarnings(document: DocumentText): string[] {
  return [
    ...(document.textOnly ? ['DOCX 仅提取正文与表格文字，不含图片、页眉页脚及原始排版。'] : []),
    ...(document.truncated ? [`文档过长，仅发送前 ${MAX_DOCUMENT_TEXT_CHARS} 个字符，后续内容已截断。`] : [])
  ]
}

export function formatDocumentText(name: string, document: DocumentText): string {
  const notes = documentWarnings(document)
  return `【文档 ${JSON.stringify(name)}】${notes.length ? `\n（${notes.join('')}）` : ''}\n${document.text}\n【文档结束】`
}
