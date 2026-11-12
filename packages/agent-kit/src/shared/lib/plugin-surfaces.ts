/**
 * 插件界面清单的小 store（模块级 + `useSyncExternalStore`）。
 *
 * 为什么不进 zustand：这份数据只服务「图标栏 / 侧栏 / 标签条」这几处，而且**换项目要重拉**
 * （项目级插件也能提供界面）。放进全局 store 就得为它加一个 slice、一份刷新时序，
 * 而它根本不需要与对话 / 连接那些状态互相感知 —— 本地模块级 store 更合适，
 * 与 `activity-state` / `panel-store` 同一取舍。
 *
 * 拉不到清单**静默**：没有插件界面是很常见的状态，不该弹一个错误打扰用户。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PluginSurfaceView } from '@fizz/contracts/agent-api'
import { retainPluginClients } from '@fizz/agent-kit/features/plugins/plugin-client'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

let surfaces: PluginSurfaceView[] = []
const listeners = new Set<() => void>()

/** 正在飞的那一批（同一个 workspaceId 的重复请求共用一次，别打两遍） */
let inflight: Promise<void> | null = null
let inflightKey: string | null = null

/**
 * 最近一次取用的目标 —— 窗口重新获得焦点时据此重拉（见文件末尾的 `revalidate`）。
 *
 * ⚠️ 这份 store 是**模块级**的，一个 JS 上下文一份。而**桌面端的设置是独立窗口**
 * （`apps/desktop/src/renderer/app/SettingsWindow.tsx`，自己一份 `AppProvider`）：
 * 在设置窗口里启停插件，改的是**它那个上下文**里的 `surfaces`；主窗口的插件列表读的是
 * 另一份，永远不会知道 —— 用户实测现象就是「在设置里停用 redis，插件列表里那一行还在；
 * 点它一下才消失」（点它 → 标签页在主窗口挂载 → 主窗口这边终于拉了一次）。
 *
 * 同一条道理也覆盖浏览器的另一个标签页、以及手机端改了启停的情况。
 */
let lastTarget: { app: AgentApp | null; workspaceId?: string } = { app: null }
/** 上次拉取结束的时间（焦点重拉做节流：来回切窗口不该每次都重扫一遍插件目录） */
let lastLoadedAt = 0
const FOCUS_REVALIDATE_MS = 1000
/** 请求代次：只认最后发出的那一次，旧响应后到就丢掉（见 `loadPluginSurfaces`） */
let requestSeq = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): PluginSurfaceView[] {
  return surfaces
}

export function getPluginSurfaces(): PluginSurfaceView[] {
  return surfaces
}

/** 拉一次清单（同一目标已在飞就复用；换项目会另起一次） */
export function loadPluginSurfaces(app: AgentApp | null, workspaceId?: string): Promise<void> {
  const api = app?.api
  if (!api) return Promise.resolve()
  const key = workspaceId ?? ''
  if (inflight && inflightKey === key) return inflight
  // 焦点重拉会打断在飞的那一批（`inflight` 被清空），因此旧响应后到时不能覆盖新的
  const seq = ++requestSeq
  lastTarget = { app, workspaceId }
  inflightKey = key
  inflight = api
    .listPluginSurfaces(workspaceId)
    .then((result) => {
      if (seq !== requestSeq) return
      surfaces = result?.surfaces ?? []
      /*
       * 清单变了就顺手回收前端半：停用 / 卸载的插件不能继续留着定时器、连接和注入的 CSS。
       * 放在这里而不是各宿主组件里，是因为**这份 store 是清单的唯一入口**；
       * 让图标栏、侧栏、标签条各清一遍，一定会漏一个。
       */
      retainPluginClients(
        new Set(
          surfaces
            .filter((item) => item.renderMode === 'client')
            .map((item) => item.pluginId)
        )
      )
      emit()
    })
    .catch(() => {
      /* 清单拿不到 = 没有插件界面（或服务端还没就绪）：静默，界面上就是没有那些项 */
    })
    .finally(() => {
      if (seq !== requestSeq) return
      inflight = null
      inflightKey = null
      lastLoadedAt = Date.now()
    })
  return inflight
}

/** 强制重拉（插件文件改完 / 刚启用一个插件时用） */
export function refreshPluginSurfaces(app: AgentApp | null, workspaceId?: string): void {
  inflight = null
  inflightKey = null
  void loadPluginSurfaces(app, workspaceId)
}

/**
 * 取清单（首次渲染是空的，拉回来后自动更新）。
 *
 * ⚠️ **依赖里只能放 `app.api`，绝不能放 `app` 对象本身** —— 这是本文件最容易踩的坑：
 * `agentAppFrom` 每次调用都**新建一个字面量对象**（`return { … }`，没有 memo），
 * `AppProvider` 又订阅了**整个 store**（`useAgentStore()` 不带选择器）—— 清单类状态
 * 每变一次（会话标题、工作区、连接…），`app` 就是**新引用**。把 `app` 放进 deps，
 * effect 就会跟着那些无关变化重跑，`loadPluginSurfaces` 反复发
 * `GET /api/plugins/surfaces`：控制台里刷屏的 `GET /api/plugins/surfaces → 200 2ms`
 * 以及它顺带触发的插件配置告警，都是这么来的（用户实测反馈「一轮还没结束就一直在刷」）。
 * `api` 本身是稳定的（`s.getApi()` 有缓存），拿它当依赖既准确又不会抖。
 *
 * `workspaceId` 是原始字符串，按值比较，没问题。
 */
/**
 * 窗口重新拿回焦点时重拉一次清单。
 *
 * 这是「在别处改了插件启停，这边立刻跟上」的唯一低成本通道：跨窗口（桌面端设置窗口 /
 * 另一个浏览器标签页 / 手机端）没有任何前端事件能传过来，但「用户把窗口切回来」这件事
 * 一定发生 —— 而他要看活动栏，就得先切回来。
 *
 * 用 `lastTarget` 重拉而不是让每个 `usePluginSurfaces` 各自注册：这份 store 有几个宿主
 * （图标栏 / 侧栏 / 标签条），各注册一遍就是一次焦点发好几个同样的请求。
 * `FOCUS_REVALIDATE_MS` 节流掉「来回切窗口」的连续重扫。
 */
function revalidateOnFocus(): void {
  if (!lastTarget.app?.api) return
  if (Date.now() - lastLoadedAt < FOCUS_REVALIDATE_MS) return
  refreshPluginSurfaces(lastTarget.app, lastTarget.workspaceId)
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', revalidateOnFocus)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidateOnFocus()
  })
}

export function usePluginSurfaces(app: AgentApp | null, workspaceId?: string): PluginSurfaceView[] {
  /*
   * 先把 app 收成它里面**稳定**的那一小块再当依赖。
   *
   * 不用 `[app?.api]` 直接写进依赖数组：`app` 为 null 时那是 `undefined`，
   * 而 eslint 的 exhaustive-deps 认的是「表达式里用到的 `app`」—— 写成变量更直白，
   * 也避免将来有人「顺手」把依赖改回 `app`。
   */
  const api = app?.api
  useEffect(() => {
    void loadPluginSurfaces(api ? app : null, workspaceId)
  }, [api, workspaceId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
