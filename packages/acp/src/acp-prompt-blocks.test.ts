/**
 * `session/prompt` 的内容块组装（ACP 附件）。
 *
 * 这条测试在防的回归：
 * 1. **只发一张图、不写字**被判成「没有要发送的内容」（原来只判 `text`）；
 * 2. 顺序被改掉（说明 / 图片 / 正文）——顺序错了模型读到的第一句就变成正文，
 *    「哪张图没带上」的说明石沉大海；
 * 3. 图片没走 base64（协议里 `data` 是 base64 字符串，塞原始字节会被 zod 静默丢弃）。
 */
import { describe, expect, it } from 'vitest'
import { buildPromptBlocks } from './acp'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('buildPromptBlocks', () => {
  it('说明在前、图片居中、正文在后', () => {
    const blocks = buildPromptBlocks(
      {
        attachmentNote: '（有一张图超限没发）',
        attachments: [{ mediaType: 'image/png', data: PNG, name: 'a.png' }],
      },
      '这是什么',
    )
    expect(blocks).toEqual([
      { type: 'text', text: '（有一张图超限没发）' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') },
      { type: 'text', text: '这是什么' },
    ])
  })

  it('只有图片（没有正文）也是一个合法的 prompt', () => {
    const blocks = buildPromptBlocks(
      { attachments: [{ mediaType: 'image/jpeg', data: PNG }] },
      '   ',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
  })

  it('什么都没有 → 空数组（调用方据此报「没有要发送的内容」）', () => {
    expect(buildPromptBlocks({}, '')).toEqual([])
    expect(buildPromptBlocks({ attachmentNote: '  ' }, '  ')).toEqual([])
  })
})
