/**
 * 容器型项目的**门**与**启动态界面**。
 *
 * 这类项目「打开时容器还没跑」是常态（用户上次可能手动停过、或服务重启前就没起），所以在它
 * 进入对话/终端之前要先过一道门：`ContainerProjectGate` 只负责**按状态分流** —— 只有容器
 * `running` 了才把 `children` 渲染出来；否则显示 `ContainerStartupView` 这张状态卡片
 * （状态明细 / 阶段进度 / 构建日志 / 错误与重试）。
 *
 * ⚠️ **门挂在「标签内容」里，不套在多标签面板外面**（`ContainerTabGate`）：主区域是多标签的
 * （`PanelView`），把门套在整块面板上时，容器一停就**连标签条一起顶掉** —— 用户看不到、
 * 也切不了别的标签（用户报过「容器状态覆盖了全部标签页」）。现在门下沉到每个标签的内容层：
 * 标签条照常可用，只有**属于那个容器项目**的标签，其内容换成卡片；别的项目的对话 / SSH 终端 /
 * 接口 / 笔记一律照旧。
 *
 * ⚠️ **`stopping` 不是 `running`**：`docker stop` 有 5s 优雅退出窗口，这期间容器在
 * `docker ps` 里仍是 Up，但用户已经点了停止 —— 门必须收起对话面板、卡片写「停止中」，
 * 否则用户点了停止还停在对话里，看着像没停成（用户报过）。
 *
 * ⚠️ **打开项目不自动启动容器**：起停都由用户决定（卡片上的「启动 / 重试」，或侧栏项目菜单的
 * 「容器状态 → 启动容器」）。以前这里挂载时会对 `stopped` 发一次启动，用户报过「只是切到会话，
 * 过一会容器自己起来了」—— 白白占内存，也让「停止」变成一次性的。
 *
 * ⚠️ **卡片只在快照到手后才有意义**（`pending` = 还没有）：快照没到时不能下任何结论，
 * 否则「还不知道」会被当成「没在运行」，用户看到的是一个停在「容器没有运行」的卡片，
 * 底下其实正在启动。
 * ⚠️ 门挂在 `PanelView` 的**标签内容层**（`ContainerTabGate`），**按标签自己所属的工作区**
 * 判定，不读「当前工作区」：标签可以来自别的工作区（面板不随切工作区清空），拿当前工作区判
 * 会把普通项目的对话标签也顶成容器卡片。普通项目逐字不变（`container` 字段缺省 = 直接放行）。
 */
import { useState, type ReactNode } from 'react'
import { Box, Check, ChevronDown, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import type {
  AgentWorkspace,
  ContainerProjectsSnapshot,
  ContainerProjectState
} from '@fizz/contracts/types'
import { Button } from '@fizz/ui/button'
import { SpinnerButton } from '@fizz/ui/spinner-button'
import { useStateSnapshot } from '@fizz/agent-kit/shared/lib/state-ws'
import { useTabConversation } from '@fizz/agent-kit/shared/lib/panel-store'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/**
 * 哪些状态才允许渲染 children（多标签面板）。
 *
 * **只有 `running`**：`stopping` 看着「容器还在」，但用户已经点了停止，这一刻起就不该再
 * 让人在里面发消息（容器随时会消失）。`starting` / `error` / `stopped` 同理。
 */
export const CONTAINER_RUNNING_STATES: ReadonlyArray<ContainerProjectState['state']> = ['running']

/**
 * 启动阶段（与服务端 `lifecycle.ts` 的 `Phase` 一一对应）。
 *
 * 第一行是「检测容器状态」，对应服务端的 `prepare`：用户点了启动之后，服务端要先探 docker、
 * 读现有容器、比对形状，这段可能真的慢（dockerd 卡住时一条 `docker ps` 要好几秒）。以前
 * 它**不占阶段**，快照于是停在 `stopped`，界面还是那句「容器没有运行」—— 看着像点了没反应，
 * 其实后台已经在起了（用户报过）。现在它是第一个阶段，点了立刻「在动」。
 *
 * 它**只在用户真的发起启动后出现**：`ensureContainerAgentReady` 那条按需拉起的路走
 * `startContainerProject(..., { quiet: true })`，**不置这个阶段**，否则每发一条消息都会
 * 先闪一下「检测容器状态」的启动页（用户报过）。真需要冷启动时服务端会在动手那一刻
 * 直接置 `image`，进度不会丢。
 */
const PHASES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'prepare', label: '检测容器状态' },
  { id: 'image', label: '准备运行环境镜像' },
  { id: 'run', label: '启动容器' },
  { id: 'health', label: '等待容器内 Agent 就绪' }
]

/**
 * 阶段 id → 人话（预览面板那行「当前阶段：…」用）。
 *
 * 与 `PHASES` **同一份来源**：别在别处再抄一张表，加了阶段只改这里就不会漂。
 */
export const PHASE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  PHASES.map((phase) => [phase.id, phase.label])
)

export function ContainerStartupView({
  workspace,
  project,
  available,
  pending = false,
  reason,
  onStart,
  onStop,
  onRetry
}: {
  workspace: AgentWorkspace
  /** 该项目在快照里的运行态；`undefined` = 刚建出来、ws 快照还没到 */
  project: ContainerProjectState | undefined
  available: boolean
  /**
   * 状态快照**还没到**（刷新页面后那一下）。
   *
   * 必须和 `available: false` 分开：后者是「服务端真的没有可用的 docker」，前者只是「还不
   * 知道」。以前共用一条兜底，刷新容器型会话会先闪一句「当前没有可用的 docker」再正常
   * （用户报过）。
   */
  pending?: boolean
  reason?: string
  onStart: () => Promise<void> | void
  onStop: () => Promise<void> | void
  /**
   * docker 连不上时那个「重试」要干的事：**重新探测 docker 引擎**，不是再起一次容器。
   *
   * 引擎没起来时启动接口必然失败，而且是「探 docker → 报错」那种几十秒的失败；重试探测
   * 只要一次 socket 往返，用户把 Docker Desktop 起来后立刻能恢复。不给就不显示重试按钮。
   */
  onRetry?: () => Promise<void> | void
}) {
  const [logOpen, setLogOpen] = useState(false)
  /**
   * 本地「哪个请求还在飞」，**按动作分开**记，且一律在 Promise 落地（`finally`）才解除。
   *
   * ⚠️ 「接口返回前按钮必须是 loading」是这里的硬要求 —— 三个动作都慢：
   * - `start` 要等容器真正就绪（`FIZZ_CONTAINER_WAKE_TIMEOUT_MS`）；
   * - `stop` 要等 `docker stop` 的优雅退出窗口（最多 5s）；
   * - `retry` 要等服务端现问一次 daemon。
   *
   * 所以**不能**像以前那样让快照一到 `starting` 就把忙态清掉：`startContainerProject`
   * 一开始就推 `prepare`，那条快照比接口早回几十秒；清了之后按钮立刻退回「重试」，
   * 看着像没点上。现在快照只决定**文案**（阶段名 / 是启动还是停止），转不转圈只看
   * 请求有没有回来。
   */
  const [busy, setBusy] = useState<'start' | 'stop' | 'retry' | null>(null)
  const state = project?.state ?? 'stopped'
  /** 服务端已经把容器置成启动中 —— 按钮换成「停止」，但**不能**因此停掉转圈 */
  const starting = state === 'starting'
  /**
   * 正在停（`docker stop` 的优雅退出窗口，最多 5 秒）。
   *
   * 这一段容器在 `docker ps` 里**还是 Up**，但用户已经点了停止 —— 卡片必须立刻变成
   * 「停止中」，否则点了停止界面还是「容器没有运行 / 已就绪」，看着像没停成。
   */
  const stopping = state === 'stopping'
  const phaseIndex = PHASES.findIndex((p) => p.id === project?.phase)
  /** docker 引擎连不上：这时候「启动」必然失败，只能「重试」（重试 = 重新探测引擎） */
  const dockerDown = !pending && !available
  /**
   * 状态一句话（明细区第一行）。
   *
   * 与下面的说明文案分开：说明是「接下来怎么办」，这里是「现在是什么状态」。
   * 启动中要带上阶段名，不然用户只看到「启动中」还得去下面那列阶段里找。
   */
  const stateLabel = pending
    ? '读取中…'
    : dockerDown
      ? '连不上 docker 引擎'
      : busy === 'stop' || stopping
        ? '正在停止'
        : starting || busy === 'start'
          ? `启动中 · ${PHASE_LABELS[project?.phase ?? ''] ?? '检测容器状态'}`
          : state === 'error'
            ? '启动失败'
            : state === 'running'
              ? '运行中'
              : '未运行'

  /**
   * 状态那句话是不是「失败结论」—— 决定它染不染红。
   *
   * 只有「连不上 docker 引擎 / 启动失败」算失败；读取中、启动中、停止中都是过程，保持灰色。
   * ⚠️ 必须跟着**实际显示的那句话**走：`state` 还挂着上一次的 `error` 时用户点了启动，
   * 标签已经变成「启动中 · …」，这时候染红等于把「正在重试」说成「又失败了」。
   */
  const stateFailed = !pending && !starting && busy !== 'start' && (dockerDown || state === 'error')

  /**
   * 发一个请求并把按钮锁到它回来为止。
   *
   * `catch` 吞掉是**故意**的：启动 / 停止接口的失败原因写在快照的 `error` 里（约定见
   * `lifecycle.ts`），界面读快照；这里只负责别让未处理的 rejection 冒到控制台。
   */
  const run = (action: 'start' | 'stop' | 'retry'): void => {
    setBusy(action)
    void Promise.resolve()
      .then(() => (action === 'start' ? onStart() : action === 'stop' ? onStop() : onRetry?.()))
      .catch(() => undefined)
      .finally(() => setBusy(null))
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <div className="flex w-full max-w-md flex-col gap-4">
        {/*
          图标块是**正方形**（`size-14` = 56×56），靠 `items-center` 与右侧三行文字垂直居中。

          ⚠️ 别改回「`items-stretch` + 固定宽」：那样高度会被右侧文字撑开，方块变成一个竖长条
          （用户报过「图标不是正方形」）。也别用 `aspect-1` —— Tailwind 的 `aspect-*` 只认
          `square` / `video` / 分数（`aspect-3/2`），`aspect-1` 生成不出任何 CSS，等于没写。
        */}
        <div className="flex items-start gap-3">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted">
            {/*
              转圈只在**真的有请求在飞**时给：`pending`（还不知道状态）、`stopping` /
              `busy === 'stop'`（docker stop 的优雅退出窗口）、`busy === 'retry'`（正在现问 daemon）。

              ⚠️ 别把 `dockerDown` 本身写进条件：它是**持续状态**（`available: false` 一直成立），
              引擎没起来时那个圈会永远转，看着像界面卡在加载（用户报过「图标一直在 loading」）。
              连不上引擎是个**静止的结论**，说明与「重试」按钮已经把它讲清楚了。
              启动中也不转 —— 进度在下面那列阶段里，同一个界面转两处只会让人分不清哪边在动。
            */}
            {pending || stopping || busy === 'stop' || busy === 'retry' ? (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <Box className="size-6 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">{workspace.name}</h2>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {workspace.container?.slug} · {workspace.container?.image}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {pending
                ? '正在读取容器状态…'
                : dockerDown
                  ? '请先启动 Docker（Docker Desktop / dockerd），然后点「重试」。'
                  : stopping
                    ? '容器正在停止...'
                    : starting || busy === 'start'
                      ? '容器正在启动...'
                      : state === 'error'
                        ? '容器启动失败。'
                        : '容器没有运行。'}
            </p>
          </div>
        </div>

        {/*
          状态明细：把「现在到底是什么状态」摊开写，而不是只靠上面那句说明。
          缺的不显示 —— 用户不用去侧栏点开「容器状态」才知道在哪个阶段。

          ⚠️ **不显示预览端口**（容器内的配置值与当前宿主映射都不显示）：端口是宿主侧的
          实现细节，用户要的是「点开预览就能看到页面」。以前这里写「预览端口 3000
          （当前映射 49153）」，换一次容器映射就变一个数，只会让人以为要自己记/自己转发。
          端口只在开发排查时需要，那边有日志与设置页。
        */}
        {!pending && (
          <dl className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-muted/30">
            <div className="flex gap-3 px-3 py-1.5 text-[0.6875rem] leading-5">
              <dt className="w-16 shrink-0 text-muted-foreground">状态</dt>
              {/*
                失败结论染红（`text-destructive`），别的一律 `foreground/80`。
                「原因」那行仍是灰色：它是给人搜报错用的原始长文本，整段染红只会糊成一片。
              */}
              <dd
                className={`min-w-0 flex-1 ${stateFailed ? 'text-destructive' : 'text-foreground/80'}`}
              >
                {stateLabel}
              </dd>
            </div>
            {dockerDown && reason && (
              <div className="flex gap-3 px-3 py-1.5 text-[0.6875rem] leading-5">
                <dt className="w-16 shrink-0 text-muted-foreground">原因</dt>
                {/* `data-selectable`：全局 body 禁选，这段 daemon 报错是给人复制去搜的（同上） */}
                <dd
                  data-selectable
                  className="min-w-0 flex-1 font-mono break-words text-foreground/80"
                >
                  {reason}
                </dd>
              </div>
            )}
            {project?.pendingRestart && (
              <div className="flex gap-3 px-3 py-1.5 text-[0.6875rem] leading-5">
                <dt className="w-16 shrink-0 text-muted-foreground">待生效</dt>
                <dd className="min-w-0 flex-1 text-foreground/80">
                  改过镜像或资源限额，下次启动时按新配置重建
                </dd>
              </div>
            )}
          </dl>
        )}

        {/*
          ⚠️ 这里是 `!pending` 而不是 `available`：**连不上 docker 时按钮区也得在**（只剩一个
          「重试」），否则卡片上什么都没有，用户只能干看着那句报错（用户报过「重试按钮没了」）。
        */}
        {!pending && (
          <>
            {/*
              停止中的「规划」：就两步，但要说清「为什么还占着界面」——
              `docker stop` 有优雅退出窗口（默认 5s），这期间容器还没退干净，
              所以既不能算「已停止」也不能再点启动。
            */}
            {stopping && (
              <ol className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3">
                <li className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  <span className="text-foreground">停止容器（docker stop，通常几秒）</span>
                </li>
                <li className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="size-3.5 shrink-0 rounded-full border border-current opacity-40" />
                  停好后回到「容器没有运行」
                </li>
              </ol>
            )}

            {/* 阶段进度：只有启动中 / 失败才有意义（已就绪、已停都看不出来在哪个阶段）。
                `busy === 'start'` 也显示：点下「启动」到服务端第一次推快照之间，先把整列
                「待办」摆出来，免得用户以为点了没反应。 */}
            {(starting || state === 'error' || busy === 'start') && (
              <ol className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3">
                {PHASES.map((phase, index) => {
                  const done = phaseIndex > index
                  // 还没收到任何阶段时（刚点下启动）把第一行标成「当前」，让转圈立刻出现
                  const current = phaseIndex === index || (phaseIndex < 0 && index === 0)
                  return (
                    <li
                      key={phase.id}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      {done ? (
                        <Check className="size-3.5 shrink-0" />
                      ) : current && (starting || busy === 'start') ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin" />
                      ) : (
                        <span className="size-3.5 shrink-0 rounded-full border border-current opacity-40" />
                      )}
                      <span className={current ? 'text-foreground' : undefined}>{phase.label}</span>
                    </li>
                  )
                })}
              </ol>
            )}

            {/* 构建日志（`docker build` 的输出）：启动慢时用户能看见「在动」 */}
            {project?.buildLog && (
              <div className="flex flex-col gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit text-muted-foreground"
                  onClick={() => setLogOpen((v) => !v)}
                >
                  <ChevronDown className={`size-4 transition-transform ${logOpen ? 'rotate-180' : ''}`} />
                  构建日志
                </Button>
                {logOpen && (
                  <pre className="max-h-56 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-4 whitespace-pre-wrap">
                    {project.buildLog}
                  </pre>
                )}
              </div>
            )}

            {/*
              失败原因：服务端的原话 + 容器日志尾部（`error` 字段里已经拼好了）。

              ⚠️ **docker 连不上时不显示**：那一刻服务端给每个项目的 `error` 就是
              `dockerDownReason()`（「连不上 docker 引擎 —— …」+ 同一段 daemon 报错），
              而上面「状态 / 原因」两行已经把这件事说全了（原因行里就是那段 daemon 报错），
              再摊一遍等于同一句话在卡片上出现两次（用户报过「红字和状态重复了」）。
              引擎恢复后这条会自己回到普通失败原因（那时 `dockerDown` 为 false）。
            */}
            {state === 'error' && project?.error && !dockerDown && (
              <pre className="max-h-56 overflow-auto rounded-lg bg-destructive/5 p-3 text-[11px] leading-4 whitespace-pre-wrap text-destructive">
                {project.error}
              </pre>
            )}

            <div className="flex items-center gap-2">
              {/*
                按钮的规则（三条都别丢）：
                1. **接口没回来之前一律 loading**：转不转圈只看 `busy`，不看快照 ——
                   `startContainerProject` 要等容器就绪才返回，期间快照早就变成 `starting` 了；
                2. **「重试」永远在**：启动失败（`error`）与连不上引擎（`dockerDown`）都给，
                    用户想点几次点几次；
                3. 两种「重试」走的是**不同接口**：连不上引擎时重试 = 重新探测 docker
                   （`onRetry`），此时再调启动接口必然又是几十秒的失败；引擎活着、
                   只是启动失败才走 `onStart`。
              */}
              {stopping || busy === 'stop' ? (
                // 停的途中不给「启动」：服务端那条路会先等停止落地，点下去只会转很久
                <Button variant="outline" size="sm" disabled>
                  <Loader2 className="size-4 animate-spin" />
                  停止中…
                </Button>
              ) : starting && busy !== 'start' ? (
                // 启动中途的「停止」：服务端会置成 `stopping` → `stopped`（按钮按 `busy` 转圈）
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => run('stop')}
                >
                  <Square className="size-4" />
                  停止
                </Button>
              ) : dockerDown ? (
                /*
                 * 「重试」= 重新探测 docker 引擎（见 `onRetry`），是**一次真实的网络 / socket
                 * 往返**，慢起来要好几秒 —— 用项目统一的 `SpinnerButton`：spinner 出现在
                 * 文字前、loading 时自动 disabled，与 Git 面板那几颗按钮同一套观感。
                 *
                 * 文案**不跟着变**（不写「正在重试…」）：`SpinnerButton` 的约定是
                 * 「spinner 替代图标、标签保持稳定」，换字会让按钮宽度跳一下。
                 */
                <SpinnerButton
                  size="sm"
                  loading={busy === 'retry'}
                  // 与这一排其它按钮的图标同尺寸（都是 `size-4`），别让 spinner 比图标小一圈
                  spinnerClassName="size-4"
                  onClick={() => run('retry')}
                >
                  {busy !== 'retry' && <RefreshCw className="size-4" />}
                  重试
                </SpinnerButton>
              ) : (
                <Button size="sm" disabled={busy === 'start'} onClick={() => run('start')}>
                  {busy === 'start' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : state === 'error' ? (
                    <RefreshCw className="size-4" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {busy === 'start' ? '正在启动…' : state === 'error' ? '重试' : '启动'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 容器项目的门：**只按状态分流**，不主动启动。
 *
 * `running` → 渲染 `children`；否则渲染启动态卡片，等用户点「启动 / 重试」，
 * 或者从侧栏项目菜单的「容器状态」里启动。
 *
 * ⚠️ `workspaceId` **必须由调用方给**，不读 `app.activeWorkspaceId`：门挂在每个标签上
 * （见下面的 `ContainerTabGate`），标签可以来自别的工作区 —— 拿「当前工作区」判，会把
 * 普通项目的对话标签也顶成容器卡片。
 *
 * 容器**不会**被服务端自动停（没有闲置回收），停止只来自用户点「停止容器」。
 */
export function ContainerProjectGate({
  app,
  workspaceId,
  children
}: {
  app: AgentApp
  /** 这个门管哪个工作区；`null` = 与工作区无关（直接放行） */
  workspaceId: string | null
  children: ReactNode
}) {
  const workspace = workspaceId ? (app.workspaces.find((w) => w.id === workspaceId) ?? null) : null
  const container = workspace?.container
  /*
   * ⚠️ 用 `useStateSnapshot`（未就绪 = `undefined`）而**不是** `useStateValue(…, EMPTY_SNAPSHOT)`：
   * 兜底快照里 `available: false` 的语义是「服务端没有可用的 docker」，刷新页面后 `init`
   * 到达前那一两百毫秒界面就会先闪一句「当前没有可用的 docker」，再跳成正常界面（用户报过）。
   */
  const snapshot = useStateSnapshot<ContainerProjectsSnapshot>('containerProjects')
  const project =
    snapshot && container ? snapshot.projects.find((p) => p.workspaceId === workspace?.id) : undefined

  // 普通项目（无 container 字段）：逐字走原来那条路
  if (!workspace || !container) return <>{children}</>
  if (project && CONTAINER_RUNNING_STATES.includes(project.state)) return <>{children}</>

  /**
   * 起 / 停。**不在 await 里取快照**：进度由 state ws 推（服务端一开始就置 `prepare`），
   * 这里只负责把请求发出去；启动接口要等容器真正就绪才返回，await 住它会让按钮一直转。
   * 失败原因已经落在快照的 `error` 里（接口不抛错），界面自己显示。
   */
  const run = (action: 'start' | 'stop'): void => {
    const api = app.api
    if (!api) return
    const id = workspace.id
    void (action === 'start'
      ? api.startContainerProject(id)
      : api.stopContainerProject(id)
    ).catch(() => undefined)
  }

  /**
   * 「重试」在 docker 连不上时走的是**探测**而不是启动：启动接口进来第一件事也是探 docker，
   * 引擎不在时那趟必然失败、还慢；而探测接口会清掉服务端两层缓存现问一次 daemon，
   * 用户把 Docker Desktop 起来后点一下就能恢复（返回的 `reason` 为空 = 好了，快照随
   * `markDirty` 推过来）。
   *
   * ⚠️ **必须把 Promise 交回去**（不是 `void` 掉）：`ContainerStartupView` 靠它维持按钮的
   * `loading`，`finally` 才解除。以前这里 `void` 掉，`busy` 在下一个微任务就被清掉，
   * 那颗按钮的 spinner 只闪一帧 —— 看起来像「点了没反应」（用户报过）。
   * 与 `run('start' | 'stop')` 不同：起停的进度由快照推（按钮要尽早切成「停止」），
   * 而探测只是一次 socket 往返，让用户看见「在动」比立刻复原更好。
   */
  const retry = (): Promise<void> => {
    const api = app.api
    if (!api?.retryContainerDocker) return Promise.resolve()
    // 失败原因已经落在快照的 `reason` 里（接口不抛错），这里吞掉，只负责让按钮转完
    return api.retryContainerDocker().then(
      () => undefined,
      () => undefined
    )
  }

  return (
    <ContainerStartupView
      workspace={workspace}
      project={project}
      available={snapshot?.available ?? false}
      pending={snapshot === undefined}
      {...(snapshot?.reason ? { reason: snapshot.reason } : {})}
      onStart={() => run('start')}
      onStop={() => run('stop')}
      onRetry={retry}
    />
  )
}

/**
 * 标签 → 它所属的工作区 id：**只有真实会话标签才可能属于某个容器项目**，其余一律
 * `null`（= 不过门）：
 *
 * - **对话标签**：它指向的会话自己的 `workspaceId`。只有它天然绑定一个项目 —— 也就只有
 *   它该被那个项目的容器状态拦住。
 * - **「新对话」草稿标签**（还没指向任何会话）：**恒 `null`**。草稿还没有会话、也还没有
 *   归属项目，用户正是在这一页上挑项目。拿「当前工作区」判它，会让站在容器项目里的人
 *   **永远看不到**「开始新对话」页：草稿标签被顶成容器卡片，而关掉它 `PanelView` 又会
 *   立刻补一张 —— 表现为「一张关不掉的容器卡片」（用户报过）。「关掉所有标签 → 新对话
 *   标签 → 开始新对话」是**与工作区无关**的固定落点，不能由项目状态改写。
 * - **工具标签**（主机终端 / 本机终端 / SFTP / 接口 / 脚本 / 笔记 / 插件 / 日志 / 隧道）：
 *   一律 `null`。它们是**独立功能**（「主机与终端」里那条本机终端就是**宿主 shell**），
 *   只是把内容摆进主区域当标签用，与任何会话 / 项目都没有关系 —— 不能因为当前项目是
 *   容器型就被 `docker exec` 进容器，也不能被容器门顶掉。
 *
 * **标签内容**的容器门：容器型项目的容器没在跑时，把启动态卡片渲染在**这一格标签里**。
 *
 * ⚠️ 别把它改回「套在 `PanelView` 外面」（`app-routes` 那种写法）：主区域是多标签的，
 * 门一旦套在整块面板上，容器一停（或启动中 / 停止中 / 启动失败）就把**标签条一起顶掉** ——
 * 用户看不到、也切不了别的标签，只剩一张占满整个主区域的卡片（用户报过）。
 *
 * 现在的位置在内容层里、每个标签各包一层：标签条、拖拽 / 分屏 / 关闭全部照常可用，
 * 只有属于那个容器项目的标签内容换成卡片。判定按**标签自己所属的工作区**走，
 * 所以别的工作区的对话标签、SSH 终端、接口页都不会被牵连。
 */
export function ContainerTabGate({
  tabKey,
  children
}: {
  /** 标签 key（与 `panel-store` 里的一致） */
  tabKey: string
  children: ReactNode
}) {
  const { app } = useAppContext()
  // 订阅「这颗标签指向哪条会话」：草稿页发出第一条消息后它就归属某个项目了，门要跟着变
  const conversationId = useTabConversation(tabKey)
  const workspaceId = conversationId
    ? (app.conversations.find((c) => c.id === conversationId)?.workspaceId ?? null)
    : null
  return (
    <ContainerProjectGate app={app} workspaceId={workspaceId}>
      {children}
    </ContainerProjectGate>
  )
}
