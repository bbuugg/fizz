/**
 * 主区域：现在只有**一套**内容 —— 多标签面板（`PanelView`）。
 *
 * 原来是「对话 / 流程」两块的分发点（视图状态存在 `shared/lib/view-state.ts`）。
 * 流程功能整个删除之后，主区域没有第二种形态，那个分发点也就没有存在的理由：
 *
 * - `view-state.ts`（`AppView` / `setActiveView` / `useActiveView`）**已删**；
 * - 每个入口原来都要在打开对象之后补一句 `setActiveView('chat')`，现在只剩「选中它」；
 * - 想加第二块主视图时，**先想清楚它是不是一个面板标签** —— 标签体系已经支持
 *   任意内容（终端 / 文件 / git / 接口 / 容器），再开一条「整页视图」的并行结构
 *   等于把标签条、面板现场、快捷键全部分叉一遍。
 *
 * 保留这个组件而不是直接在 `AppShell` 里写 `<PanelView />`：desktop / mobile 外壳
 * 都走同一个入口，多一层命名比各处各写一遍清楚。
 */
import { PanelView } from './layout/PanelView'

export function AppRoutes() {
  return <PanelView />
}
