/**
 * 进程退出收尾：收到 SIGINT / SIGTERM 时，把「正在执行的东西」停下来并把状态落盘，
 * 再退出。
 *
 * ## 为什么需要
 *
 * 服务端的很多东西默认是「跟进程同生共死」的，进程一死它们就停在最坏的状态：
 *
 * | 对象 | 直接退出会怎样 | 这里怎么处理 |
 * |---|---|---|
 * | 正在跑的一轮对话 | run 与半截正文**只在内存**，用户消息在、助手一个字不在 | `abortAllRuns()` → 等收尾，chat-turn 把已产生的部分落盘 |
 * | PTY 终端 | 子进程变孤儿（Windows 上尤其明显，`taskkill` 一批 conhost） | `killAllTerminalSessions()` |
 * | 定时任务调度器 | 定时器还在跑（unref 过，不至于吊住进程，但没必要） | `stopTriggerScheduler()`：停 tick / at 定时器，宽限等在跑的会话收尾 |
 * | 容器型项目的公网入口 | 是**独立的第二个监听端口**，退出时得关监听器、清端口缓存 | `stopPublicGateway()` |
 * | `JsonStore` 的一次 mutate | `mutate` 是 fire-and-forget，最后一次写可能没落盘 | `store.flush()` 等在途写完 |
 *
 * **刻意不做**的事：
 * - **不 stop 容器型项目的容器**：它的运行态**根本不落盘**（见 `lifecycle.ts`），
 *   退出时没有任何东西要保，重新打开项目自然会再起一次；
 * - **不等**在途的「起容器」Promise：那个流程走到一半退出，留下的只是一个 detached
 *   容器（或没起来），没有任何内存态要落盘 —— 等它只会让退出多卡最多 60 秒；
 *   （在途的**对话轮次**是另一回事，由第 4 步的 `abortAllRuns()` 收，容器轮次的 run
 *   也注册在 `chatRuns` 里，一并覆盖）；
 * - 不给 `beforeExit` / `process.on('exit')` 挂同样的逻辑 —— `exit` 处理器里**不能 await**
 *   任何东西（Node 不会等），那种写法看着像收尾、实际什么都做不了。
 *
 * 每一步都有独立的超时与 try/catch：收尾失败不该把进程钉住不退 —— 最差情况就是
 * 「没落盘就退了」，跟没这个文件一样，而不是「永远退不出去」。
 */

/** 已在某个 Server 上装过（类型上的标记，运行时就是个布尔） */
const STEP_TIMEOUT_MS = 5_000
/** 整个收尾流程的硬上限：超时后无条件退出，不跟任何一步较劲 */
const TOTAL_TIMEOUT_MS = 15_000

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** 跑一步，限时 + 吞异常：任何一步卡住/炸了都不影响后面的步骤和最终退出 */
async function step(label: string, run: () => Promise<void> | void, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve().then(run),
      delay(timeoutMs).then(() => {
        throw new Error('超时')
      })
    ])
    console.log(`[shutdown] ${label}：完成`)
  } catch (err) {
    console.error(`[shutdown] ${label}：失败（继续退出）——`, err instanceof Error ? err.message : err)
  }
}

/** 已经在收尾（第二次信号直接忽略） */
let shuttingDown = false

/**
 * 跑一遍收尾并退出。**幂等**：重复调用只在第一次真正执行。
 *
 * 导出出来是为了能单独跑（`scripts/` 下那种手工验证脚本）；正常路径是
 * `installShutdownHandlers` 把它挂到信号上。
 */
export async function runShutdown(
  closeServer: () => Promise<void> | void,
  signal = 'manual'
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[shutdown] 收到 ${signal}，开始收尾…`)

  // 兜底中的兜底：无论收尾流程卡在哪，15 秒后一定走人
  const bail = setTimeout(() => {
    console.error('[shutdown] 收尾超时，强制退出')
    process.exit(0)
  }, TOTAL_TIMEOUT_MS)

  // 1. 停止接受新连接（已有连接留着 —— 前端还要收最后几条推送）
  await step('停止接受新连接', closeServer, 3_000)

  // 2. 收掉终端子进程（这步是同步的，但放进步骤里统一计时）
  await step('收掉终端子进程', async () => {
    const { killAllTerminalSessions } = await import('./terminal/pty')
    killAllTerminalSessions()
  })

  // 3. 停后台维护定时器

  // 3.5 停性能监控采样器（定时器已 unref，本就不挡退出；这里是干净收尾）
  await step('停止性能监控采样器', async () => {
    const { stopSystemMonitor } = await import('./services/system-monitor')
    stopSystemMonitor()
  })

  // 3.6 断开 SSH 主机监控的连接（每条都是真实 socket，不关会拖着进程不退出）
  await step('断开主机监控连接', async () => {
    const { stopAllHostMonitors } = await import('./ssh/monitor')
    stopAllHostMonitors()
  })

  // 3.7 关掉 SSH 隧道：本地监听（-L / -D）与每条隧道的 SSH 连接都是真实 socket，
  //     不关同样会拖着进程不退出（远程转发 -R 的监听随连接消亡，无需额外处理）
  await step('关闭 SSH 隧道', async () => {
    const { stopAllTunnels } = await import('./ssh/tunnels')
    stopAllTunnels()
  })

  // 3.75 远端工作区的执行 / SFTP 连接：同样是真实 socket（SFTP 池闲置 3 分钟、
  //     执行池闲置 5 分钟），不主动关会把进程拖到超时强制退出
  await step('关闭远端工作区连接', async () => {
    const { remoteExecService } = await import('./ssh/exec')
    const { sftpService } = await import('./ssh/sftp')
    remoteExecService.disposeAll()
    sftpService.closeAll()
  })

  // 3.8 容器型项目：公网入口（独立监听 `FIZZ_PUBLIC_HTTP_PORT`，关监听器 + 清端口缓存）。
  //     **不 stop 项目容器** —— 它们是 detached 的，服务重启后仍在跑；
  //     停掉反而把「下次要用得等冷启动」变成每次重启都要等（启动由用户在项目菜单里点，
  //     见 lifecycle.ts 的说明）。
  await step('停止容器型项目的后台部件', async () => {
    const { stopPublicGateway } = await import('./container-projects/public-gateway')
    stopPublicGateway()
  })

  // 3.9 停掉后台命令（agent 用 `runInBackground` 起的 dev server / watch）。
  //     它们自成进程组，**父进程退出不会跟着退** —— 不停就是一堆占着端口的孤儿进程，
  //     而且登记表随进程消失，之后没有任何界面能停它们。只发信号不等收场。
  await step('停止后台命令', async () => {
    const { stopAllRunning } = await import('./background-tasks')
    stopAllRunning()
  })

  // 4. 中止所有在跑的对话，并**等它们收尾** —— 这一步等的是 chat-turn 把已产生的
  //    部分正文落盘（`run.done` 在 finishRun 之后 resolve），是整个收尾里唯一
  //    「真的在保住用户东西」的一步，所以给它最长的宽限。
  await step(
    '中止在跑的对话并等它落盘',
    async () => {
      const { abortAllRuns } = await import('./chat-run')
      const pending = abortAllRuns()
      if (!pending.length) return
      await Promise.race([Promise.all(pending), delay(STEP_TIMEOUT_MS)])
    },
    STEP_TIMEOUT_MS + 2_000
  )

  // 5. 停定时任务调度器（会话已在第 4 步被中止，宽限期通常用不满）
  await step(
    '停止定时任务调度器',
    async () => {
      const { stopTriggerScheduler } = await import('./scheduler')
      await stopTriggerScheduler(3_000)
    },
    6_000
  )

  // 6. 等最后一次 store 写盘落地 —— 必须在所有 domain 写入之后
  await step('等待数据落盘', async () => {
    const { store } = await import('./state')
    await store.flush()
  })

  // 6.5 等应用日志的在途落盘写完。日志是**异步追加且不 await** 的（写日志不该阻塞业务），
  //     不在这里等一等，进程 exit 时链尾那几条（往往正是收尾过程本身的记录）就丢了。
  //     放在 store 之后：收尾各步骤的日志也算在「最后几条」里。
  //     `flushTerminalLogs()` 同理 —— 终端被第 2 步收掉后，`onExit` 里最后一次转录回填
  //     （以及会话文件那一块）还在链上，不等就丢。
  await step('等待应用日志落盘', async () => {
    const { appLog, flushTerminalLogs } = await import('@fizz/workspace')
    await appLog.flush()
    await flushTerminalLogs()
  })

  clearTimeout(bail)
  console.log('[shutdown] 收尾完成，退出')
  process.exit(0)
}

/**
 * 装上退出钩子。**幂等**：重复调用只生效一次（信号连按两次也只跑一轮收尾）。
 *
 * `closeServer` 由 server.mjs 传进来：先停止接受新连接，再各自收尾。参数是回调而不是
 * 直接 import http server，是为了让这个模块不依赖 server.mjs 的加载顺序。
 */
export function installShutdownHandlers(closeServer: () => Promise<void> | void): void {
  if (installShutdownHandlers.installed) return
  installShutdownHandlers.installed = true

  process.on('SIGINT', () => void runShutdown(closeServer, 'SIGINT'))
  process.on('SIGTERM', () => void runShutdown(closeServer, 'SIGTERM'))

  // 未捕获异常：Node 默认是直接崩掉，那就崩，但崩之前把在途的写盘等完、半截正文落盘
  // （uncaughtException 里 return 之后 Node 会照常退出，所以这里主动走一遍收尾）
  process.on('uncaughtException', (err) => {
    console.error('[server] 未捕获异常：', err)
    void runShutdown(closeServer, 'uncaughtException')
  })
  // 未处理的拒绝只记日志：不值得为一轮对话的某个边缘 case 把整个服务停掉
  process.on('unhandledRejection', (reason) => {
    console.error('[server] 未处理的 Promise 拒绝：', reason)
  })
}

/** 装过了没有（类型上的标记，运行时就是个布尔） */
installShutdownHandlers.installed = false