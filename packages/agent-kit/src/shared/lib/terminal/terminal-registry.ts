/**
 * 渲染端**终端登记表**：把「用户正在看的终端」暴露给 AI 工具层。
 *
 * ## 为什么需要它（而不是服务端直接操作终端）
 *
 * 终端进程在**服务端**（SSH 会话 / 本机 PTY），但服务端**没有活会话注册表** ——
 * 会话 id 是每次连接现生成的，只绑在自己那条 WebSocket 上，服务端拿不到「用户现在
 * 看着的是哪台终端」。而渲染端两样都有：xterm 实例（滚动缓冲）+ `TerminalProcess`
 * （写入口）。所以「AI 操作终端」这件事由**渲染端**执行，登记表就是那个入口。
 *
 * ## 只活在内存里
 *
 * 与 `tool-tabs.ts` 同一口径：这是「这一次打开的样子」，刷新即空。`TerminalPanel`
 * 在挂载时登记、卸载时摘掉（见那里的 effect）。
 */
import type { TerminalProcess } from '@fizz/agent-client/host'

export interface TerminalHandle {
  /** 主区域标签 key（`host:<id>#<seq>` / `local:<n>`），也是工具里的 `sessionId` */
  tabKey: string
  /** 展示名（标签名 / 主机名） */
  title: string
  /** ssh = 远端主机终端；local = 本机终端；container = 容器工作台 */
  kind: 'ssh' | 'local' | 'container'
  /** 读最近输出（含滚动缓冲），返回已剥掉 ANSI 控制序列的纯文本 */
  read(maxChars?: number): string
  /** 把原始输入写进 PTY（等同于用户在键盘上敲） */
  write(data: string): void
  /**
   * 把键盘焦点落到这条终端上（光标进 xterm，用户可以接着敲）。
   *
   * 给「命令面板就地跑完脚本」这类**替用户发起了动作**的入口用：动作结束后焦点该回到
   * 用户刚才待着的地方，而不是留在已经关掉的弹窗 / body 上。时机（要不要等弹窗退场）
   * 由调用方决定，见 `features/scripts/run-script-command.ts`。
   */
  focus(): void
  /** 底层进程是否还活着（false = 已退出，工具该拒绝而不是静默丢弃） */
  isAlive(): boolean
  /**
   * 输出活动计数：每收到一段 PTY 数据 +1（含命令回显）。
   *
   * 给 `run_in_terminal` 判「这条命令还在往外吐东西吗」用 —— 轮询只读这个数，
   * 不去 `read()` 整段缓冲（那个是 O(缓冲长度)，大缓冲上每 100ms 读一遍并不便宜）。
   */
  outputSeq(): number
  /**
   * 最后一次收到输出的时间（`Date.now()` 毫秒；这条终端还没输出过 = 0）。
   *
   * 与 {@link outputSeq} 一起构成「安静了多久」这个信号：输出停下来就是命令大概率跑完了，
   * 比固定 sleep 一个猜的时长准得多。
   */
  lastOutputAt(): number
  /**
   * 累计输出偏移：这条终端**建立以来收到的全部输出**的字符数（含已经滚出屏幕 / 缓冲的部分）。
   *
   * 与 {@link outputSeq} 分工：seq 只回答「还在不在动」，offset 用来取「从那之后的新输出」。
   *
   * ⚠️ 取增量**必须**用它，不能拿 xterm 缓冲的长度做差：滚动缓冲只有 1000 行，长任务
   * 几秒就顶满，之后长度不再增长（旧行被顶掉），按长度做差得到的是无意义的碎片 ——
   * 工具回一句「没捕获到新输出」，模型就会连读（用户看到的「快速不停地读取」）。
   */
  outputOffset(): number
  /**
   * 取 `since`（一次 {@link outputOffset} 的返回值）之后收到的输出，已剥掉 ANSI、
   * `\r` 统一成换行。
   *
   * `truncated: true` = 起点已经滚出环形缓冲，返回的是**还能拿到的那部分**（调用方
   * 据此告诉模型「前面丢了」）；`offset` 是取完之后的累计偏移，可以直接作为下一次的 `since`。
   */
  readSince(since: number): { text: string; offset: number; truncated: boolean }
}

const terminals = new Map<string, TerminalHandle>()
/** 最近一次「被看着」的终端（`visible` 的 TerminalPanel 自报）—— 全局助手的目标缺省 */
let activeTabKey: string | null = null

export function registerTerminal(handle: TerminalHandle): void {
  terminals.set(handle.tabKey, handle)
}

export function unregisterTerminal(tabKey: string): void {
  terminals.delete(tabKey)
  // 连接状态跟着句柄一起走：标签关掉 / 终端卸载之后，标签条上不该再挂一个点
  clearTerminalStatus(tabKey)
  if (activeTabKey === tabKey) activeTabKey = null
}

export function getTerminal(tabKey: string): TerminalHandle | undefined {
  return terminals.get(tabKey)
}

/** 列出所有登记在册的终端（工具 `list_terminal_sessions` 用） */
export function listTerminals(): TerminalHandle[] {
  return [...terminals.values()]
}

/**
 * 按标签 key 取一条**可以往里写**的终端：登记在册 + 不是容器 + 进程还活着。
 *
 * 给「命令面板就地运行脚本」用（见 `features/scripts/run-script-command.ts`）：那个入口
 * 的语义是「**当前视图就是终端，脚本直接在这条终端里跑**」，所以它要的不是「某台主机
 * 有没有终端」，而是「顶在这一格的那条终端还能不能写」。
 *
 * 三条拒绝的理由：
 * - 没登记 = 那条标签还没有 `TerminalPanel` 实例（或在别的设备上开着），写进去会静默丢；
 * - `container` = 容器工作台那条纯文本通道，脚本是「主机侧」的东西，写错地方比不写更糟；
 * - `isAlive()` 为假 = 进程已退出 / 正在重连，写进去没人接。
 *
 * ⚠️ 这里**不判断「终端忙不忙」**：xterm 侧看不出远端前台进程，靠输出活跃度猜会误判
 * （`tail -f`、构建日志都在刷）。活着就写 —— 用户看得见那条终端正在显示什么。
 */
export function liveTerminal(tabKey: string | null | undefined): TerminalHandle | null {
  if (!tabKey) return null
  const handle = terminals.get(tabKey)
  if (!handle || handle.kind === 'container' || !handle.isAlive()) return null
  return handle
}

/**
 * 把键盘焦点落到某条终端上（那条终端没登记 = 什么都不做）。
 *
 * 只负责「调一下句柄」这一件事：**什么时候**落焦点是调用方的判断 —— 命令面板那种
 * Radix 对话框会在退场结束后把焦点还给「打开前的元素」，太早落会被它拿走，
 * 所以那里还得补一拍（见 `features/scripts/run-script-command.ts`）。
 */
export function focusTerminal(tabKey: string): void {
  terminals.get(tabKey)?.focus()
}

/** 某条终端自报「我现在被看着」（可见性变化时调用） */
export function setActiveTerminal(tabKey: string | null): void {
  activeTabKey = tabKey
}

export function getActiveTerminalTabKey(): string | null {
  return activeTabKey
}

/**
 * 解析一次工具调用的目标终端：**显式指定 > 本轮绑定 > 当前被看着的那条**。
 *
 * 与 dogi 的 `resolveTarget` 同一条优先级；差别是这里没有服务端的「活跃会话」，
 * 只有渲染端的「被看着的那条」。
 */
export function resolveTerminal(
  boundTabKey: string | null | undefined,
  explicitSessionId?: string
): TerminalHandle | null {
  const key = explicitSessionId || boundTabKey || activeTabKey
  if (!key) return null
  return terminals.get(key) ?? null
}

/** 终端进程类型（工具里回给模型看，用于判断命令语法） */
export function kindLabel(kind: TerminalHandle['kind']): string {
  if (kind === 'ssh') return 'SSH 远端主机'
  if (kind === 'container') return '容器工作台'
  return '本机'
}

/** 供 TerminalPanel 复用：把一个 `TerminalProcess` 包成写入口 */
export function writeVia(process: TerminalProcess | null): (data: string) => void {
  return (data: string) => process?.write(data)
}

// ---------------------------------------------------------------------------
// 连接状态（标签条上的黄 / 绿 / 红点）
// ---------------------------------------------------------------------------

/**
 * 一条终端的**可订阅**连接状态。
 *
 * ## 为什么不能直接读 `isAlive()`
 *
 * 句柄上的 `isAlive()` 是**拉取式**的：它回答「此刻还活着吗」，但进程退出**不会通知任何人**。
 * 标签条要的是「退出那一刻把绿点换成红点」，靠轮询只能得到一个永远不更新的界面。
 * 所以这里单独存一份由 `TerminalPanel` 推上来的状态，并附一个自增版本号供
 * `useSyncExternalStore` 订阅（机制与 `tool-tabs.ts` 的版本号完全一致）。
 *
 * ## 三个阶段，别退回两态
 *
 * `alive` 只说明「进程对象建出来了」，**不等于连上了**：SSH 还要握手 / 认证 / 起 shell，
 * web 端的本机终端还要等 WS 建连 + 服务端 spawn，慢的时候好几秒。这期间标签条若直接
 * 显示绿点，用户会以为已经能敲命令（用户报过「在连接中却是绿的」）。所以分三段：
 *
 * - `connecting` → 黄点：会话 effect 一开就跑，直到真正就绪；
 * - `alive`      → 绿点：SSH 收到 `ready` 帧，或本机终端来了首帧输出（shell 起来了）；
 * - `exited`     → 红点：shell 没了 / 建连失败 / 用户取消，等按 Enter 重连。
 *
 * 「就绪」那两个信号与 `TerminalPanel` 里收起连接进度卡片、补写脚本的条件**完全同一处**
 * （同一次 `settleConnect`），不是另算一套口径。
 *
 * ## 只有主区域标签有
 *
 * 写入点是 `TerminalPanel` 里**有 `tabKey`** 的那条会话 effect（侧栏 / 容器工作台的终端
 * 不传 `tabKey`，也就不写）—— 与 `registerTerminal` 同一条边界：只标「用户眼前那些标签」。
 *
 * 语义是**连接级**的，不是「命令跑没跑完」：xterm 侧看不出远端前台进程，靠输出活跃度猜
 * 会误判（`tail -f`、构建日志都在刷），这里不做那个猜测（同 `liveTerminal` 的说明）。
 */
export type TerminalPhase = 'connecting' | 'alive' | 'exited'

export interface TerminalStatus {
  phase: TerminalPhase
}

const statuses = new Map<string, TerminalStatus>()
let statusVersion = 0
const statusListeners = new Set<() => void>()

function statusChanged(): void {
  statusVersion += 1
  for (const listener of statusListeners) listener()
}

/**
 * 写入连接状态（建连 / 就绪 / 退出时由 `TerminalPanel` 调）。
 *
 * 值没变就**不通知**：会话 effect 重建、重复上报都不该让整条标签条重渲染
 * （`ready` 与首帧输出会各报一次 `alive`，重复是有意的）。
 */
export function setTerminalPhase(tabKey: string, phase: TerminalPhase): void {
  const prev = statuses.get(tabKey)
  if (prev && prev.phase === phase) return
  statuses.set(tabKey, { phase })
  statusChanged()
}

/** 摘掉状态（标签关闭 / 终端卸载）：没有条目 = 标签条不画点 */
export function clearTerminalStatus(tabKey: string): void {
  if (!statuses.delete(tabKey)) return
  statusChanged()
}

/** 读一条终端的连接状态（没登记过 = `undefined`，标签条据此不画点） */
export function getTerminalStatus(tabKey: string): TerminalStatus | undefined {
  return statuses.get(tabKey)
}

/** 订阅连接状态变化（`useSyncExternalStore` 的 subscribe） */
export function subscribeTerminalStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** 状态版本（`useSyncExternalStore` 的 getSnapshot；没订阅时也得是稳定值） */
export function getTerminalStatusVersion(): number {
  return statusVersion
}
