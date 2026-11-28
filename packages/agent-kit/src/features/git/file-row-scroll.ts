/** 切换行内 diff 时，以这次点击的文件行为锚点，而不是保留会随内容缩短失效的 scrollTop。 */
export interface FileRowScrollAnchor {
  container: HTMLElement
  row: HTMLElement
  top: number
}

export function captureFileRowScroll(row: HTMLElement): FileRowScrollAnchor | null {
  const container = row.closest<HTMLElement>('[data-git-scroll]')
  if (!container) return null
  return {
    container,
    row,
    top: row.getBoundingClientRect().top - container.getBoundingClientRect().top
  }
}

export function restoreFileRowScroll(anchor: FileRowScrollAnchor | null): void {
  if (!anchor || !anchor.row.isConnected || !anchor.container.contains(anchor.row)) return
  const top = anchor.row.getBoundingClientRect().top - anchor.container.getBoundingClientRect().top
  const delta = top - anchor.top
  if (delta) anchor.container.scrollTop += delta
}
