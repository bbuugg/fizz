/**
 * 把一段语音识别结果插进输入框的**光标 / 选区**处。
 *
 * 纯函数、不碰 DOM —— Composer 从 textarea 读 selectionStart/End 传进来，拿到新的
 * value 与光标位置后再交给受控组件，由调用方恢复 selectionRange。
 *
 * 分隔符沿用原来的约定：左侧有内容且不以空白结尾时补一个空格（右侧紧跟文字时
 * 因此自然被隔开）。光标在开头不补；左侧本来就是空白（选区右边那种）也不重复补。
 */
export interface InsertTranscriptResult {
  value: string
  /** 插入后光标应该停的位置（识别文本之后） */
  caret: number
}

export function insertTranscript(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number = selectionStart
): InsertTranscriptResult {
  const len = value.length
  const clamp = (n: number): number =>
    Number.isFinite(n) ? Math.min(len, Math.max(0, Math.trunc(n))) : 0
  const a = clamp(selectionStart)
  const b = clamp(selectionEnd)
  const start = Math.min(a, b)
  const end = Math.max(a, b)

  if (!transcript) return { value, caret: start }

  const left = value.slice(0, start)
  const right = value.slice(end)
  const separator = left && !/\s$/.test(left) && !/^\s/.test(transcript) ? ' ' : ''
  return {
    value: `${left}${separator}${transcript}${right}`,
    caret: left.length + separator.length + transcript.length
  }
}
