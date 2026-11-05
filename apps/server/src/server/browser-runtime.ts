/**
 * 自带浏览器（Playwright headless shell）的检测 / 安装 / 卸载。
 *
 * ## 为什么由用户手动点
 *
 * headless shell 约 150MB，安装包不再随包分发（见 `@fizz/tools` 的
 * `playwright-browsers.ts` 文件头）。早先是「首次用到时静默下载」：用户点开浏览器
 * 面板，界面先空等几分钟，失败时只看到 `Executable doesn't exist` —— 既不知道在下载、
 * 也不知道要下多大。现在把这件事搬到设置页，明确写清「装什么、多大、装到哪」，
 * 装完之前工具条上根本不出现浏览器开关。
 *
 * ## 安装为什么必须登记成后台任务
 *
 * 国内源常常只有几 KB/s，一次能拖十几分钟。挂在 HTTP 请求上等的话，关掉设置页
 * 就等于放弃（desktop 的 IPC 桥还不转发 AbortSignal，连接断了和用户点取消分不开）。
 * 登记成任务后：关页面不影响、状态栏能看到进度、要停就显式取消。
 */
import {
  browserProfileUsage,
  browserRuntimeInfo,
  browserSessions,
  ensureChromiumReady,
  purgeAllBrowserProfiles,
  uninstallChromium
} from '@fizz/tools'
import type { BrowserProfileUsage } from '@fizz/contracts'
import type { BrowserRuntimeResult } from '@fizz/contracts/agent-api'
import { listBackgroundTasks, startBackgroundTask } from './background-tasks'

/** 安装任务的 kind（前端按它找「当前这次安装」） */
export const BROWSER_INSTALL_KIND = 'browser-runtime'

/** 正在跑的安装任务；没有则 null */
function runningInstallTask() {
  return (
    listBackgroundTasks().find(
      (task) => task.kind === BROWSER_INSTALL_KIND && task.status === 'running'
    ) ?? null
  )
}

/**
 * 状态 + 最近一次安装任务。
 *
 * `task` 取「运行中优先，否则最近一条」：`listBackgroundTasks` 已经把运行中的排在前面、
 * 同组按开始时间倒序，所以直接 find 第一条同 kind 的就是想要的。
 */
export function browserRuntimeSnapshot(): BrowserRuntimeResult {
  const runtime = browserRuntimeInfo()
  const task = listBackgroundTasks().find((item) => item.kind === BROWSER_INSTALL_KIND) ?? null
  return { runtime, task }
}

/**
 * 开始安装（幂等）：已经在装就返回同一条任务，已装好则什么都不做。
 *
 * 返回的是**刚登记那一刻**的快照，`task.status` 立刻是 `running`，前端据此开始轮询。
 */
export function startBrowserRuntimeInstall(): BrowserRuntimeResult {
  if (!runningInstallTask()) {
    const runtime = browserRuntimeInfo()
    if (!runtime.installed) {
      startBackgroundTask({
        kind: BROWSER_INSTALL_KIND,
        title: '安装内置浏览器',
        detail: runtime.path ?? 'Playwright headless shell（约 150MB）',
        run: async (signal, log) => {
          log('下载 Playwright headless shell（约 150MB，网络慢时可能几分钟）…')
          // 下载器输出（含百分比进度）逐行进日志：进度行会被 `cleanLogLine` 原地覆盖，
          // 不会把 400 行的额度刷光
          await ensureChromiumReady(signal, (line) => log(line))
          log('安装完成')
        }
      })
    }
  }
  return browserRuntimeSnapshot()
}

/**
 * 卸载：先关掉所有浏览器会话，再删目录。
 *
 * ⚠️ 顺序不能反：Windows 上正在运行的可执行文件删不掉（EBUSY / EPERM），
 * 失败会留下**半个目录** —— `existsSync` 仍为 true，于是被判成「已安装」，
 * 之后每次 launch 都失败，比干脆没装更难排查。
 *
 * 会话关闭会推 `closed` 事件给面板（reason 是「内置浏览器已卸载」），
 * 用户看到的是「浏览器已关闭」而不是画面卡死。
 */
export async function uninstallBrowserRuntime(): Promise<BrowserRuntimeResult> {
  if (runningInstallTask()) {
    throw Object.assign(new Error('正在安装中：请先在任务列表里取消安装，再卸载。'), {
      status: 409
    })
  }
  // 逐个关（不用 `closeAll`：那个的关闭原因是「应用退出」，面板会以为整个应用要退了）
  for (const sessionId of browserSessions.list()) {
    await browserSessions.close(sessionId, '内置浏览器已卸载').catch(() => {})
  }
  await uninstallChromium()
  return browserRuntimeSnapshot()
}

/**
 * 网站数据占用（设置页「浏览器」里的那一行）。
 *
 * 统计的是**磁盘上的 profile 目录**而不是会话清单：历史版本删会话时没扫 profile，
 * 那些残留只有按磁盘数才看得见（见 `browserProfileDirs` 的注释）。
 *
 * 这里会遍历目录算体积，**只给用户手动打开设置页 / 点完清除时调**，别塞进
 * `browserRuntimeSnapshot` 让安装进度轮询（1.5s 一次）带着扫 —— 那会反复 walk
 * 几十个 Chromium profile。
 */
export function browserDataSnapshot(): BrowserProfileUsage {
  return browserProfileUsage()
}

/**
 * 清除**所有会话**的网站数据（兜底动作，日常用的是会话级那条）。
 *
 * 必须先关会话再删目录（Windows 上正在写的 profile 删不干净），reason 也不用
 * 「应用退出」—— 逐个关的写法与 `uninstallBrowserRuntime` 同一口径。
 * 删不掉的目录留给下次，不让整次操作失败。
 */
export async function clearAllBrowserData(): Promise<BrowserProfileUsage> {
  await purgeAllBrowserProfiles('网站数据已清除')
  return browserDataSnapshot()
}
