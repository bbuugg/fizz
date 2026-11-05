/**
 * 传输 slice：SFTP 上传 / 下载任务的现场（全局传输清单的唯一数据源）。
 *
 * **为什么放全局 store 而不是组件里**：传输必须活得比发起它的组件长 —— SFTP 面板关掉、
 * 切到别的标签、甚至整个面板被回收，传输都要继续跑并继续被看见。所以状态在这里，
 * 引擎是模块级的（`shared/lib/file-transfer/engine.ts`），两边都不绑组件生命周期。
 *
 * ⚠️ **不持久化**（不进 `localStorage`）：活跃传输绑在**进程**上，刷新页面后它本来就断了
 * ——留一条永远「进行中」的假记录比清掉更糟。
 *
 * ⚠️ 取消用的 `AbortController` **不进这里**，在引擎的模块级 `Map` 里：store 里放函数 /
 * AbortController 会破坏可序列化，也让它出现在 devtools 快照里变得没法看。
 *
 * ⚠️ slice 文件只允许 `import type { AgentStore }`（类型反向引用，编译期擦除）；
 * 运行时反向 import 会成环。
 */
import type { StateCreator } from 'zustand'
import type { AgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'

export interface TransferTask {
  id: string
  kind: 'upload' | 'download'
  hostId: string
  /** 主机显示名：清单里要能区分「这是传到哪台机器」 */
  hostLabel: string
  /** 展示名（上传 = 本地文件名；下载 = 远端文件名） */
  name: string
  /** 上传 = 目标 dir/name；下载 = 源 path */
  remotePath: string
  /** 总字节；0 = 未知 → 进度条走不确定态 */
  size: number
  done: number
  status: 'active' | 'done' | 'failed' | 'canceled'
  error?: string
  /** 下载落盘后的本地路径（桌面端「打开文件位置」用；web 攒 Blob 时没有） */
  localPath?: string
  startedAt: number
  endedAt?: number
  /** 字节/秒，滑动窗口采样 */
  speed: number
}

export interface TransferSlice {
  /** 全部传输任务，按加入顺序（清单直接按这个顺序渲染） */
  transfers: TransferTask[]
  addTransfer: (task: TransferTask) => void
  /**
   * 浅合并一字段（进度 / 速度用）。
   *
   * ⚠️ **只动这一条**：`map` 出来的是新数组，但没被 patch 的条目保持同一个对象引用，
   * 于是清单里其他行不会跟着重渲染。
   */
  patchTransfer: (id: string, patch: Partial<TransferTask>) => void
  /** 收场：写终态 + `endedAt`。已结束的任务不再被 `patchTransfer` 改动（见下） */
  settleTransfer: (
    id: string,
    status: 'done' | 'failed' | 'canceled',
    opts?: { error?: string; localPath?: string }
  ) => void
  removeTransfer: (id: string) => void
  /** 清掉所有已结束（done / failed / canceled）的行；进行中的不动 */
  clearFinishedTransfers: () => void
}

export const createTransferSlice: StateCreator<AgentStore, [], [], TransferSlice> = (set) => ({
  transfers: [],

  addTransfer: (task) => {
    set((state) => ({ transfers: [...state.transfers, task] }))
  },

  patchTransfer: (id, patch) => {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        /**
         * ⚠️ 已结束的任务**不再接受 patch**。取消与「最后一片恰好成功」会赛跑：abort 先
         * settle 成 `canceled`，随后那片请求的应答才回来写 `done` —— 不挡住的话，清单上
         * 会出现「已取消」的行自己跳成 100%。用户点了取消就该停在取消。
         */
        t.id === id && t.status === 'active' ? { ...t, ...patch } : t
      )
    }))
  },

  settleTransfer: (id, status, opts) => {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id
          ? {
              ...t,
              status,
              endedAt: Date.now(),
              // 收场时速度归零：停在半截的瞬时值看着像还在跑
              speed: 0,
              ...(opts?.error !== undefined ? { error: opts.error } : {}),
              ...(opts?.localPath !== undefined ? { localPath: opts.localPath } : {})
            }
          : t
      )
    }))
  },

  removeTransfer: (id) => {
    set((state) => ({ transfers: state.transfers.filter((t) => t.id !== id) }))
  },

  clearFinishedTransfers: () => {
    set((state) => ({ transfers: state.transfers.filter((t) => t.status === 'active') }))
  }
})
