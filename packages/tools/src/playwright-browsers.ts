/**
 * Playwright 浏览器的运行时保障：web_fetch 的 `engine="browser"`、screenshot 工具
 * 与**内置浏览器面板 / `browser_*` 工具**都跑无头 Chromium，而安装包**不再随包分发
 * 浏览器**（原 extraResources 方案光一个 headless shell 就 271MB，占了安装包近一半），
 * 改为**首次使用时在线下载** `chromium-headless-shell`（约 150MB），落到 playwright
 * 的注册表目录：
 * Windows `%LOCALAPPDATA%\ms-playwright`、macOS `~/Library/Caches/ms-playwright`、
 * Linux `~/.cache/ms-playwright`，可用 `PLAYWRIGHT_BROWSERS_PATH` 覆盖。
 *
 * 为什么只装 headless shell：实测 `chromium.launch({ headless: true })` 用的就是它，
 * 完整 `chromium-<rev>`（约 433MB）根本用不上（对照实验见 git 历史里的
 * `scripts/prepare-pack-assets.mjs`）。连**内置浏览器面板的 CDP screencast 也用它**：
 * Playwright 1.64 实测 headless shell 能正常出帧（`Page.startScreencast` 收到真实画面），
 * 早先「headless shell 不带 screencast、画面会黑」的判断是 1.63 时的旧结论 —— 别因此
 * 又切回 `channel: 'chromium'`（那要完整 chromium 433MB，而这里从不下载它）。
 *
 * 怎么装：spawn 本进程可执行文件（`ELECTRON_RUN_AS_NODE=1` 把 Electron 当 Node 用）
 * 执行 `playwright-core/cli.js install chromium-headless-shell` —— 下载的版本永远与
 * 打进包里的 playwright-core 匹配。⚠️ 三个坑（全部实测）：
 * - `playwright-core` 的 exports **不暴露** `./cli.js`（`ERR_PACKAGE_PATH_NOT_EXPORTED`，
 *   与 vite/bin/vite.js 同款），只能从包根拼路径；
 * - 打包态里 playwright-core **不在 asar 根级**，而是嵌套在
 *   `node_modules/playwright/node_modules/playwright-core`（electron-builder 的依赖收集
 *   结果，根级那份缺 index.js/cli.js），从主进程位置解析会**逃逸到开发机的仓库根
 *   node_modules**（用户机器上没有）——必须用 `createRequire(require.resolve('playwright'))`
 *   锚定在 playwright 包内解析，dev 与打包态才都成立；
 * - `ELECTRON_RUN_AS_NODE` 下 Electron 44 **仍有 asar 透明层**（实测能读出并执行 asar
 *   内的 cli.js），无需把 playwright-core 加进 electron-builder 的 `asarUnpack`
 *   （加了反而多出一份解包副本）。
 *
 * 是否已下载的判定：`chromium.executablePath()` 在浏览器缺失时**不抛错**、照常返回
 * 计算出的路径（实测），从它正则反推注册表目录与 revision，检查
 * `chromium_headless_shell-<rev>` 目录是否存在。反查失败（布局变了 / playwright-core
 * 没装）时**不拦路**：前者让 launch 自己报错，后者由调用方的 `import('playwright')`
 * 抛出并给出可读提示。
 *
 * 下载只在缺失时发生；模块级 Promise 去重，并发调用共享同一次下载，失败后可重试。
 * 下载接 abortSignal（用户点「停止」立刻 kill 子进程并 reject），进度经 `sinks` 转给
 * 设置页的安装任务日志。
 *
 * ⚠️ **谁会触发下载**：设置页「浏览器」的『安装』是唯一显式入口。只剩内置浏览器引擎的
 * launch 兜底（`browser/engine.ts` 的 `ensureChromiumReady()`）还会在缺失时自愈 —— 那是
 * 「装配闸放过了、但运行时事后没了」的最后一道，正常路径走不到。
 *
 * 依赖这里的**三个工具面**都在装配期按 `browserRuntimeInfo().installed` 先挡一道，没装就
 * 不给模型看见，避免「每次调用都只回一句去设置里装」：
 * - `browser_*` 工具集与浏览器面板：`chat-turn.ts` / `browser-ws.ts` 挡；
 * - `screenshot`：`webToolsPlugin` 直接不挂；
 * - `web_fetch`：照挂，但 schema 里没有 `engine` 入参（只有 fetch 引擎）。
 * 剩下的 `BrowserRuntimeMissingError` / `playwright 未安装` 那几句只兜「装配之后运行时被
 * 卸掉」这种赛况。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { directorySize } from './dir-size'

/** 单次下载的总超时：网络再差 10 分钟也该有结论了，挂死比失败更难排查 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/** 下载进度行的订阅者（设置页的安装任务把下载器输出转成后台任务日志） */
type LineSink = (line: string) => void

/**
 * 进行中的下载（模块级去重）；失败时清空，下次调用重新尝试。
 *
 * `sinks` 与 promise 一起挂着：设置页的「安装」走 `startBackgroundTask`，而 Agent 工具
 * 首次使用也会触发同一次下载 —— 后到的调用者只能拿到这个 Promise，拿不到子进程的
 * stdout。把订阅者集合放在这里，两条路径才都能看到进度（否则安装任务的日志一片空白，
 * 用户看着 150MB 下载毫无动静）。
 */
let pendingDownload: { promise: Promise<void>; sinks: Set<LineSink> } | undefined

/** 目录占用的缓存：设置页轮询时不必每次重扫几千个文件（安装/卸载时清空） */
const sizeCache = new Map<string, number>()

/**
 * 工具在动态 import playwright 之前调用：确保 headless shell 可用（必要时先下载）。
 *
 * `abortSignal`（用户点「停止」）会一路传到下载进程：早先这里**不接中止**，而下载源
 * （playwright CDN / npmmirror）在国内常常只有几 KB/s，一次能拖好几分钟 —— 那一轮
 * 对话点停止毫无反应，界面看着像卡死。现在 abort 立刻 kill 下载子进程并 reject，
 * 这一轮工具调用随即按「已中止」收场。
 */
export function ensureChromiumReady(
  abortSignal?: AbortSignal,
  onLine?: LineSink
): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(new Error('chromium 下载前已被中止（用户点了停止）。'))
  }
  const dir = headlessShellDir()
  if (dir !== undefined && existsSync(dir)) return Promise.resolve()
  // 模块级去重：并发调用共享同一次下载。**但传入的 signal 只对本次等待生效** ——
  // abort 时会 kill 掉共享的那个子进程，pendingDownload 清空，下次调用重新下载。
  if (!pendingDownload) {
    const sinks = new Set<LineSink>()
    const promise = downloadChromiumHeadlessShell(abortSignal, sinks).finally(() => {
      // 收了就摘掉：`browserRuntimeInfo().downloading` 靠它判断「是否正在装」，
      // 留着一条已完成的 Promise 会让设置页永远停在「安装中…」。
      pendingDownload = undefined
    })
    pendingDownload = { promise, sinks }
  }
  const download = pendingDownload
  if (onLine) {
    download.sinks.add(onLine)
    // 收场后摘掉订阅者：日志闭包会钉住设置页的 React 状态，不摘等于泄漏一份
    void download.promise
      .finally(() => download.sinks.delete(onLine))
      .catch(() => {
        /* 失败已由主 Promise 的调用方处理，这里只是清理订阅 */
      })
  }
  return download.promise
}

/**
 * 锚定在 **playwright 包内**解析 playwright-core：打包态（asar）里 core 嵌套在
 * playwright 包下、根级那份不完整，从主进程位置解析会逃逸到开发机的 node_modules。
 */
function playwrightCoreRequire(): NodeRequire {
  const require = createRequire(import.meta.url)
  return createRequire(require.resolve('playwright'))
}

/**
 * 从 playwright-core 反查本版本需要的 headless shell 目录；
 * 反查不出（playwright 没装 / 可执行路径布局变了）返回 undefined，此时不拦 launch。
 */
function headlessShellDir(): string | undefined {
  try {
    const require = playwrightCoreRequire()
    const { chromium } = require('playwright-core') as typeof import('playwright-core')
    // .../ms-playwright/chromium-1243/chrome-win64/chrome.exe（浏览器没装也不抛错）
    const m = /^(.*[\\/])chromium-(\d+)[\\/]/.exec(chromium.executablePath())
    if (!m) return undefined
    return join(m[1], `chromium_headless_shell-${m[2]}`)
  } catch {
    return undefined
  }
}

/** playwright-core 的安装 CLI（asar 内的路径也可直接执行，见文件头说明） */
function cliJsPath(): string {
  // exports 不暴露 ./cli.js：从包根拼（resolve('playwright-core') → index.js）
  return join(dirname(playwrightCoreRequire().resolve('playwright-core')), 'cli.js')
}

function downloadChromiumHeadlessShell(
  abortSignal: AbortSignal | undefined,
  sinks: Set<LineSink>
): Promise<void> {
  let cli: string
  try {
    cli = cliJsPath()
  } catch (err) {
    return Promise.reject(
      new Error(
        `playwright-core 未安装（解析其安装 CLI 失败：${String(err)}）。请先执行 npm i playwright && npx playwright install chromium-headless-shell。`
      )
    )
  }
  if (!existsSync(cli)) {
    return Promise.reject(
      new Error(`playwright-core 的安装 CLI 不存在：${cli}（打包态请确认 asarUnpack 里有 playwright-core）。请手动执行 npx playwright install chromium-headless-shell 后重试。`)
    )
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 下载器是控制台程序不是 GUI，藏掉窗口没问题（别用在 explorer 这类 GUI 程序上）
      windowsHide: true
    })
    let outTail = ''
    const tail = (acc: string, chunk: Buffer) => (acc + chunk.toString()).slice(-2000)
    // 下载器的进度条用 `\r` 刷同一行，所以按行切要连 `\r` 一起当分隔符
    const emit = (line: string) => {
      for (const sink of sinks) sink(line)
    }
    const splitOut = lineSplitter(emit)
    const splitErr = lineSplitter(emit)
    child.stdout.on('data', (c: Buffer) => {
      outTail = tail(outTail, c)
      splitOut(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      outTail = tail(outTail, c)
      splitErr(c)
    })

    let settled = false
    const onAbort = () => {
      // 用户点了「停止」：杀掉下载子进程并让这一轮立刻收场。
      // ⚠️ 早先这里没有这一段，而下载源在国内常只有几 KB/s，一次拖几分钟 ——
      // 那一轮对话点停止毫无反应，界面看着像卡死（用户实测卡过 5 分钟以上）。
      settled = true
      child.kill()
      reject(new Error('chromium headless shell 下载已被用户中止（点了「停止」）。'))
    }
    // 入口已判过一次 aborted，但「判定 → spawn」之间仍可能被 abort，所以这里再兜一层
    if (abortSignal?.aborted) {
      child.kill()
      reject(new Error('chromium headless shell 下载已被用户中止（点了「停止」）。'))
      return
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, DOWNLOAD_TIMEOUT_MS)

    const finish = (fn: () => void) => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      settled = true
      fn()
    }

    child.on('error', (err) => {
      if (settled) return
      finish(() =>
        reject(new Error(`chromium headless shell 下载进程启动失败：${String(err)}`))
      )
    })
    child.on('exit', (code) => {
      if (settled) return
      if (code === 0) {
        finish(() => resolve())
        return
      }
      const reason = timedOut ? '超时（10 分钟）' : `exit ${code}`
      finish(() =>
        reject(
          new Error(
            `chromium headless shell 下载失败（${reason}）。网络受限时可设置镜像后重试，` +
              `例如 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/ 。` +
              `下载器输出尾部：${outTail.trim() || '（无）'}`
          )
        )
      )
    })
  })
}

/** 把子进程的字节流切成行（`\r` 与 `\n` 都算行尾），空行丢弃 */
function lineSplitter(emit: LineSink): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString()
    const parts = buffer.split(/\r\n|\r|\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (line) emit(line)
    }
    // 极端情况下（半截超长行）别让 buffer 无限长
    if (buffer.length > 4000) {
      emit(buffer.slice(-4000).trim())
      buffer = ''
    }
  }
}

/** 浏览器运行时的安装状态（设置页「浏览器」一节的数据源） */
export interface BrowserRuntimeInfo {
  /** headless shell 是否已就绪 */
  installed: boolean
  /** 安装目录；连目录都反查不出（playwright-core 没装）时 null */
  path: string | null
  /** 磁盘占用（字节）；没装或统计失败 = null */
  sizeBytes: number | null
  /** 与 package.json 里 playwright-core 匹配的 revision；反查不出 null */
  revision: string | null
  /** 有没有下载正在进行（设置页据此禁用「安装」按钮） */
  downloading: boolean
}

/**
 * 运行时状态。**同步**读：目录遍历只有几千个文件、几十毫秒，放在 GET 里可接受；
 * 扫描结果按目录缓存，安装 / 卸载时清掉（`sizeCache`），轮询不会反复扫盘。
 */
export function browserRuntimeInfo(): BrowserRuntimeInfo {
  const dir = headlessShellDir() ?? null
  const installed = dir !== null && existsSync(dir)
  let sizeBytes: number | null = null
  if (installed && dir) {
    const cached = sizeCache.get(dir)
    if (cached !== undefined) {
      sizeBytes = cached
    } else {
      const size = directorySize(dir)
      sizeCache.set(dir, size)
      sizeBytes = size
    }
  }
  return {
    installed,
    path: dir,
    sizeBytes,
    revision: dir ? (/chromium_headless_shell-(\d+)$/.exec(dir)?.[1] ?? null) : null,
    downloading: pendingDownload !== undefined
  }
}

/**
 * 卸载自带浏览器（删掉 headless shell 目录）。
 *
 * ⚠️ 调用方必须**先关掉所有浏览器会话**：Windows 上正在运行的可执行文件删不掉
 * （EBUSY / EPERM），会留下半个目录，比不装更糟（`existsSync` 仍为 true，
 * 于是被当成「已安装」而 launch 失败）。
 */
export async function uninstallChromium(): Promise<void> {
  const dir = headlessShellDir()
  if (!dir) {
    throw new Error(
      '无法定位自带浏览器的安装目录（playwright-core 未安装或版本解析失败）。可直接删除 ms-playwright 目录下的 chromium_headless_shell-* 。'
    )
  }
  await rm(dir, { recursive: true, force: true })
  sizeCache.clear()
}

