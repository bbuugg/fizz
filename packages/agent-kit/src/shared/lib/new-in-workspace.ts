/**
 * 项目行上的几种「新建」：各自弹一个对应功能的弹窗（**会话不弹窗，直接落初始页**）。
 *
 * 刻意放在 `lib/`（而不是侧栏组件里）：它是**应用层**的概念 —— 侧栏、外壳、
 * `useAppContext` 的「新建弹窗目标」三处描述的是同一批入口（会话 / 工作区）。
 * 放在某个 feature 里会让 app 层反向依赖 feature。
 *
 * - `conversation` = 落到该项目的「创建新任务」页（不建会话，类型在模型下拉里选）
 * - `worktree` = 新建工作区（建目录 + 建分支）
 * - `worktree-load` = 管理工作区（把 `.worktree/` 下既有的目录导入成项目、以及移除已导入的）
 *
 * ⚠️ 曾经的 `trigger` 已删：定时任务改成主区域的全局管理面板（`triggers:list`），
 * 新建在面板里做、项目在表单里选 —— 入口按项目分散时就找不回来了。
 * ⚠️ 曾经的 `flow` 已删：流程功能整个移除。
 */
export type NewInWorkspaceKind =
  "conversation" | "worktree" | "worktree-load";
