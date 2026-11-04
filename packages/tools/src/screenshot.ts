/**
 * 内置 screenshot 工具：用 Playwright 无头浏览器打开网页截图，存到服务端数据目录的
 * `screenshots/`，并返回一个**同源相对 URL**（`/api/screenshots/<uuid>.<ext>`）。
 *
 * 模型可把它作为 Markdown 图片语法嵌入回复（如 `![截图](/api/screenshots/xxx.png)`），
 * 前端渲染时按页面源解析即可，不需要知道服务器的外网地址。
 *
 * 设计要点：
 * - 只读 / 无副作用：只往数据目录写一张图，不碰工作区文件，任何权限模式都可用
 *   （与 web_fetch 一个待遇 —— 相当于「看一眼网页长什么样」）；
 * - 依赖内置浏览器运行时（Playwright headless shell，与 web_fetch 的 browser 引擎同源）：
 *   **没装时这个工具压根不会被挂上**（`webToolsPlugin` 在装配期按
 *   `browserRuntimeInfo().installed` 挡，见那里）。工具内部那道「没装就回一句去设置里装」
 *   只兜「装配之后运行时被卸掉」的赛况，正常路径走不到 —— 别把它当成拦路的主闸。
 * - playwright 走动态 import，没装也能正常启动，只是用到时才报错；
 * - 文件名用随机 UUID，对外暴露的 `/api/screenshots/...` 按「高熵不可猜测」处理
 *   （服务端生成的高熵 UUID），这样 markdown 里的 `<img>` 在启用鉴权时
 *   也能直接加载（浏览器不会给图片请求带 Authorization 头）。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { resolveDataDir } from '@fizz/workspace'
import { browserRuntimeInfo } from './playwright-browsers'
import { abortableSleep, launchHeadlessChromium, pageErrorMessage } from './headless'

/** 截图落盘子目录（相对数据目录） */
const SCREENSHOT_DIR = 'screenshots'
const DEFAULT_TIMEOUT = 30_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

type ShotFormat = 'png' | 'jpeg' | 'webp'

/** 把数值夹到 [min,max] 并取整（视口尺寸用） */
function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/** 构建 screenshot 工具（返回单键 ToolSet，便于在 agent 端与其它工具合并） */
export function buildScreenshotTool(): ToolSet {
  return {
    screenshot: tool({
      description:
        '用无头浏览器打开一个网页并截图，返回图片地址（Markdown 图片语法）。' +
        '适合：让对话直接「看到」某个网页 / 报表 / 图表长什么样，或把页面状态记录进回复。' +
        '返回的是一个相对地址（形如 /api/screenshots/xxx.png），请务必在你的回复里用 Markdown 图片语法引用它，' +
        '例如 `![网页截图](/api/screenshots/xxx.png)`，这样用户才能直接看到图。' +
        '只读、不写任何工作区文件。需要内置浏览器运行时（headless shell），由用户在「设置 → 浏览器」里安装 —— 没装时这个工具会直接告诉你，不会自行下载。',
      inputSchema: z.object({
        url: z.string().describe('要截图的网页 URL，必须是 http(s)，如 https://example.com'),
        width: z.number().optional().describe('浏览器视口宽度（像素），默认 1280，范围 320–4000'),
        height: z.number().optional().describe('浏览器视口高度（像素），默认 800，范围 240–4000'),
        fullPage: z
          .boolean()
          .optional()
          .describe('是否截取整页（自动滚动到底部，保留完整长图），默认 false（只截首屏视口）'),
        format: z
          .enum(['png', 'jpeg', 'webp'])
          .optional()
          .describe('图片格式，默认 png（无损、体积较大）；jpeg 更小但有损；webp 兼顾'),
        timeoutMs: z.number().optional().describe('页面加载超时（毫秒），默认 30000，最大 60000')
      }),
      execute: async ({ url, width, height, fullPage, format, timeoutMs }, options) => {
        // URL 合法性 + 协议白名单：只允许 http(s)，挡掉 file:/data:/javascript: 等
        let target: URL
        try {
          target = new URL(url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return `screenshot 拒绝非 http(s) 地址：${url}（协议：${target.protocol}）`
          }
        } catch {
          return `screenshot 收到非法 URL：${url}。请传入完整地址如 https://example.com`
        }
        if (options.abortSignal?.aborted) return 'screenshot 已被中止（未发起请求）。'

        const fmt: ShotFormat = format ?? 'png'
        const timeout = Math.max(1000, Math.min(60_000, Math.trunc(timeoutMs ?? DEFAULT_TIMEOUT)))
        const id = randomUUID()
        const fileName = `${id}.${fmt}`
        const dir = join(resolveDataDir(), SCREENSHOT_DIR)
        const absPath = join(dir, fileName)

        try {
          // 没装就直接回话，**不下载**（与 web_fetch 的 browser 引擎同一口径）：
          // 一次截图背后悄悄挂上十分钟的下载、界面上零进度，用户只知道「卡住了」，
          // 而且会和「设置 → 浏览器」的安装任务抢同一次下载。
          // 判据与工具条那颗开关、chat-turn 的装配闸同源：`browserRuntimeInfo().installed`。
          if (!browserRuntimeInfo().installed) {
            return (
              'screenshot 需要内置浏览器（Playwright headless shell，约 150MB），这台机器上还没装，' +
              'screenshot 不会替你下载。请告诉用户去「设置 → 浏览器」点「安装」，装好后重试；' +
              '这期间要读网页内容可以改用 web_fetch（它的 fetch 引擎不需要浏览器）。'
            )
          }
          // launch 超时 + playwright 未安装的可读报错都收在 headless.ts（与 web_fetch 共用）
          const browser = await launchHeadlessChromium(timeout)
          try {
            const context = await browser.newContext({
              userAgent: UA,
              viewport: {
                width: clampInt(width, 320, 4000, 1280),
                height: clampInt(height, 240, 4000, 800)
              }
            })
            const page = await context.newPage()
            // 用户中止时直接关掉页面，让挂起的 goto / screenshot 抛错退出
            options.abortSignal?.addEventListener(
              'abort',
              () => {
                page.close().catch(() => {})
              },
              { once: true }
            )
            // 先 domcontentloaded 拿到首屏，再等一会儿让 SPA / 懒加载把内容画出来
            await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout })
            await abortableSleep(800, options.abortSignal)
            if (options.abortSignal?.aborted) {
              return 'screenshot 已被用户中止（点了「停止」）。'
            }
            await fs.mkdir(dir, { recursive: true })
            await page.screenshot({
              path: absPath,
              fullPage: fullPage ?? false,
              type: fmt
            })
          } finally {
            await browser.close().catch(() => {})
          }

          const servePath = `/api/screenshots/${fileName}`
          return [
            `截图已生成并保存到服务端。请在你的回复中以 Markdown 图片语法引用它，让用户直接看到图：`,
            `![网页截图](${servePath})`,
            `（图片地址：${servePath}；格式：${fmt}；整页：${fullPage ? '是' : '否'}）`
          ].join('\n')
        } catch (err) {
          // pageErrorMessage：playwright 的报错自带终端样式（Call log 是灰字），必须剥掉
          const msg = pageErrorMessage(err)
          // 目录在、可执行文件缺（卸载被打断 / 杀软清掉）：不是换个 URL 能解决的，
          // 指路去设置里点一次「安装」把运行时补回来
          if (/Executable doesn't exist|executable doesn't exist|Failed to launch/i.test(msg)) {
            return (
              `screenshot 启动内置浏览器失败：可执行文件缺失或不完整（${msg}）。` +
              `请告诉用户到「设置 → 浏览器」点「安装」把运行时补回来后再试。`
            )
          }
          return `screenshot 截图 ${url} 失败：${msg}`
        }
      }
    })
  }
}
