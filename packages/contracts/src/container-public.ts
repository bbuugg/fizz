/**
 * 容器型项目的**公网访问域名**配置（全局一份，落 `CoreData.containerPublicSettings`）。
 *
 * ## 独立公网端口
 *
 * 公网入口是**独立的一个 HTTP 监听器**（`FIZZ_PUBLIC_HTTP_PORT`，默认 `0` = 不启用），
 * 挂在 `container-projects/public-gateway.ts`，与工作台各占一个端口。它只做一件事：
 * 认出 `Host` 是「配置域名下**正好一层**子域」且 slug 真有容器项目时，反代到该项目
 * 在宿主上映射的预览端口。
 *
 * ## 域名可以是多个
 *
 * 用户可以配多个泛解析域名（比如同时有 `fizz.example.cn` 与 `preview.foo.com`），
 * 每个域名下 `<slug>.<域名>` 都指向同一个项目。请求进来时**逐个域名匹配**，
 * 命中任意一个即为预览；一个都不命中 → **404，绝不回落到工作台**（独立端口上没有工作台，
 * 回落就等于把管理界面挂到公网）。
 *
 * ## 三道闸（缺一不可，见 `public-gateway.ts`）
 *
 * 1. 至少配了一个域名（本文件的 `domains`）；
 * 2. 公网入口端口**确实在监听**（`FIZZ_PUBLIC_HTTP_PORT` 配了且没被占用）；
 * 3. 请求的 `Host` 命中某个配置域名的一层子域，且 slug 真有项目。
 */

/** 域名的形状闸（服务端存盘前与 host 解析前都会过一遍）：`a.b.c`，只允许字母数字与 `-` */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * 收敛用户输入的域名：去空白、去 `*.` 前缀、去结尾的点、转小写；不合法返回 `''`。
 *
 * 接受两种写法（用户从 DNS 面板直接复制粘贴的心智）：
 * - `xxx.fizz.agent.cn`；
 * - `*.fizz.agent.cn`。
 *
 * ⚠️ 必须至少两段（`example.com` 这种），且不含协议 / 端口 / 路径 —— 这里不做「猜」，
 * 猜错了就是把别人的域名当成自己的泛解析。
 */
export function normalizePublicDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  let domain = value.trim().toLowerCase()
  // 用户从浏览器地址栏复制的会带协议
  domain = domain.replace(/^[a-z]+:\/\//, '')
  // 只留 host 部分（`/path`、`:port` 都不属于域名）
  domain = domain.split('/')[0]!.split(':')[0]!
  domain = domain.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '')
  if (domain.length > 253) return ''
  return DOMAIN_RE.test(domain) ? domain : ''
}

/** 公网访问域名设置（全局一份） */
export interface ContainerPublicSettings {
  /**
   * 泛解析域名清单（`<slug>.<域名>`）。空数组 = 公网访问关闭。
   *
   * slug 由服务端在创建时分配（`root.ts` 的 `uniqueSlug`），用户改不了 —— 所以这里只配
   * 「后半截」，前面那截天然就是「每个项目一个」。多个域名时请求逐个匹配，命中即为预览。
   */
  domains: string[]
}

export const DEFAULT_CONTAINER_PUBLIC_SETTINGS: ContainerPublicSettings = {
  domains: []
}

/** 收敛一份域名清单：逐个归一化，丢掉空值 / 重复项 */
function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const domain = normalizePublicDomain(item)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    out.push(domain)
  }
  return out
}

/** 收敛：手改坏的数据文件 / 缺字段都不该让读接口抛错（同 `normalizeSystemMonitorSettings`）。 */
export function normalizeContainerPublicSettings(value: unknown): ContainerPublicSettings {
  const raw = value as { domains?: unknown } | undefined
  return { domains: normalizeDomainList(raw?.domains) }
}

/**
 * 域名解析提示的**目标**（展示用）：把 `*.<domain>` 指到这台机器。
 *
 * 只给文案用，不参与任何判定 —— 判定看的是 `Host` 头（见 server 侧 `parsePublicHost`）。
 */
export function wildcardOf(domain: string): string {
  return domain ? `*.${domain}` : ''
}
