/**
 * 英文文案字典：key = 中文原文（中文本身就是默认文案，不另起 key）。
 *
 * 为什么用原文当 key：
 * - 新增文案时只写 `t('中文')`，不用先在字典里编一个 key、也不会出现 key 与文案漂移；
 * - 还没翻译的条目自动回落到中文，界面不会出现空白或 `missing.key`。
 *
 * 按模块拆分在 `./dict/*`：新增文案先找到对应模块文件，再往里面加。
 * 占位符用 `{name}`，由 `t()` 统一替换。
 */
import { COMMON } from './dict/common'
import { SETTINGS } from './dict/settings'
import { AGENT } from './dict/agent'
import { CHAT } from './dict/chat'
import { HOSTS } from './dict/hosts'
import { API } from './dict/api'
import { NOTES } from './dict/notes'
import { WORKSPACE } from './dict/workspace'

export const EN: Record<string, string> = {
  ...COMMON,
  ...SETTINGS,
  ...AGENT,
  ...CHAT,
  ...HOSTS,
  ...API,
  ...NOTES,
  ...WORKSPACE,
}
