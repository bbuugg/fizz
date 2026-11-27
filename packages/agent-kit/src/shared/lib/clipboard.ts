/**
 * 写系统剪贴板的统一入口。
 *
 * `navigator.clipboard` **只在安全上下文**（https / localhost）里存在：自托管用
 * `http://192.168.x.x` 打开 web 端时它整个是 `undefined`，直接调 `.writeText`
 * 会抛 `TypeError: Cannot read properties of undefined (reading 'writeText')`。
 * 这里退回隐藏 textarea + `execCommand('copy')`（同步执行，仍在用户点击的手势栈里）。
 */

/** 退路：选中一个隐藏 textarea 再让浏览器复制。同步执行，必须在用户手势里调用。 */
function copyWithExecCommand(text: string): void {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('clipboard unavailable')
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // 固定在视口左上角再藏起来：不进布局、也不会把页面滚到底
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.width = '1px'
  area.style.height = '1px'
  area.style.padding = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    area.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('clipboard unavailable')
  } finally {
    document.body.removeChild(area)
  }
}

export async function writeClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return
    } catch {
      // 权限被拒 / 文档失焦：还有退路，别直接失败
    }
  }
  copyWithExecCommand(text)
}