/**
 * 「回滚」的判据与文案（从 GitPanel.tsx 抽出，**纯函数、零 React 依赖**）。
 *
 * 独立成文件的理由：这是全文件里唯一值得单测的部分 —— 五种回退形态各有各的后果
 * （有的只丢工作区改动，有的**直接删文件**），而文案写错的代价是用户误删东西。
 * 主组件只负责把它算出来的结果塞进 AlertDialog。
 */
import type { GitChange } from '@fizz/git'
import { t } from '@fizz/i18n'

/**
 * 一次「回退」到底意味着什么（决定发给服务端的 mode，以及确认框的文案）：
 * - `untracked`：git 完全不认识的新文件 → 从磁盘删掉；
 * - `added`：只存在于暂存区、HEAD 里没有的新文件 → 索引和磁盘一起删（实测就是删），
 *   ⚠️ 这两种**会丢文件**，文案必须写明，不能只说「回到上次提交」；
 * - `staged`：已跟踪文件、有已暂存的改动 → 索引 + 工作区一起回到 HEAD；
 * - `worktree`：已跟踪文件、只有未暂存的改动 → 只丢工作区那一份，已暂存的留着。
 */
export type RollbackKind = 'untracked' | 'added' | 'staged' | 'worktree'

/** 待确认的回退目标：文件行（单文件）或目录行（整棵子树）。
 *
 * 目录级回滚不复用单文件的 kind —— 一棵子树里的文件状态是混合的（有改、有新增、有未跟踪），
 * 由 `mode`（已暂存组 = all、更改组 = worktree）和 `changes` 现算后果。
 */
export type RollbackTarget =
  | { scope: 'file'; path: string; kind: RollbackKind }
  | { scope: 'dir'; path: string; changes: GitChange[]; staged: boolean }

/** 回退会不会把文件本身删掉（决定确认按钮是「删除文件」还是「放弃改动」） */
export function rollbackDeletes(kind: RollbackKind | undefined): boolean {
  return kind === 'untracked' || kind === 'added'
}

/** 回退确认框里那句「会发生什么」—— 含糊地说「确定吗」用户根本不知道会失去什么 */
export function rollbackWarning(kind: RollbackKind | undefined, path: string): string {
  if (kind === 'untracked') {
    return t('「{path}」还没有被 git 跟踪（新文件），回退会把它从磁盘上删除。此操作无法撤销。', { path })
  }
  if (kind === 'added') {
    return t('「{path}」还没提交过、只存在于暂存区，回退会把它从索引和磁盘上一并删除。此操作无法撤销。', { path })
  }
  if (kind === 'staged') {
    return t('「{path}」已暂存的那份改动、以及它之后在工作区里的改动都会丢掉，回到上次提交的状态。未提交的内容无法恢复。', { path })
  }
  return t('「{path}」未暂存的改动会丢掉（回到已暂存 / 上次提交的状态）。未提交的内容无法恢复。', { path })
}

/** 这批文件里会被**删掉**的那几个（未跟踪 `?`；`all` 模式下「只存在于暂存区的新文件」`A` 也算） */
export function rollbackDeleteCount(changes: GitChange[], staged: boolean): number {
  return changes.filter((c) => (staged ? c.index === 'A' || c.index === '?' : c.index === '?')).length
}

/** 目录级回滚的确认文案：说清涉及几个文件、有几个会被直接删掉 */
export function dirRollbackWarning(target: { path: string; changes: GitChange[]; staged: boolean }): string {
  const deletes = rollbackDeleteCount(target.changes, target.staged)
  const base = target.staged
    ? t('「{path}」里这 {count} 个文件已暂存的那份改动、以及它之后在工作区里的改动都会丢掉，回到上次提交的状态。', { path: target.path, count: target.changes.length })
    : t('「{path}」里这 {count} 个文件未暂存的改动都会丢掉，回到已暂存 / 上次提交的状态。', { path: target.path, count: target.changes.length })
  const extra =
    deletes > 0
      ? deletes === target.changes.length
        ? t('它们全都没被 git 跟踪，会**直接从磁盘上删除**。')
        : t('其中 {count} 个还没被 git 跟踪，会**直接从磁盘上删除**。', { count: deletes })
      : ''
  return `${base}${extra}${t('此操作无法撤销。')}`
}

/** 确认框的标题 / 确认按钮 / 说明（文件与目录两种目标各写各的，别在 JSX 里堆三元） */
export function rollbackDialogTitle(target: RollbackTarget | null): string {
  if (!target) return ''
  if (target.scope === 'dir') return t('回滚「{path}」里的改动？', { path: target.path })
  return rollbackDeletes(target.kind) ? t('删除这个文件？') : t('放弃这个文件的改动？')
}

export function rollbackDialogAction(target: RollbackTarget | null): string {
  if (!target) return t('回滚')
  if (target.scope === 'dir') return t('回滚这个目录')
  return rollbackDeletes(target.kind) ? t('删除文件') : t('放弃改动')
}

export function rollbackDialogDescription(target: RollbackTarget | null): string {
  if (!target) return ''
  if (target.scope === 'dir') return dirRollbackWarning(target)
  return rollbackWarning(target.kind, target.path)
}
