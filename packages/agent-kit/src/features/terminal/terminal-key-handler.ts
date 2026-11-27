/**
 * 终端按键接管（`attachCustomKeyEventHandler`）：Ctrl+C、Ctrl+±/0 缩放、退出后回车重开。
 *
 * 从 `TerminalPanel` 的主 effect 里搬出来，理由只有一个：这段是**终端里最容易被误解的
 * 一段判断**（Ctrl+C 有三道闸、Ctrl+滚轮还要绕过浏览器页面缩放），埋在 800 行的建会话
 * effect 里，改任何一条都得先读几十行无关代码。
 *
 * 依赖全部显式传入（ref 由调用方持有），所以这里没有对组件状态的隐式捕获 ——
 * 判断顺序也就是读代码的顺序。
 */
import type { Terminal } from '@xterm/xterm'
import type { TerminalProcess } from '@fizz/agent-client/web-host'
import type { InputLine } from '@fizz/agent-kit/shared/lib/terminal-prediction'
import { writeClipboard } from '@fizz/agent-kit/shared/lib/clipboard'
import type { ZmodemController } from './zmodem-controller'

export interface TerminalKeyHandlerOptions {
  term: Terminal
  /** 会话已退出（xterm 的按键闭包只随会话重建一次，所以必须走 ref） */
  exitedRef: { current: boolean }
  /** 退出后按回车：重开一条会话 */
  restart: () => void
  processRef: { current: TerminalProcess | null }
  /** ZMODEM 控制器：传输中 / 排水期内 Ctrl+C 要变成「中止传输」 */
  zmodemRef: { current: ZmodemController | null }
  fontSizeRef: { current: number }
  /** 本地跟踪的命令行（判断「用户这 1.2s 里有没有又敲字」，见 Ctrl+C 的延时兜底） */
  inputBufRef: { current: InputLine }
  applyFontSize: (size: number) => void
  /** Ctrl+0：回到当前环境的缺省字号 */
  resetFontSize: () => void
  /** Ctrl+C 中断后缓冲与 shell 对不上，要清掉跟踪状态 */
  clearInputTracking: () => void
}

/**
 * 装上按键接管。**不需要卸载**：处理器挂在 xterm 实例上，实例 dispose 时一起没。
 */
export function attachTerminalKeyHandler(options: TerminalKeyHandlerOptions): void {
  const {
    term,
    exitedRef,
    restart,
    processRef,
    zmodemRef,
    fontSizeRef,
    inputBufRef,
    applyFontSize,
    resetFontSize,
    clearInputTracking
  } = options

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    // 终端已退出：按回车 = 重新打开一条（按键不再往 PTY 写，shell 已经没了）
    if (
      exitedRef.current &&
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      restart()
      return false
    }
    // Ctrl/Cmd（+Shift）组合键接管；Alt 组合留给 shell，纯键盘（无修饰）也放行。
    // 排除「同时带 Ctrl 与 Meta」的异常组合，避免吞键。
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) return true
    // Ctrl/Cmd + +/-/0：缩放终端字号（与 contracts 的 `terminalFontSize` 约定一致）。
    // 必须放在 shiftKey 判定之前：Ctrl/Cmd+Shift+= 的 key 是 '+'，否则会被放行成普通输入。
    // 显式 preventDefault 掉浏览器默认的页面缩放（xterm 返回 false 只阻止按键发往 PTY，
    // 不会替我们拦浏览器的默认行为），否则会直接走到页面缩放。
    if (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0') {
      event.preventDefault()
      if (event.key === '0') resetFontSize()
      else applyFontSize(fontSizeRef.current + (event.key === '-' ? -1 : 1))
      return false
    }
    // 以下仅 Ctrl（不带 Meta）：Cmd 组合交给浏览器原生（如 Mac 的 Cmd+C 复制 / Cmd+W 关闭）。
    if (event.metaKey) return true
    const key = event.key.toLowerCase()
    if (event.shiftKey) return true
    if (key === 'c') {
      // ZMODEM 传输中 / 异常结束后的排水期内：Ctrl+C = 取消传输（发 \x03 会被远端当成
      // 协议数据，传输直接烂）。⚠️ 排水期也要拦：会话被异常清空后控制器里已经没有会话，
      // 但远端可能还在猛发字节 —— 此时 Ctrl+C 必须仍是「中止」（见 `interrupt()` 的注释）。
      if (zmodemRef.current?.interrupt()) return false
      if (term.hasSelection()) {
        void writeClipboard(term.getSelection()).catch(() => {})
      } else {
        // SIGINT：shell 当场清行。本地跟踪缓冲也得跟着清，否则缓冲里还留着
        // 中断前敲了一半的命令，下一条命令的预测 / 历史记录都会串上前缀
        processRef.current?.write('\x03')
        clearInputTracking()
        /**
         * 视口拉回底部 —— **这一步不能省**。
         *
         * xterm 的 `scrollOnUserInput`（默认开）只在**它自己**收到输入时生效：
         * `_keyDown` 里先问自定义处理器，返回 false 就 `return` 了，后面那句
         * 「滚到底部」根本走不到；而我们是直写 PTY（`processRef.write('\x03')`），
         * 也没经过它的 data 事件。于是「滚上去看历史 → 按 Ctrl+C」的表现是：
         * 底部的提示符照常刷新，视角却留在上面 —— 用户以为 Ctrl+C 没生效。
         *
         * 只在**中断**这一支滚：有选区时那一下是「复制」，正在读历史的人不该被拽下来。
         */
        term.scrollToBottom()
        /*
         * ⚠️ Ctrl+C 也不能只发 `\x03`：那是「请中断」，程序可以自己捕获后继续跑
         * （`npx vite` / 各种 watch 模式都会吞掉 SIGINT 只做热重启），用户看到的
         * 就是「Ctrl+C 按烂了也停不下来」。1.2s 后如果进程还在，走引擎的**强停**。
         *
         * ⚠️ 强停的边界是「前台那条命令」，**不是终端**：引擎侧（`agent-host/pty.ts` 与
         * 服务端 `terminal/pty.ts`）只在**确实存在前台作业**时才动手，拿不到前台作业
         * （停在提示符上 / Windows / 容器）就什么都不做。曾经桌面端直接 `taskkill /T /F`
         * 整棵树、服务端探不到就退回整树杀 —— 用户按几次 Ctrl+C 整条本地终端就断开了。
         *
         * ⚠️ SSH 通道**不实现 `stop`**（`TerminalProcess.stop?` 可选），所以这条延时兜底
         * 在那条通道上根本不会挂：它以前是「再补发 `\x03` / `\x1c`」，等于替用户又按一次
         * Ctrl+C —— 命令早退出了，1.2s 后那记 `\x03` 落在提示符上又回显一个 `^C`
         * （用户报过「按一次 Ctrl+C，过一会终端里又出现 `^C`」）。
         *
         * 判据用「终端有没有重新出现提示符」太脆（自定义 PS1、多行提示符都会误判），
         * 所以这里只做**延时兜底**：真停了则无事发生（前台组已经空了）。
         */
        const proc = processRef.current
        if (proc?.stop) {
          window.setTimeout(() => {
            // 这期间用户可能已经又敲了新命令：只在「没有新输入」时才补这一刀
            if (inputBufRef.current.text.length > 0) return
            proc.stop?.()
          }, 1200)
        }
      }
      return false
    }
    return true
  })
}
