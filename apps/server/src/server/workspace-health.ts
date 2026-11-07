/**
 * 工作区目录巡检：登记表里的 `path` 被删 / 被移走时，把 `dirMissing` 标上。
 *
 * 为什么需要它：工作区注册表（`agent-core.json`）只在 `addWorkspace` 那一刻 stat 过磁盘，
 * 之后**再也不复查** —— 目录被删了，记录照旧在、界面照旧像没事一样，直到用户去新建会话才撞错。
 *
 * 为什么不需要前端配合：工作区清单本来就由服务端经 state ws 推快照
 * （`makeLiveStore` 在每次 `mutate` 后 `markDirty(['workspaces', …])`），这里 mutate 一下，
 * 所有端立刻收到 —— 前端一行不用改，也不需要客户端轮询（与本仓「不轮询」的约定一致）。
 *
 * 判定：`path` 非空的登记项逐个探测。`path` 为空的虚拟工作区（「任务」/「项目助手」）跳过。
 *
 * 远端工作区（`remote.hostId`）走 SFTP stat，判据比本地多两条：
 * 1. **主机不可达 ≠ 目录没了**：网络 / 认证错误直接跳过这一轮，不改标记；
 * 2. **连续两轮确认不存在才置位**：远端 stat 偶尔会因瞬断返回 ENOENT，一次就把项目
 *    标红会让用户以为目录被删了。
 */
import { isRemoteWorkspace } from '@fizz/contracts/types'
import { domain } from './state'
import { sftpService } from './ssh/sftp'

/** 巡检周期。目录被删不是急事，30s 足够「自动」；代价是一轮遍历 + N 次 stat */
const INTERVAL_MS = 30_000

let timer: NodeJS.Timeout | null = null
/** 防重入：一轮还没跑完（stat 慢 / 工作区多）时别把下一轮叠上来 */
let sweeping = false
/** 远端工作区连续确认「不存在」的次数（成功 / 不可达都会清零） */
const remoteMisses = new Map<string, number>()

/** 一次探测的结论：在 / 不在 / 问不到（远端不可达，不改状态） */
type Probe = boolean | null

async function probe(workspace: {
  id: string
  path: string
  remote?: { hostId: string }
}): Promise<Probe> {
  if (!isRemoteWorkspace(workspace)) return domain.isWorkspaceDirAvailable(workspace.path)
  try {
    const stat = await sftpService.stat(workspace.remote!.hostId, workspace.path)
    return stat?.type === 'dir'
  } catch {
    return null
  }
}

/** 跑一轮：只把**变化**写回 store（见 `domain.markWorkspaceDirMissing` 的注释） */
async function sweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    for (const workspace of domain.listWorkspaces()) {
      if (!workspace.path) continue
      const ok = await probe(workspace)
      // 远端主机连不上：这一轮不表态，保留上一轮结论
      if (ok === null) {
        remoteMisses.delete(workspace.id)
        continue
      }
      if (ok) {
        remoteMisses.delete(workspace.id)
      } else if (isRemoteWorkspace(workspace)) {
        const misses = (remoteMisses.get(workspace.id) ?? 0) + 1
        remoteMisses.set(workspace.id, misses)
        if (misses < 2) continue
      }
      if (domain.markWorkspaceDirMissing(workspace.id, !ok)) {
        console.warn(
          `[workspace-health] ${ok ? '目录已恢复' : '目录不存在'}：${workspace.path}（${workspace.name}）`
        )
      }
    }
  } finally {
    sweeping = false
  }
}

/**
 * 启动巡检（幂等）。先**立刻**扫一遍：否则重启后要等一个周期才发现目录已被删，
 * 而「刚启动」恰恰是最容易发现问题的时刻（关机期间目录被删是常见情形）。
 */
export function startWorkspaceHealthWatch(): void {
  if (timer) return
  void sweep().catch((err: unknown) => console.error('[workspace-health] 首次巡检失败：', err))
  timer = setInterval(() => {
    void sweep().catch((err: unknown) => console.error('[workspace-health] 巡检失败：', err))
  }, INTERVAL_MS)
  // 别让这个定时器把进程钉住（与 system monitor 同款）
  timer.unref?.()
}

export function stopWorkspaceHealthWatch(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}