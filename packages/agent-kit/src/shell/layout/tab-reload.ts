"use client";

/**
 * 主区域标签的**「重新加载」**（标签右键菜单里的「刷新」）。
 *
 * ## 为什么是「代号」而不是「关掉再打开」
 *
 * 标签内容由 `PanelContentLayer` 平铺渲染，内容宿主恒定挂在 `PanelView` 根部（见那里
 * 「为什么不在组里渲染」那段）。刷新要做的**只有一件事**：让这一个标签的内容**重新挂载**
 * —— 会话重新拉消息、接口页重新发请求、插件面重新 `render()`。走「关掉再打开」那条路会
 * 牵动 `tabOwners` / 落位缓存 / 「当前会话」对齐（面板越权把当前会话切走），副作用一大片，
 * 而且活动标签会跳。
 *
 * 于是这里只存一个**代号**（代号变了 = 内容宿主换 key = React 卸载重挂），别的什么都不碰。
 *
 * ## 刷新要**先问标签自己**（`requestReloadTab`）
 *
 * 重挂 = 卸载重来，破坏性与关闭同级：终端里正在跑的进程会一起结束、接口页草稿会丢、
 * 对话标签的右侧面板现场会重建。所以对外只暴露 `requestReloadTab` —— 它先问
 * `tab-close.ts` 的 `beforeReload` 守卫，放行才真的 `reloadTabContent`。
 * **别在 UI 里直接调 `reloadTabContent`**（那正是「刷新按钮静默杀掉终端」的老写法）。
 *
 * ## 为什么不放 `panel-store`
 *
 * 它**不是**面板状态的一部分：布局树里没有它、关闭标签的守卫也不该看它，重启后更不该
 * 记得「哪个标签被刷过」。它只是「强制重挂」的开关，单独一个模块级 map 就够
 * （做法与 `lib/panel-bodies.ts` 一致）。
 */
import { useSyncExternalStore } from 'react'
import { askTabReloadGuard } from '@fizz/agent-kit/shared/lib/tab-close'

/** `标签 key → 代号`。只存被刷过的标签，没刷过的读 0（map 里不必有条目） */
const gens = new Map<string, number>()

const listeners = new Set<() => void>()

/**
 * ⚠️ 必须**缓存**的快照值：`useSyncExternalStore` 每次比较都读它，返回新建对象会判定成
 * 「一直在变」→ 无限重渲染。所以这里只递增一个数字，`0` 是唯一常量。
 */
let version = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getVersion(): number {
  return version
}

/** 该标签当前的代号（没刷过 = 0） */
export function tabReloadGen(key: string): number {
  return gens.get(key) ?? 0
}

/** 代号变更的订阅（内容层用它把代号读进渲染） */
export function subscribeTabReloads(listener: () => void): () => void {
  return subscribe(listener)
}

export function tabReloadsVersion(): number {
  return getVersion()
}

/**
 * 用户点「刷新」走的就是这条路：**先问这个标签的守卫**，放行才真的重挂内容。
 *
 * 返回 `Promise<void>`（不是布尔）：调用方（标签上那颗钮）不关心结果 —— 守卫拦下时它
 * 自己会弹确认，用户答「取消」在这里就静默结束了。`void` 掉即可。
 */
export async function requestReloadTab(key: string): Promise<void> {
  if (!(await askTabReloadGuard(key))) return
  reloadTabContent(key)
}

/** 刷新某个标签：代号 +1，订阅者重渲染，内容宿主换 key 重挂 */
export function reloadTabContent(key: string): void {
  gens.set(key, (gens.get(key) ?? 0) + 1)
  version += 1
  for (const listener of listeners) listener()
}

/**
 * 回收已关闭标签的代号（关标签的路径不止一条 —— 标签上的 ×、右键的一批关闭、`alignToTabs`
 * 的对齐 —— 由 `PanelView` 的兜底 effect 集中做一次，与 `pruneToolTabs` 同款理由）。
 *
 * 标签 key 是终生不变的身份（`panel-tabs.ts`），所以代号跟着 key 走就够了：草稿标签
 * 变成会话标签时 key 不变，代号原地不动，不需要任何「交接」。
 */
export function pruneTabReloads(openKeys: readonly string[]): void {
  if (gens.size === 0) return
  const keep = new Set(openKeys)
  for (const key of [...gens.keys()]) {
    if (!keep.has(key)) gens.delete(key)
  }
}