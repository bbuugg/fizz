import type { PreviewKind } from '@fizz/agent-kit/shared/lib/preview'
import type { DiffHunk } from '@fizz/agent-kit/shared/lib/diff'
import type { ReactNode } from 'react'

/** 当前打开的文件标签及其编辑 / 预览状态。 */
export interface OpenTab {
  /** 文件路径，兼作标签 id */
  path: string
  kind: PreviewKind | null
  viewMode: 'preview' | 'edit'
  content: string
  /** 上次读入 / 保存的内容基线，与 `content` 不等即为「脏」 */
  savedContent: string
  loading: boolean
  saving: boolean
  mediaUrl: string | null
  mediaLoading: boolean
  error: string | null
}

/** Git diff 与文件共用预览标签条，但按暂存状态和路径保持独立身份。 */
export interface DiffTab {
  key: string
  path: string
  staged: boolean
  deleted: boolean
  hunks: DiffHunk[] | null
  /**
   * 上次读到的**原文**（`git diff` 的原始输出）。
   *
   * 只用于「内容有没有变」的比对：面板每几秒会轮询刷新一次 diff，原文一样时连 state
   * 都不动，整块 diff 就不会白重渲染（见 `FilesPanel` 的 `loadGitDiff`）。
   */
  diffText: string | null
  loading: boolean
  error: string | null
}

export interface ClipboardEntry {
  path: string
  type: 'file' | 'dir'
  name: string
}

export interface Clipboard {
  entries: ClipboardEntry[]
  mode: 'copy' | 'cut'
}

/** Shared action shape used by desktop context menus and the mobile action sheet. */
export interface MenuAction {
  label: string
  icon: ReactNode
  danger?: boolean
  disabled?: boolean
  run: () => void
}

export interface NameDialogText {
  title: string
  description: string
  placeholder: string
  confirm: string
  busy: string
}
