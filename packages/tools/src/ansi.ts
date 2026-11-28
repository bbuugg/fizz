/**
 * 命令输出里的 ANSI 转义序列清洗。
 *
 * ## 为什么需要
 *
 * 子进程的输出是**终端字节流**：颜色（`\u001b[32m➜\u001b[39m`）、加粗、清行、光标显隐、
 * 超链接（OSC 8）全在里面。这些字节只在真终端上有意义，落到两个地方就是纯噪音：
 *
 * 1. **工具结果**（`shell` 回给模型的文本）：模型看到的是 `[32m` 这种残渣，
 *    既占预算又可能被当成正文照抄；
 * 2. **后台任务日志**（`background-tasks.ts` 的每行）：界面是纯文本渲染，用户会看到
 *    `[1mLocal[22m:` 这种半截转义。
 *
 * 而 dev server 这类命令**一定会带颜色**：命令经 `npm run` 起，npm 会给脚本注入
 * `FORCE_COLOR`（RFC 73），于是 picocolors / chalk 认为「输出支持颜色」，即便 stdout
 * 只是一根管道。所以不能指望「不是 TTY 就没颜色」。
 *
 * ## 两条入口，别混用
 *
 * - `stripAnsi(text)`：**整段**文本（已经收齐的 stdout / 一行日志）。纯函数，无状态。
 * - `createAnsiStripper()`：**流式 chunk**（实时输出转发）。chunk 边界会把一个转义序列
 *   劈成两半（`\u001b[3` + `2m`），逐块 `stripAnsi` 会把前半截漏出去 —— 这个工厂扣住
 *   尾部未收全的序列，等下一块补齐再判。
 *
 * ## 匹配规则
 *
 * 一条完整的 ANSI 转义序列按形态分四类（见下面的 `ANSI_SEQUENCES`）：
 *
 * - CSI：`ESC [ 参数 中间字节 终止字节` —— 颜色 / 光标 / 清屏（`\u001b[32m`、`\u001b[2K`、`\u001b[?25l`）
 * - OSC：`ESC ] … BEL` 或 `ESC ] … ESC \` —— 超链接、改窗口标题（`\u001b]8;;url\u0007`）
 * - 字符集选择：`ESC ( B`、`ESC # 8` 这类三字节序列
 * - 其它两字节 ESC 序列：`ESC 7`（保存光标）、`ESC =`（键盘模式）等
 */
const ANSI_SEQUENCES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[()#%][0-9A-Za-z]|\u001b[@-Z\\-_]/g

/** 同一份规则的非全局副本：`test()` 不吃 `lastIndex` 的亏 */
const ONE_ANSI_SEQUENCE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[()#%][0-9A-Za-z]|\u001b[@-Z\\-_]/

/**
 * 剥掉文本里的 ANSI 转义序列。
 *
 * 只动「终端控制字节」，正文原样保留 —— 注意**没有** ESC 前缀的 `[32m` 是正文
 * （用户真的可能打出来），不能顺手删。
 *
 * 末尾若是个没收全的序列（流式 chunk 常见），这里删不掉也**不删**：整段调用时说明
 * 上游输出本来就残缺，扣着反而会吃掉正文；流式场景请用 `createAnsiStripper()`。
 */
export function stripAnsi(text: string): string {
  if (!text || !text.includes('\u001b')) return text
  // 有 OSC 这种可能跨大段文本的序列，用带 `g` 的副本；每次调用前重置避免残留
  ANSI_SEQUENCES.lastIndex = 0
  // 收尾再删一次孤立 ESC：残缺序列里的 ESC 不该留在纯文本里
  return text.replace(ANSI_SEQUENCES, '').replace(/\u001b/g, '')
}

/** 扣住的尾部最长这么多字符：真遇到永不收尾的 OSC 也不至于把输出堵死 */
const MAX_HELD_TAIL = 512

/**
 * 流式清洗器：喂 chunk，吐**已经干净**的文本。
 *
 * 扣住的是「上一块末尾那个还没收全的转义序列」，最长 `MAX_HELD_TAIL` 字符；超了说明上游
 * 根本不是转义序列（或者是永远收不了尾的 OSC），直接 `stripAnsi` 放出去，不再等。
 *
 * 用途：`shell` 的实时输出（`liveOutput`）—— 那里是**渲染态**，逐块追加，
 * 漏出去半截转义就会一直显示到这张卡片消失。
 */
export function createAnsiStripper(): (chunk: string) => string {
  let held = ''
  return (chunk: string): string => {
    if (!chunk) return ''
    const text = held + chunk
    const escapeAt = text.lastIndexOf('\u001b')
    // 没有 ESC，或者从最后一个 ESC 起已经是完整序列 → 全是可判定的内容
    if (escapeAt === -1 || ONE_ANSI_SEQUENCE.test(text.slice(escapeAt))) {
      held = ''
      return stripAnsi(text)
    }
    const tail = text.slice(escapeAt)
    if (tail.length > MAX_HELD_TAIL) {
      held = ''
      return stripAnsi(text)
    }
    held = tail
    return stripAnsi(text.slice(0, escapeAt))
  }
}

/**
 * 「这一行日志要不要给用户看」：剥完 ANSI 之后是空的就丢掉。
 *
 * 只有转义的行（清行 / 光标移动）在纯文本里等于空行 —— 后台日志里连刷几屏空白最费解，
 * 也最容易被当成「任务卡住了」。
 */
export function cleanLogLine(text: string): string {
  return stripAnsi(text).trim()
}
