/**
 * git 变更列表的**建树逻辑**（纯函数，无 React）：把 `a/b/c.ts` 这类扁平路径拼成目录树。
 *
 * 为什么自己拼而不是像「工作区文件」那样逐级问服务端：git status 已经把整棵树的改动一次性
 * 给了（`changes`），再按目录去问就是白跑 IO，还会在刷新时一屏 spinner。
 *
 * 独立成文件是为了能在不启 React 的前提下直接跑它验证（渲染在 `GitChangeTree.tsx`）。
 */
import type { CSSProperties } from 'react'
import type { GitChange } from '@fizz/git'
import { treeIndent } from './tree-indent'

/** 目录行：一棵子树，折叠状态下连同里面的文件一起收起 */
export interface ChangeTreeDir {
  kind: 'dir'
  name: string
  /** 目录路径（不含文件名，如 `packages/git/src`）；折叠状态按它索引 */
  path: string
  /**
   * 这棵子树里所有改动的文件（扁平，忽略层级）。
   * 目录行上的「暂存 / 回滚」要作用到整棵子树，故建树时顺手摊平，免得调用方再按前缀过滤一遍。
   */
  changes: GitChange[]
  depth: number
  children: ChangeTreeNode[]
}

/** 文件行：一个改动文件（重命名 / 复制的旧名由 `change.origPath` 带） */
export interface ChangeTreeFile {
  kind: 'file'
  name: string
  change: GitChange
  depth: number
}

export type ChangeTreeNode = ChangeTreeDir | ChangeTreeFile

/**
 * 某一层的左内边距。目录行与文件行共用它（`GitChangeTree.tsx` 与 `ChangeRow.tsx`），
 * 否则两边的层级会错开半格。
 *
 * 基准 20px = 分组标题的折叠箭头（`px-2` + 8px）再往里一档 12px：展开后的子项要看得出
 * 缩进在标题下面，又不至于挪到标题文字那一列去（那样窄面板里可用宽度太少）。步长 14px
 * 与文件树一致（层级越深越往里）；rem 表达让它跟着手机端的根字号一起放大。
 *
 * 缩进只作用在**行内按钮**上（背景挂在外层行），所以 hover 底色仍然铺满整行。
 *
 * 用行内 style 而不是拼接 className：那个 class 名是运行期算出来的，Tailwind 扫源码扫不到。
 */
export function changeTreeIndent(depth: number): CSSProperties {
  return { paddingLeft: treeIndent(depth, 14, 20) }
}

/** 排序用：目录排在文件前面（各自按名称排），数字当数字比，`2` 排在 `10` 前面 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 建树过程中的可变目录 */
interface MutableDir {
  name: string
  path: string
  dirs: Map<string, MutableDir>
  files: GitChange[]
}

function newDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: [] }
}

/**
 * 扁平改动列表 → 目录树。
 *
 * 只有文件路径会进树（git 不给空目录），所以不会出现「点开什么都没有」的目录节点；
 * 同名目录自动合并，不同分组各自调用（暂存 / 未暂存是两棵独立的树）。
 */
export function buildChangeTree(changes: GitChange[]): ChangeTreeNode[] {
  const root = newDir('', '')
  for (const change of changes) {
    const parts = change.path.split('/').filter(Boolean)
    // 理论上非空（path 至少一段）；真拿到空路径就跳过，别造出一个匿名根节点
    if (parts.length === 0) continue
    let cur = root
    let dirPath = ''
    for (const seg of parts.slice(0, -1)) {
      dirPath = dirPath ? `${dirPath}/${seg}` : seg
      let next = cur.dirs.get(seg)
      if (!next) {
        next = newDir(seg, dirPath)
        cur.dirs.set(seg, next)
      }
      cur = next
    }
    cur.files.push(change)
  }
  return toNodes(root, 0)
}

/**
 * 这组变更里所有目录的路径（父目录在前）。
 *
 * 「全部折叠 / 全部展开」要一次性覆盖整棵树 —— 树是渲染期现拼的，调用方手上只有扁平的
 * `changes`，所以这里顺手把目录路径也列出来。
 */
export function allChangeTreeDirPaths(changes: GitChange[]): string[] {
  const out: string[] = []
  const walk = (nodes: ChangeTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      out.push(node.path)
      walk(node.children)
    }
  }
  walk(buildChangeTree(changes))
  return out
}

function toNodes(dir: MutableDir, depth: number): ChangeTreeNode[] {
  const dirs: ChangeTreeNode[] = [...dir.dirs.values()].map((d) => {
    const children = toNodes(d, depth + 1)
    return {
      kind: 'dir',
      name: d.name,
      path: d.path,
      depth,
      children,
      changes: collectChanges(children)
    }
  })
  const files: ChangeTreeNode[] = dir.files.map((change) => ({
    kind: 'file',
    name: change.path.split('/').pop() ?? change.path,
    change,
    depth
  }))
  const byName = (a: { name: string }, b: { name: string }): number => collator.compare(a.name, b.name)
  dirs.sort(byName)
  files.sort(byName)
  return [...dirs, ...files]
}

/** 把子树里的文件摊平（目录行上的操作要作用到整棵子树） */
function collectChanges(nodes: ChangeTreeNode[]): GitChange[] {
  const out: GitChange[] = []
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node.change)
    else out.push(...node.changes)
  }
  return out
}