/**
 * ACP 工具结果的渲染判定：什么样的文本能当 markdown 渲染。
 *
 * 这条判定的代价是不对称的 —— 漏判只是「围栏原样露出」，误判会把原始终端输出
 * 重新排版（缩进、ASCII 表格、原生 diff 全散）。所以用例重点在**不该命中**的那侧。
 */
import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown } from './markdown-text'

describe('looksLikeMarkdown', () => {
  it('围栏代码块：带 diff 的结果命中', () => {
    expect(
      looksLikeMarkdown('改了这些文件：\n\n```diff\n-a\n+b\n```\n')
    ).toBe(true)
    expect(looksLikeMarkdown('```ts\nconst a = 1\n```')).toBe(true)
    expect(looksLikeMarkdown('  ~~~\nplain\n  ~~~')).toBe(true)
  })

  it('首行是标题：命中；标题在日志中间：不命中', () => {
    expect(looksLikeMarkdown('### 变更总结\n\n改了两处')).toBe(true)
    expect(looksLikeMarkdown('\n\n## 结果\n内容')).toBe(true)
    expect(looksLikeMarkdown('编译日志\n# 这是普通输出里的注释\n继续')).toBe(false)
  })

  it('列表块：开头 / 空行后的连续两项命中', () => {
    expect(looksLikeMarkdown('- 第一项\n- 第二项')).toBe(true)
    expect(looksLikeMarkdown('总结：\n\n1. 新建文件\n2. 补充测试')).toBe(true)
    expect(looksLikeMarkdown('* a\n+ b')).toBe(true)
  })

  it('单行列表 / 前一行不是空行的列表：不命中', () => {
    expect(looksLikeMarkdown('- 只有一项')).toBe(false)
    expect(looksLikeMarkdown('日志首行\n- 像是列表但紧跟正文\n- 第二行')).toBe(false)
  })

  it('原始终端输出：不命中（含原生 diff、构建日志、ASCII 表格）', () => {
    expect(
      looksLikeMarkdown('@@ -1,2 +1,2 @@\n-a old line\n-b old line\n+c\n')
    ).toBe(false)
    expect(
      looksLikeMarkdown('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n')
    ).toBe(false)
    expect(looksLikeMarkdown('NAME      SIZE\nfoo.txt   12\nbar.txt   34')).toBe(false)
    expect(looksLikeMarkdown('')).toBe(false)
  })
})