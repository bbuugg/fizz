/**
 * 工具结果的文本像不像 markdown（ACP 的 text 内容块据此选渲染方式）。
 *
 * ACP agent 经常把结果写成 markdown 塞进 text 内容块（最典型的是 ```diff 围栏），
 * 但也有 agent 直接把原始终端输出塞进去。后者按 markdown 排版会把缩进、ASCII 表格、
 * 单换行吃掉（列表项被合并成一段），所以判定**刻意保守**，只认三种强信号：
 *
 * - **围栏代码块**：行首（至多 3 空格）三个以上的 ``` 或 ~~~；
 * - **首行是 ATX 标题**：首个非空行是 `# 标题`。只看首行 —— 日志中间一行 `# 注释`
 *   不该把整段日志变成 markdown；
 * - **列表块**：**连续两行**列表项（`- ` / `* ` / `+ ` / `1. `），且这一块要么是
 *   全文开头、要么前面隔着一个空行。单行常是输出里的普通文本；不加空行约束的话，
 *   没套围栏的原生 diff（连续多行 `- 旧内容`）会被误当成列表。
 *
 * 只用于「整段都是给人看的 display 文本」——命令的 rawOutput 不走这里。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false
  // 围栏：任意位置出现即命中（``` 开头/收尾都算，配对与否不在这里校验）
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(text)) return true
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? ''
  if (/^ {0,3}#{1,6}[ \t]+\S/.test(firstLine)) return true
  return /(?:^|\r?\n\r?\n) {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+\S.*\r?\n {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+\S/.test(
    text
  )
}