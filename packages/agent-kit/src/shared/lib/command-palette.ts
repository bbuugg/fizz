/**
 * 「打开命令面板」的请求通道。
 *
 * 为什么需要它：面板的开关是外壳的 state（`app-shell` 的 `paletteOpen`），而想开它的地方
 * （工作区下拉底部那条「新建工作区」）深在对话面板里，中间隔着七八层。把 `onOpen` 一层层
 * 打洞下去，每个中间组件都得多接一个与自己无关的 prop，而且这些组件的 props 是公开契约。
 *
 * 机制只是一个**函数引用**：外壳在渲染期把自己的 `openPalette` 登记进来，别处调
 * `requestCommandPalette()`。没有订阅、没有额外重渲染 —— 面板开关本来就只有外壳那一处 state。
 * 仓库里同类先例：`tool-tabs.ts`（模块级登记表）、`shortcuts.ts` 的录制开关。
 */

/** 打开时落在哪一页。`root` = 常规的命令列表 */
export type CommandPaletteEntry = 'root' | 'new-workspace'

let opener: ((entry: CommandPaletteEntry) => void) | null = null

/**
 * 外壳登记「怎么开面板」。渲染期直接调用即可（幂等，每次渲染换成最新闭包）；
 * 卸载时传 `null` 清掉，免得留着一个指向已卸载组件的 setter。
 */
export function setCommandPaletteOpener(fn: ((entry: CommandPaletteEntry) => void) | null): void {
  opener = fn
}

/** 请外壳打开命令面板；`entry` 不是 `root` 时打开后直接停在那一页 */
export function requestCommandPalette(entry: CommandPaletteEntry = 'root'): void {
  opener?.(entry)
}
