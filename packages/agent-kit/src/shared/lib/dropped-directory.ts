/**
 * 从一次 drop 里挑出「第一个被拖进来的**目录**」的本机绝对路径。
 *
 * ## 为什么需要它
 *
 * 工作区登记的是**跑 Agent 那台机器**上的真实路径，渲染端唯一能拿到它的通道是
 * `AgentHost.getPathForFile`（desktop 走 preload 里的 `webUtils`）。而 `dataTransfer`
 * 在一次事件处理结束之后就失效了 —— 所以路径必须**在 `drop` 里同步取完**，
 * 不能等 `await` 回来再读。
 *
 * ## 为什么先看 `webkitGetAsEntry`
 *
 * `dataTransfer.files` 里目录与文件长得一样（都没有 size / type），直接把文件拿去登记，
 * 服务端会回「目录不存在或不是目录」。`webkitGetAsEntry().isDirectory` 是渲染端唯一能
 * **同步**区分两者的接口。它返回 `null` 时不拦（有些环境给不出 entry），交给服务端那条
 * `stat` 兜底 —— 宁可多一次往返，也不要在能判的时候放过一个文件。
 */
export function firstDroppedDirectoryPath(
  dataTransfer: DataTransfer,
  getPath: (file: File) => string
): string | null {
  const files = Array.from(dataTransfer.files ?? [])
  const items = Array.from(dataTransfer.items ?? [])

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    if (!file) continue
    // 条目与 files 同序（同一次 drop 的文件列表），按下标配
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry && !entry.isDirectory) continue
    const path = getPath(file)
    // 取不到路径（不是真实 File / 宿主不认）：继续看下一个，别把这次 drop 判死
    if (path) return path
  }

  return null
}
