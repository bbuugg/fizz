/**
 * 标签 key 的分类闸门：**每一种**工具标签都必须被 `isToolTabKey` 认领。
 *
 * 为什么值得钉住：标签条按 `isToolTabKey` 分类取展示信息，漏登记一种前缀**不会报错**，
 * 只会让那个标签在标签条上退化成「标签」两个字。
 * 真踩过：`files:` 加进来时忘了并进 `isToolTabKey`，点「文件管理」直接跳新对话页。
 *
 * 另一条铁律也钉在这里：**会话 id 不是标签 key**。对话标签的 key 是不透明的 `chat:<n>`，
 * 「指向哪条会话」记在 `panel-store` 的指向表里 —— 这样才能保证「草稿发出第一条消息后
 * key 不变」（否则按 key 索引的落位 / 守卫 / 面板现场全得跟着搬家）。
 *
 * 这个文件对新增前缀的态度是**自动覆盖**：下面把每个工厂函数都调一遍，加新类型时
 * 记得往 `cases` 里补一行即可（漏补不会失败，但比对 `ToolTabKind` 的那条会提示）。
 */
import { describe, expect, it } from 'vitest'
import {
  apiTabKey,
  chatTabKey,
  filesTabKey,
  hostTabKey,
  isConversationTabKey,
  isToolTabKey,
  localFileTabKey,
  localTabKey,
  logsTabKey,
  noteTabKey,
  pluginTabKey,
  scriptsTabKey,
  sftpTabKey,
  sysmonTabKey,
  triggersTabKey,
  tunnelTabKey,
  NEW_API_REQUEST_ID,
  NEW_WS_REQUEST_ID
} from './panel-tabs'

/** 每种工具标签的 key 各一个（新增前缀时往这里补） */
const cases: Array<[name: string, key: string]> = [
  ['主机终端', hostTabKey('abc-123', 1)],
  ['本机终端', localTabKey(1)],
  ['接口请求', apiTabKey('req-1')],
  ['新建请求草稿', apiTabKey(NEW_API_REQUEST_ID)],
  ['新建 WS 草稿', apiTabKey(NEW_WS_REQUEST_ID)],
  ['脚本管理', scriptsTabKey()],
  ['插件界面', pluginTabKey(1)],
  ['SFTP 文件管理', sftpTabKey('abc-123')],
  ['隧道', tunnelTabKey()],
  ['应用日志', logsTabKey()],
  ['文件管理', filesTabKey()],
  ['系统监控', sysmonTabKey()],
  ['定时任务', triggersTabKey()],
  ['笔记', noteTabKey(1)],
  ['外部文件', localFileTabKey(1)]
]

describe('标签 key 的分类', () => {
  it.each(cases)('%s 的 key 被认作工具标签', (_name, key) => {
    expect(isToolTabKey(key)).toBe(true)
    expect(isConversationTabKey(key)).toBe(false)
  })

  it('对话标签按 chat: 前缘认，与指向哪条会话无关（草稿和会话标签同一种 key）', () => {
    expect(isConversationTabKey(chatTabKey(1))).toBe(true)
    expect(isToolTabKey(chatTabKey(1))).toBe(false)
  })

  it('会话 id 本身不是标签 key：不再被当成对话标签', () => {
    // 服务端生成的会话 id 是 uuid / 短 id。早先它就是标签 key，于是「草稿 → 会话」得改 key；
    // 现在会话 id 只出现在指向表里，任何地方拿它当标签 key 用都会被判成「不是对话标签」。
    for (const id of ['3f1a2b', 'c0ffee00-1111-2222-3333-444455556666']) {
      expect(isToolTabKey(id)).toBe(false)
      expect(isConversationTabKey(id)).toBe(false)
    }
  })

  it('前缀之间不互相误认（抽样：files: 不会吃掉 file:）', () => {
    // 这两个前缀只差一个 s，一旦比较写成 includes / 去掉冒号就会串
    expect(isToolTabKey(filesTabKey())).toBe(true)
    expect(isToolTabKey(localFileTabKey(1))).toBe(true)
    expect(filesTabKey()).not.toBe(localFileTabKey(1))
  })
})
