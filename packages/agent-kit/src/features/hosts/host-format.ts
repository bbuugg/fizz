import type { HostConfig, SshHostConfig } from '@fizz/contracts/types'
import { t } from '@fizz/i18n'

/**
 * 一台主机的标准摘要 `user@host:port`。
 *
 * 主机清单行、标签悬停提示、跳板机下拉、删除确认文案四处都用它 —— 分开写迟早会
 * 有一处漏掉端口或用户名，看着像「同一台机器有两副样子」。
 *
 * ⚠️ 字段缺失时**降级成能显示的那部分**（`host:port` / `user@host`），不拼 `undefined`：
 * 数据文件里可能躺着本版本不认识的主机 —— 例如别的版本写进去的 `kind: 'vnc'`，
 * 服务端 `toHostView` 会原样透传，那条记录没有 `username`。这不是崩的理由。
 */
export function hostSummary(host: SshHostConfig): string {
  const user = host.username ? `${host.username}@` : ''
  const port = host.port ? `:${host.port}` : ''
  return `${user}${host.host ?? ''}${port}`
}

/** 命令面板里一条主机要用的展示字段（见 `hostPaletteFields`） */
export interface HostPaletteFields {
  /** 主标题；`name` 缺失时用地址 / shell 名兜底，绝不把 undefined 交给 JSX */
  label: string
  /** 副标题：本机终端 = shell 名（+ 参数个数）；SSH = `user@host:port` */
  subtitle: string
  /** 参与 cmdk 本地过滤的关键词：**保证全是非空字符串** */
  keywords: string[]
}

/**
 * 解析表单里「保活（秒）」输入框的文本：空串 / 非法数字 = undefined（提交时不带这个字段）。
 *
 * ⚠️ 返回的 **0 必须原样带出**：0 是「关闭保活」的合法取值，而提交时省略
 * `keepaliveInterval` 在服务端语义是「保留上一次的值」（`input.x ?? prev.x`）。
 * 用真值判断（`if (value)`）会把 0 当成没填，用户改成 0 保存后再编辑又变回旧值。
 */
export function parseKeepaliveInput(raw: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** SSH 默认端口（表单 placeholder 与服务端 `normalizeSshPort` 同一口径） */
export const DEFAULT_SSH_PORT = 22

/**
 * 解析表单里「端口」输入框的文本：留空 / 非法 = 默认 22。
 *
 * 端口没有「关掉」的含义，留空就是回到默认端口（placeholder 也写着 22）。
 * 提交时**必须显式带 22**：省略在服务端是「保留上一次的值」，编辑时把端口清空
 * 就等于什么都没做，下次打开还是老端口。
 */
export function parsePortInput(raw: string): number {
  const text = raw.trim()
  if (!text) return DEFAULT_SSH_PORT
  const value = Number(text)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_SSH_PORT
}

/** 只留非空字符串 —— cmdk 会对 keywords 逐个 `.trim()`，混进 undefined 就是整块面板白屏 */
function textOnly(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

/**
 * 命令面板「主机」二级视图里一条主机的展示字段：主标题 / 副标题 / 搜索关键词。
 *
 * 抽成纯函数是为了能测 —— 这里的两个输入都来自**磁盘上的数据**，不是本版本写的，
 * 随时可能缺字段：`keywords` 里混进一个 undefined，cmdk 的
 * `keywords.map(k => k.trim())` 就会让整个命令面板白屏
 * （`Cannot read properties of undefined (reading 'trim')`），而「打开主机」正是
 * 渲染这一屏的入口，一崩就再也进不去主机列表。
 */
export function hostPaletteFields(host: HostConfig): HostPaletteFields {
  if (host.kind === 'local') {
    const shell = host.shellName?.trim() || t('默认终端')
    // 有参数就带上个数：同一个 shell 配两条不同参数的终端，光看 shell 名分不出来
    const subtitle = [shell, ...(host.args?.length ? [t('{n} 个参数', { n: host.args.length })] : [])].join(' · ')
    return {
      label: host.name?.trim() || shell,
      subtitle,
      keywords: textOnly(['terminal', '终端', '本机', host.name])
    }
  }
  // 其余一律按 SSH 主机渲染（`kind` 缺失 = 老数据，语义就是 ssh）
  const summary = hostSummary(host)
  return {
    label: host.name?.trim() || summary || t('未命名主机'),
    subtitle: summary || t('地址未填写'),
    keywords: textOnly(['ssh', '主机', host.name, host.host, host.username])
  }
}
