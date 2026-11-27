/**
 * 主区域标签的**守卫注册表**（通用「关掉 / 刷新这个标签之前先问一句」机制）。
 *
 * ## 两个钩子，一份登记表
 *
 * - `beforeClose`：用户主动关闭（标签上的 ×、右键的关闭一族、关闭整个组）之前问。
 * - `beforeReload`：用户点标签右键菜单里的「刷新」（`tab-reload.ts`，内容卸载重挂）之前问。
 *
 * 两者**同住一份登记表**，是因为判据本来就是同一批东西 —— 终端里还活着的进程、未保存的
 * 草稿、这个标签的面板现场，关闭与重挂都会把它们毁掉，差别只在文案。分成两张表的话同一个
 * 组件要写两遍登记 / 注销，迟早只补一边（「刷新按钮直接把正在跑的终端杀掉」就是这么来的）。
 *
 * ## 三条纪律
 *
 * 1. **只有「用户主动」走守卫**。`PanelView` 的 × / 右键关闭 / 关闭整个组 / 右键「刷新」
 *    会经过这里；而 `alignToTabs` 摘标签、会话被删后的 `closeTabs`，以及 `ApiPage` /
 *    `WsPage` 保存草稿后的 `closeTab(apiTabKey(NEW_*))`（草稿提升为真实标签）都走**裸关闭**，
 *    不弹任何窗。否则「切走再切回来」这类程序性动作会被自己的确认框挡住。
 * 2. **批量关闭逐个顺序确认**：一次只有一个弹窗；某个答「取消」→ 只把它留着，
 *    继续问下一个（同 VS Code 关多个编辑器）。
 * 3. **登记方是标签内容组件**。主区域所有标签**常挂载**（内容层平铺渲染、非活动标签
 *    `hidden` 而非卸载，见 `PanelView.tsx` 的内容层文件头），所以每个标签的内容组件都能
 *    在 `useEffect` 里为自己的 key 登记守卫，关掉即注销。
 *
 * ## 为什么是模块级 Map（不用 Context）
 *
 * 与 `tool-tabs.ts` / `panel-store.ts` 同一条口径：读它的只有 `PanelView` 这条关闭 / 刷新
 * 链路，而登记方散在各个特征组件里、彼此没有父子关系，套 Context 得把 Provider 提到很外层。
 * 它也不参与渲染（守卫只在**命令式关闭 / 刷新**时被 await），所以连订阅都不需要。
 *
 * （文件名与 `registerTabCloseGuard` 这个名字是历史原因：先只有关闭，刷新是后加的。
 * 新增标签类型时**两个钩子一起想**，别只登记关闭。）
 */

/** 守卫对「关闭这个标签」的答复：放行 / 拦下 */
export type TabCloseDecision = 'close' | 'cancel'

/** 守卫对「重新加载这个标签」的答复：放行 / 拦下 */
export type TabReloadDecision = 'reload' | 'cancel'

export interface TabCloseGuard {
  /**
   * 该标签此刻能不能关。
   *
   * 可以直接判（如「终端进程还活着吗」），也可以自己弹确认 / 先做异步收尾
   * （停会话、保存）再答复 —— 返回 Promise 时，关闭链路会 await 它。
   */
  beforeClose: () => TabCloseDecision | Promise<TabCloseDecision>
  /**
   * 该标签此刻能不能**重新加载**（内容卸载重挂：终端重开、接口页重发请求、面板现场重建）。
   *
   * **不登记 = 直接放行**（绝大多数标签没有可丢的现场，重挂与重渲染没区别）。
   * 与 `beforeClose` 同款：可以直接判，也可以自己弹确认再答复。
   */
  beforeReload?: () => TabReloadDecision | Promise<TabReloadDecision>
}

const guards = new Map<string, TabCloseGuard>()

/**
 * 为一个标签登记守卫（关闭 / 刷新两个钩子都在这一个对象里），返回注销函数
 * （在标签内容组件的 `useEffect` 里返回它）。
 *
 * 同一 key 重复登记会**覆盖**（一个标签只该有一个守卫；标签内容组件常挂载，
 * 未卸载前不会再登记第二个）。
 */
export function registerTabCloseGuard(key: string, guard: TabCloseGuard): () => void {
  guards.set(key, guard)
  return () => {
    if (guards.get(key) === guard) guards.delete(key)
  }
}

/**
 * 逐个问这批标签的守卫，返回**允许关闭**的键（保序）。
 *
 * - 没有守卫的键 → 直接放行（绝大多数标签零成本）。
 * - 守卫抛错 → 视为 `cancel` 并 `console.warn`：宁可留着，也不能把用户没答复的东西关掉。
 *
 * 调用方（`panel-store` 的 `requestClose*`）负责在 await 之后再过滤一次现存标签 ——
 * 弹窗期间标签可能已被拖走 / 被外部对表摘掉。
 */
export async function askTabCloseGuards(keys: readonly string[]): Promise<string[]> {
  const approved: string[] = []
  for (const key of keys) {
    const guard = guards.get(key)
    if (!guard) {
      approved.push(key)
      continue
    }
    let decision: TabCloseDecision = 'cancel'
    try {
      decision = await guard.beforeClose()
    } catch (err) {
      console.warn(`[tab-close] 标签「${key}」的关闭守卫抛错，按「取消关闭」处理`, err)
      decision = 'cancel'
    }
    if (decision === 'close') approved.push(key)
  }
  return approved
}

/**
 * 问某个标签能不能**重新加载**（返回 `true` = 放行）。
 *
 * 判据与 `askTabCloseGuards` 同一套：没登记 / 没写 `beforeReload` → 放行；守卫抛错 →
 * 视为 `cancel` 并 `console.warn`：宁可留着，也不能把用户没答复的东西重挂掉。
 *
 * 一次只问一个标签（右键菜单的「刷新」只作用于点开它的那颗标签，没有批量路径），
 * 所以没有对应的批量版本。
 */
export async function askTabReloadGuard(key: string): Promise<boolean> {
  const guard = guards.get(key)
  if (!guard?.beforeReload) return true
  try {
    return (await guard.beforeReload()) === 'reload'
  } catch (err) {
    console.warn(`[tab-close] 标签「${key}」的刷新守卫抛错，按「不刷新」处理`, err)
    return false
  }
}

/** 清掉所有登记（仅测试 / 调试用；正常运行靠组件卸载逐个注销） */
export function clearTabCloseGuards(): void {
  guards.clear()
}