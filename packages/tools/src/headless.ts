/**
 * 无头 chromium 的启动保障：**web_fetch（engine="browser"）与 browser_* 工具共用**。
 *
 * 抽成公共模块的理由：这两处的浏览器路径各写过一份 launch，各有各的毛病 ——
 * `chromium.launch()` 不吃 timeout 选项，浏览器二进制起不来时（缺依赖 / 沙箱被拒）会
 * **永久挂住**，那一轮对话跟着卡死；渲染后的固定等待也不接中止，用户点「停止」得干等满。
 * 见 `docs/lessons/desktop.md`「打包体积」一条。
 *
 * 这里只放「与抓取逻辑无关的浏览器生命周期」，不 import 任何业务模块（避免循环依赖）。
 */
import { stripAnsi } from './ansi'

/** 浏览器类型（playwright 是可选依赖，只取类型、运行时才动态 import） */
type HeadlessBrowser = Awaited<ReturnType<typeof import('playwright').chromium.launch>>

/** 默认的启动超时：与页面加载超时同一量级（30s） */
const DEFAULT_LAUNCH_TIMEOUT = 30_000

/**
 * 可中止的睡眠：`abortSignal` 一响就立刻返回（不等满 ms）。
 * 用于「给 SPA 一点渲染时间」那类固定等待 —— 用户点停止时不必再干等。
 */
export function abortableSleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    abortSignal?.addEventListener('abort', finish, { once: true })
  })
}

/** playwright 未安装时的统一可读报错（调用方不再各自 try/catch import） */
const PW_MISSING =
  'playwright 未安装。请在服务器环境执行 `npm i playwright && npx playwright install chromium` 后重试。'

/**
 * 启动无头 chromium，**带超时**。
 *
 * `chromium.launch()` 不吃 timeout 选项：浏览器二进制起不来时（缺依赖 / 沙箱被拒）会
 * **永久挂住**，那一轮对话跟着卡死。所以自己套一层 race，超时后抛可读错误。
 *
 * 超时后那个 promise **仍可能 resolve**（二进制其实已经起来了）—— 兜底 close 掉，
 * 否则每超时一次就漏一个 chromium 进程（低配机器上几次就吃满内存）。
 */
export async function launchHeadlessChromium(
  timeout: number = DEFAULT_LAUNCH_TIMEOUT
): Promise<HeadlessBrowser> {
  let pw: typeof import('playwright')
  try {
    pw = await import('playwright')
  } catch {
    throw new Error(PW_MISSING)
  }
  const launching = pw.chromium.launch({
    headless: true,
    // 沙箱在 root / CI 下常失败，按环境退一步
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutGuard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 兜底收掉那个迟到的 launch，别留孤儿进程
      void launching.then((b) => b.close().catch(() => {})).catch(() => {})
      reject(
        new Error(
          `无头 chromium 启动超过 ${timeout}ms 仍未完成（chromium 起不来时 launch 会永久挂住，这里强制收场）`
        )
      )
    }, timeout)
  })
  try {
    return await Promise.race([launching, timeoutGuard])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * playwright 的报错 → 可直接拼进工具结果的纯文本。
 *
 * playwright 的错误文本带**终端样式**：`Call log:` 下面那几行是灰字
 * （`\u001b[2m  - navigating to "…", waiting until "domcontentloaded"\u001b[22m`）。ESC 是不可见
 * 字符，原样进工具结果就只剩 `[2m … [22m` —— 界面上是噪音，模型还可能把 `[22m` 当正文照抄。
 * 截图 / 抓取都走管道，没有任何地方会解释这些字节，所以在这里一次剥干净。
 *
 * 只剥样式，正文（错误码、URL、Call log 逐行）全留着：那是判断「为什么打不开」的唯一线索。
 */
export function pageErrorMessage(err: unknown): string {
  return stripAnsi(err instanceof Error ? err.message : String(err)).trim()
}
