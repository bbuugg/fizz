/**
 * 停用插件的声明 → **只留图标**。
 *
 * ## 这条规则在防什么
 *
 * 插件的图标是 `ctx.ui.icon(dataUri)` **命令式**声明的，盘上没有任何静态副本
 * （`plugin.json` 里没有 icon 字段），只能靠跑一遍 `apply` 拿到。所以「只给启用的插件
 * inspect」就必然导致停用后图标消失 —— 用户看到的是「禁用它，图标就换成了统一占位图」，
 * 像是停用把插件弄坏了。
 *
 * 于是列表装配会**额外 inspect 一遍停用插件**，但只取图标：设置项 / 面板 / 界面面 /
 * 上传源都是「这个插件给了我什么能力」，停用就不该成立（否则会出现「已经停用了还能配置、
 * 还能在附件菜单里选它的上传源」）。**别为了方便把 settings 一起带出来** —— 那会让
 * 「停用」在界面上半真半假。它的加载报错同样丢弃：用户已经把它停了，再飘一条
 * 「某某插件没通过校验」只会让人以为是自己刚才那一下弄坏的。
 *
 * 纯函数、零运行时依赖（只 import type），所以能被单测直接覆盖。
 */
import type { PluginUiDeclaration } from '@fizz/plugin'

export function iconOnlyUi(
  ui: Record<string, PluginUiDeclaration>
): Record<string, PluginUiDeclaration> {
  const out: Record<string, PluginUiDeclaration> = {}
  for (const [pluginId, decl] of Object.entries(ui)) {
    // 没声明图标的插件整条略过：留一条空声明只会让前端多一个「它有 ui」的假信号
    if (!decl.icon) continue
    out[pluginId] = { settings: [], panels: [], surfaces: [], icon: decl.icon }
  }
  return out
}
