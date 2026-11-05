/**
 * git 面板变更列表的树状**渲染**：目录行（可折叠、右侧操作位）+ 文件行回调。
 *
 * 建树逻辑在 `lib/git-change-tree.ts`（纯函数，可脱离 React 单独验证）；这里只管把节点画出来。
 *
 * 文件行与目录行的操作按钮都交给调用方渲染 —— 两组变更的按钮 / 状态码 / diff 都不同，
 * 塞在这里反而要往回调里塞一堆 props（见 `GitPanel` 的用法）。
 */
import { Fragment, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import type { GitChange } from '@fizz/git'
import {
  buildChangeTree,
  changeTreeIndent,
  type ChangeTreeDir,
  type ChangeTreeNode
} from '@fizz/agent-kit/shared/lib/git-change-tree'

/** 一棵渲染好的树（扁平输出，行序即屏幕上从上到下） */
function renderNodes(
  nodes: ChangeTreeNode[],
  collapsed: ReadonlySet<string>,
  onToggleDir: (path: string) => void,
  renderFile: (change: GitChange, depth: number) => ReactNode,
  renderDirActions?: (dir: ChangeTreeDir) => ReactNode
): ReactNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') {
      return <Fragment key={`f:${node.change.path}`}>{renderFile(node.change, node.depth)}</Fragment>
    }
    const isCollapsed = collapsed.has(node.path)
    return (
      <div key={`d:${node.path}`}>
        {/*
          目录行与文件行同一套骨架：整行一个 flex，左边是可横向滚动的「折叠 + 名字」，
          右边是操作按钮。缩进放在滚动内容里而不是整行上 —— 否则层级一深，右侧按钮也会
          跟着往右跑，不再固定。
        */}
        <div className="flex items-center gap-1.5 rounded py-1 pr-1.5 hover:bg-foreground/5">
          <div className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => onToggleDir(node.path)}
              title={node.path}
              style={changeTreeIndent(node.depth)}
              className="flex w-max min-w-full items-center gap-1.5 pr-2 text-left text-sm"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="whitespace-nowrap text-muted-foreground">{node.name}</span>
            </button>
          </div>
          {renderDirActions?.(node)}
        </div>
        {/* 折叠时连子树一起不渲染：省掉几十个节点的 DOM，也免得里面的 diff 偷偷展开着 */}
        {!isCollapsed &&
          renderNodes(node.children, collapsed, onToggleDir, renderFile, renderDirActions)}
      </div>
    )
  })
}

/**
 * 渲染一整组变更（树状）。两个分组各自传自己的 `changes` / `collapsed`，互不干扰。
 */
export function ChangeTreeList({
  changes,
  collapsed,
  onToggleDir,
  renderFile,
  renderDirActions
}: {
  changes: GitChange[]
  /** 折叠中的目录路径（调用方持有，这样刷新状态后展开态还在） */
  collapsed: ReadonlySet<string>
  onToggleDir: (path: string) => void
  /** 文件行：由调用方渲染（`depth` 是层级，用来缩进） */
  renderFile: (change: GitChange, depth: number) => ReactNode
  /**
   * 目录行右侧的操作按钮：由调用方渲染（暂存 / 回滚整棵子树 —— 按钮长得跟文件行一样，
   * 但语义与状态都在 `GitPanel` 里，塞进来这里只会多一层 props 传递）。
   * 不给就只渲染成原来的折叠加计数。
   */
  renderDirActions?: (dir: ChangeTreeDir) => ReactNode
}) {
  return (
    <>{renderNodes(buildChangeTree(changes), collapsed, onToggleDir, renderFile, renderDirActions)}</>
  )
}