/**
 * 定时任务的状态管理（「什么时候自动起一个会话」：cron / 一次性）。
 *
 * 与 `useAgentApp`（对话那一套）**刻意分开**：定时任务在服务端是独立的一组路由，
 * 混进一个 hook 只会让两边互相干扰。
 *
 * 数据更新：全局状态 WS 推送 `taskTriggers` 域；首次进来先拉一次全量，
 * 之后服务端改了就推，前端不再轮询。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { TaskTrigger, TaskTriggerInput } from '@fizz/contracts/types'
import type { AgentApi } from '@fizz/agent-client/api'
import { initStateClient, subscribe, getSnapshot } from '@fizz/agent-kit/shared/lib/state-ws'

export interface TriggersState {
  api: AgentApi | null
  /** 全量（面板按归属分组展示时自己筛；不绑工作区的那些也在里面） */
  list: TaskTrigger[]
  loading: boolean
  busy: boolean
  refresh: () => Promise<void>
  saveTrigger: (input: TaskTriggerInput) => Promise<boolean>
  deleteTrigger: (id: string) => Promise<void>
  toggleTrigger: (id: string, enabled: boolean) => Promise<void>
  /** 手动跑一次（服务端异步派发，只等「已受理」） */
  runTrigger: (id: string) => Promise<void>
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useTriggers(api: AgentApi | null): TriggersState {
  const [triggers, setTriggers] = useState<TaskTrigger[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return
    setLoading(true)
    try {
      setTriggers(await api.listTaskTriggers())
    } catch (err) {
      toast.error(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [api])

  // 打开应用就先来一遍全量：侧栏的定时任务分组在对话视图下也要有数据
  useEffect(() => {
    if (!api) return
    void refresh()
  }, [api, refresh])

  // 全局状态 WS：连上后先收到 `init` 全量快照，之后有变更只推 `taskTriggers`
  useEffect(() => {
    initStateClient()
    const applyTriggers = () => setTriggers(getSnapshot<TaskTrigger[]>('taskTriggers') ?? [])
    applyTriggers()
    return subscribe('taskTriggers', applyTriggers)
  }, [])

  const run = useCallback(
    async <T,>(action: () => Promise<T>, onDone?: (value: T) => void): Promise<boolean> => {
      setBusy(true)
      try {
        const value = await action()
        onDone?.(value)
        return true
      } catch (err) {
        // 报错统一走 toast（弹窗里不再有内联错误区，见 `TriggerEditDialog`）
        toast.error(messageOf(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const saveTrigger = useCallback(
    async (input: TaskTriggerInput): Promise<boolean> => {
      // 成功后直接用回包改本地，不等全局 WS 推送 —— 开关这类操作要有即时手感
      let saved: TaskTrigger | undefined
      const ok = await run(
        () => api!.saveTaskTrigger(input),
        (trigger) => {
          saved = trigger
          setTriggers((prev) => [...prev.filter((t) => t.id !== trigger.id), trigger])
        }
      )
      if (!ok && !saved) void refresh()
      return ok
    },
    [api, run, refresh]
  )

  const deleteTrigger = useCallback(
    async (id: string): Promise<void> => {
      await run(
        () => api!.deleteTaskTrigger(id),
        () => setTriggers((prev) => prev.filter((t) => t.id !== id))
      )
    },
    [api, run]
  )

  const toggleTrigger = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      // 先本地翻转再发请求：开关点下去必须立刻动，否则弱网下像是没点上
      setTriggers((prev) => prev.map((t) => (t.id === id ? { ...t, enabled } : t)))
      await run(
        () => api!.setTaskTriggerEnabled(id, enabled),
        (trigger) => setTriggers((prev) => prev.map((t) => (t.id === id ? trigger : t)))
      )
    },
    [api, run]
  )

  const runTrigger = useCallback(
    async (id: string): Promise<void> => {
      // 服务端只回「已受理」：会话是异步起的，成功提示由调用方（面板）负责。
      // 失败提示已在 `run()` 里 toast 过，这里抛出去只是让调用方**别再弹「已开始」**。
      const ok = await run(() => api!.runTaskTrigger(id))
      if (!ok) throw new Error('run rejected')
    },
    [api, run]
  )

  /**
   * 返回对象按字段记稳：它挂在 `AppContext` 的值上，现场造字面量会让**所有**消费
   * `useAppContext()` 的组件跟着 `AppProvider` 每次重渲一起重渲（流式期间就是每帧）。
   */
  return useMemo(
    () => ({
      api,
      list: triggers,
      loading,
      busy,
      refresh,
      saveTrigger,
      deleteTrigger,
      toggleTrigger,
      runTrigger
    }),
    [api, triggers, loading, busy, refresh, saveTrigger, deleteTrigger, toggleTrigger, runTrigger]
  )
}
