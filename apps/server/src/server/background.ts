/**
 * 后台维护服务的统一启动/停止：定时任务调度器、性能采样器、
 * 工作区目录巡检、SSH 隧道、容器型项目的公网入口。
 *
 * 为什么抽出来：这些服务过去只在独立服务入口（`index.ts`）启动；桌面端的进程内后端
 * （`@fizz/agent-host` 的 `BackendManager`）只装配了 Hono 应用 —— 同一份路由代码，
 * 却**没有任何后台服务在跑**，定时任务建了永远不触发。抽成共享模块后两个形态各自调一次。
 *
 * 幂等：每个 start 内部自带防重入（调度器的 `started` 标记 / supervisor 的定时器句柄 /
 * 采样器的全局单例），重复调用安全 —— 桌面端的「远程访问」形态会再次装配后端，
 * 靠的就是这层幂等。
 */

import { join } from 'node:path'
import { DEFAULT_BROWSER_SETTINGS } from '@fizz/contracts'
import { resolveDataDir } from '@fizz/workspace'

/**
 * 拉起全部「服务开着就该跑」的后台维护（等价于旧 Next 版的 `instrumentation.register`）。
 * 同步启动为主（内部只是装定时器），不抛错 —— 失败打日志，绝不拖住调用方的就绪流程。
 */
export function startBackgroundServices(): void {
  const run = (label: string, start: () => void | Promise<void>): void => {
    /**
     * 启动失败：控制台 + **应用日志**两条都走。
     *
     * 只打控制台的话，用户在界面上永远不知道「后台某个服务起来时挂了」——
     * 那正是日志面板最该回答的问题（见 `features/logs`）。
     * `appLog` 在 `app-log` 这一步 init 之后才落盘，但**内存写入从不需要 init**，
     * 所以这里即使 init 还没跑完也不会丢。
     */
    const fail = (err: unknown): void => {
      console.error(`[${label}] 启动失败：`, err)
      void import('@fizz/workspace').then(({ appLog }) =>
        appLog.error('system', `后台服务「${label}」启动失败`, err instanceof Error ? err.stack ?? err.message : String(err))
      )
    }
    try {
      void Promise.resolve(start()).catch(fail)
    } catch (err) {
      fail(err)
    }
  }
  // 应用日志：注册内置命名空间 + 建目录 + 回填落盘尾部。**必须排在所有子任务之前** ——
  // 后面任何一个服务启动失败都要能记进日志里，日志自己没就绪就等于最该被记录的那批事件丢了。
  run('app-log', () => {
    return import('./app-log-namespaces')
      .then((m) => m.registerBuiltinNamespaces())
      .then(() => import('@fizz/workspace'))
      .then((m) => m.appLog.init(resolveDataDir()))
  })
  // 插件注册的模型配置：启动时就挂一遍全局插件，设置页 / 会话立刻能看到（异步，不挡启动）
  run('plugin-models', () => {
    void import('./plugin-models').then((m) => m.refreshPluginModels())
  })
  // 会话状态钩子：订阅全局事件总线，按工作区挂长驻插件宿主（见 conversation-hooks.ts）
  run('conversation-hooks', () => {
    void import('./conversation-hooks').then((m) => m.startConversationHooks())
  })
  // 定时任务调度器（进程内 cron）：cron / at 到点自动起会话
  run('triggers', () => {
    void import('./scheduler').then((m) => m.startTriggerScheduler())
  })
  // 服务器性能监控采样器：喂给 /api/system（侧栏常驻卡片）
  run('system-monitor', () => {
    void import('./services/system-monitor').then((m) => m.startSystemMonitor())
  })
  // SSH 隧道：把配了「服务启动后自动拉起」的隧道起起来（错开 300ms，失败只落在各自状态里）。
  //
  // ⚠️ 隧道监听的是**跑 server 的这台机器**的端口，所以这件事必须由 server 侧做、
  // 而且必须跟着 server 的生命周期（桌面端进程内后端同样会调到这一份）。
  run('tunnels', () => {
    void import('./ssh/tunnels').then((m) => m.autoStartTunnels())
  })
  // 工作区目录巡检：登记的目录被删 / 被移走时标上 `dirMissing`（侧栏变红 + 禁新建会话）
  run('workspace-health', () => {
    void import('./workspace-health').then((m) => m.startWorkspaceHealthWatch())
  })
  // 容器型项目 · 公网入口：独立监听 `FIZZ_PUBLIC_HTTP_PORT`，把 `<slug>.<域名>` 反代到预览
  // 端口（端口没配 = `0` 就整体不启用、不报错）。与隧道同一理由——它监听的是**跑 server
  // 这台机器**的端口，所以必须跟着服务生命周期，桌面端的进程内后端也一样。
  run('container-public-gateway', () => {
    void import('./container-projects/public-gateway').then((m) => m.startPublicGateway())
  })
  // 容器型项目 · 孤儿容器清扫：删项目那次如果 docker 没起来（Windows 上很常见），容器会留下
  // 而记录已经摘了 —— 界面上再也看不见它（快照按工作区遍历），它却还占着端口与内存。
  // 启动时按 label 扫一遍、只清「本实例目录下、且确实没有项目记录」的那些。
  run('container-sweep', () => {
    void import('./container-projects/purge').then((m) => m.sweepOrphanContainers())
  })
  // 浏览器引擎配置：把持久化 profile 落到数据目录下（登录态活得过会话重启）。
  // desktop / web 共享同一份后端代码，这里一处配置两者都生效。
  //
  // 来源（channel）已经没有选项了（`normalizeBrowserSettings` 恒为 `bundled`），这里直接给
  // 常量；传函数是引擎的契约（每次 start() 现取），保留形态，别改成静态值。
  run('browser', () => {
    void import('@fizz/tools').then((m) =>
      m.configureBrowser({
        profilesRoot: join(resolveDataDir(), 'browser-profiles'),
        channel: () => DEFAULT_BROWSER_SETTINGS.channel
      })
    )
  })
}

/**
 * 停掉后台维护（退出钩子 / 桌面端 `BackendManager.stop()` 用）。逐个尽力停，不抛。
 */
export async function stopBackgroundServices(): Promise<void> {
  try {
    const [{ stopTriggerScheduler }, { stopSystemMonitor }, { stopWorkspaceHealthWatch }] =
      await Promise.all([
        import('./scheduler'),
        import('./services/system-monitor'),
        import('./workspace-health')
      ])
    await stopTriggerScheduler(3_000)
    stopSystemMonitor()
    stopWorkspaceHealthWatch()
    // 隧道：每条都持有真实 socket（本地监听 + SSH 连接），不关会拖着进程不退出
    const { stopAllTunnels } = await import('./ssh/tunnels')
    stopAllTunnels()
    // 容器型项目：公网入口监听器（独立端口，`FIZZ_PUBLIC_HTTP_PORT`）
    const { stopPublicGateway } = await import('./container-projects/public-gateway')
    stopPublicGateway()
    // 会话钩子：退订全局事件总线并回收长驻插件 context（通知插件的监听器一并摘掉）
    const { stopConversationHooks } = await import('./conversation-hooks')
    await stopConversationHooks()
  } catch (err) {
    console.error('[background] 停止后台服务失败：', err)
  }
}
