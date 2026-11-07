/**
 * 终端：xterm 渲染 + `openTerminal` 打开的 TerminalProcess。它是右侧多标签面板
 * （`SidePanel`）里的**一个标签**，撑满整块面板 —— 自己**不带标题栏**：名字与关闭在标签条上，
 * 目录在看标签时的悬停提示里（`终端 · /path`），换 shell 在顶栏那个终端分裂按钮里。
 *
 * 终端从哪来由 `openTerminal` prop 决定（不传 = 服务端 PTY）：主会话的面板走服务端，
 * 容器工作台（流程节点）传容器 bridge 的适配层（见 `lib/node-terminal.ts`）。
 *
 * 组件**不随可见性卸载**：面板收起只是把宽度裁到 0，xterm 与 PTY 都留着（卸载即重建
 * xterm，渲染状态与 scrollback 一起没）—— 唯一会卸载它的动作是关掉这个标签。
 *
 * 颜色跟随主题：从 CSS 变量（--background / --foreground）读现值喂给 xterm，
 * <html> 的 dark 类切换时（MutationObserver）重新应用。
 *
 * 手机 / 触屏设备额外做两件事：手机布局（窄屏）下底部常驻一条快捷键条，补软键盘没有的
 * 修饰键 / 功能键；以及**自实现的「手指拖动翻 scrollback」** —— xterm 的 DOM 里根本没有
 * 可滚容器，触摸滚动它自己完全没有，见 `lib/terminal-touch-scroll.ts`。
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { History, Loader2, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CommandHistoryEntry, SshConnectProgress } from '@fizz/contracts/agent-api'
import type { SshCharset } from '@fizz/contracts/types'
import { createZmodemController, type ZmodemController, type ZmodemState } from './zmodem-controller'
import { attachTerminalKeyHandler } from './terminal-key-handler'
import {
  openExternal,
  openSshTerminal,
  openTerminal as openServerTerminal,
  type TerminalOpenOptions,
  type TerminalProcess
} from '@fizz/agent-client/web-host'
import { attachTerminalTouchScroll } from '@fizz/agent-kit/shared/lib/terminal-touch-scroll'
import { clampCompositionOverflow } from '@fizz/agent-kit/shared/lib/terminal-ime'
import { supportsTouch } from '@fizz/agent-kit/shared/lib/supports-touch'
import {
  getTerminalCommandHistoryEnabled,
  getTerminalCommandPrediction,
  getTerminalScrollback,
  useTerminalScrollback
} from '@fizz/agent-kit/shared/lib/terminal-prefs'
import {
  computeSuggestions,
  EMPTY_INPUT_LINE,
  trackInputLine,
  type InputLine
} from '@fizz/agent-kit/shared/lib/terminal-prediction'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { useVirtualKeyBar } from '@fizz/agent-kit/shared/hooks/useVirtualKeyBar'
import { useThemeRevision } from '@fizz/agent-kit/shared/lib/code-theme'
import { buildTheme } from '@fizz/agent-kit/features/terminal/terminal-theme'
import { attachTerminalInteractions } from '@fizz/agent-kit/features/terminal/terminal-interactions'
import { SshConnectCard } from '@fizz/agent-kit/features/terminal/SshConnectCard'
import {
  MobileKey,
  NO_MODS,
  hasAnyMod,
  specialSeq,
  transformChar,
  type ModsState
} from '@fizz/agent-kit/features/terminal/terminal-mobile-keys'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { runUpload } from '@fizz/agent-kit/shared/lib/file-transfer/engine'
import { registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { useTerminalActions, type TerminalAction } from '@fizz/agent-kit/features/terminal/terminal-actions'
import { TerminalFab } from '@fizz/agent-kit/features/terminal/TerminalFab'
import {
  registerTerminal,
  setActiveTerminal,
  setTerminalPhase,
  unregisterTerminal
} from '@fizz/agent-kit/shared/lib/terminal/terminal-registry'
import { stripAnsi } from '@fizz/agent-kit/shared/lib/terminal/terminal-mcp'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { scalePx } from '@fizz/agent-kit/shared/lib/ui-scale'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 终端字号缩放范围与缺省（与 contracts 的 `terminalFontSize` 约定一致） */
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 40
/**
 * 缺省字号：用户反馈 16 偏大，14（xterm 出厂值）更合适；Ctrl+0 可一键复位到这里。
 *
 * ⚠️ 这是**「16px 根字号下」的字面值**，实际缺省要过一遍 `scalePx()`（见 `loadFontSize`）：
 * xterm 的 `fontSize` 是它自己那套 px 选项、不吃 rem，而手机端根字号被抬到 18px
 * （见 `styles.css` 的「手机端整体放大」）—— 直接返回 14 会变成「界面长大了、终端没长」。
 */
const DEFAULT_FONT_SIZE = 14

/**
 * 原始输出环形缓冲保留多少字符（给 AI 工具取增量用，见 `rawOutputRef`）。
 *
 * 64KB ≈ 一两千行普通日志，足够覆盖一次长任务的增量；再大只是在内存里堆一份没人看的东西。
 * 滚出去的会被 `readSince` 标成 `truncated`，工具据此告诉模型「前面丢了」。
 */
const RAW_OUTPUT_KEEP = 64_000

/**
 * 拖拽上传（把本地文件拖进 SSH 终端，经 SFTP 送到远端）的确认条状态。
 *
 * 移植自 dogi 的 `DropUploadState`。**目标目录必须由用户确认**：终端当前工作目录拿不到
 * —— shell 默认不发 OSC 7，解析提示符又不可靠。所以默认给远端家目录（`realpath('.')`），
 * 允许编辑，并在**本会话内记住上次用过的目录**（`lastUploadDirRef`），连续拖几次不用重填。
 */
interface SftpDropState {
  /** 本次要传的文件（拖进来那一刻定下，之后不再变） */
  files: File[]
  /** 目标远端目录（可编辑；初值来自 `realpath` 或上次用过的） */
  dir: string
  /**
   * ⚠️ 没有 `uploading`：确认之后确认条就收起来了，进度 / 取消都在状态栏的传输徽标里。
   * 这一条只负责「传到哪个目录」这一件事（`failed` 指**连接**失败，不是上传失败）。
   */
  phase: 'connecting' | 'connectFailed' | 'ready' | 'failed'
  error?: string
}

/** 历史条目的相对时间（刚刚 / N 分钟前 / N 小时前 / 具体日期） */
function formatHistoryTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/** 字号持久化（key 沿用旧 web-host 的）：直接落 localStorage */
const FONT_SIZE_KEY = 'fizz.web.terminalFontSize'

function loadFontSize(): number {
  // 缺省值按**当前根字号**换算（桌面 14 → 手机 16）：见上面 DEFAULT_FONT_SIZE 的说明。
  // 已存过的值原样返回 —— 那是用户自己滚轮 / `Ctrl+±` 调出来的，不替他改。
  const fallback = scalePx(DEFAULT_FONT_SIZE)
  const raw = localStorage.getItem(FONT_SIZE_KEY)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}


export function TerminalPanel({
  cwd,
  /** 终端从哪来：不传 = 服务端 PTY；容器工作台传容器 bridge 的适配层 */
  openTerminal,
  onReady,
  /** 当前这个标签是否正被看着（不是就不抢焦点；收起 / 切走的标签仍常挂载） */
  visible = true,
  /** 当前选的 shell id（null = 跟随平台默认）；受控：变化即拆旧会话、按新 shell 重建一条 */
  shellId = null,
  /**
   * 所属工作区（项目）id：**会话侧栏里那条**本机终端的命令历史按项目记
   * （`<项目>/.fizz/terminal-history.json`）。
   * 与 `sshHostId` / `localHistory` 一起决定历史 / 预测的作用域（见下面的 `historyScope`）。
   * cwd 变化时调用方会换 key 重建本组件，所以它实际上每实例恒定。
   *
   * ⚠️ **「主机与终端」开出来的终端不要传它**：那是独立功能，与任何项目都无关，
   * 传了历史就会落进某个项目的 `.fizz/`（见 `localHistory`）。
   */
  workspaceId,
  /**
   * 这条终端是「主机与终端」开出来的**宿主本机终端**：历史全局一份，落服务端数据目录的
   * `local-terminal-history.json`（不挂任何项目）。
   *
   * 为什么要有这个显式开关而不是「没传 `workspaceId` 就当宿主终端」：容器工作台那条
   * （`flow/node-workbench`）也两个都不传，但它**不该有历史**（容器里敲的命令与宿主不是
   * 一回事）。判据必须是「调用方声明」，不能靠缺省推断。
   */
  localHistory = false,
  /**
   * SSH 主机配置 id：传了就连这条远端主机（凭据由服务端解密）；此时 `cwd` 是可选的
   * 远端 POSIX 目录（远端工作区用它切目录）。
   * 它的命令历史**不挂项目**，全局一份、存服务端数据目录（见 contracts 的
   * `terminalSshHistory`）。受控：变化即拆旧会话重建。
   */
  sshHostId,
  /**
   * 本机终端（`openTerminal` 分支）的**额外启动参数**：追加在 shell 自带 args 之后。
   * SSH 分支不适用（凭据与启动由服务端那侧决定）。受控：变化即重建会话。
   */
  args,
  /** 本机终端**启动后自动执行的一条命令**（shell 起来后写进 PTY）。SSH 分支不适用。 */
  autoCommand,
  /**
   * 运行脚本：终端**就绪时写入一次**的输入（逐行回车，见 `scriptToTerminalInput`）。
   *
   * SSH 与本机终端都适用 —— 就绪的判定是「SSH 建连 ready 帧」或「首帧输出」，写完即清空
   * （不重复写），等价 dogi 的 `writeWhenReady`。刻意不走 `autoCommand`：那条只在本机 PTY
   * 分支转发，SSH 分支收不到。
   */
  scriptInput,
  /**
   * 是否挂 ZMODEM（rz/sz）嗅探器，缺省开。SSH 与本机终端都该挂 —— 能不能真用取决于
   * **被连的那一侧**有没有 lrzsz；容器工作台传 `false`（它那条 bridge 是纯文本通道，
   * 二进制键入根本发不出去）。
   */
  zmodemEnabled = true,
  /**
   * 主区域工具标签的标签 key（`host:<id>` / `local:<n>`）。**只有**主区域标签传它 ——
   * 传了就按它登记关闭守卫：终端里还有活着的进程（连接中 / 已连接）时，关标签要先确认
   * 「会一起结束这条终端」。容器工作台那份调用不传 → 不登记、行为不变。
   */
  tabKey,
  /**
   * 容器型项目的终端：目标**工作区 id**（服务端据此 `docker exec` 进那个项目的容器）。
   * 不传 = 宿主本机终端，**逐字不变**。SSH 分支不适用。
   */
  containerWorkspaceId,
  /** 容器内 shell（缺省 `/bin/bash`）；仅容器分支有意义 */
  containerShell
}: {
  /**
   * 本机终端的工作目录；`sshHostId` 分支里它表示远端 POSIX 目录（远端工作区打开的
   * 终端用它切目录），不传 = 登录目录
   */
  cwd?: string
  openTerminal?: (options: TerminalOpenOptions) => TerminalProcess
  /** 终端进程就绪（快捷功能要往里写命令：没开就先开，开了直接复用） */
  onReady?: (process: TerminalProcess) => void
  visible?: boolean
  shellId?: string | null
  workspaceId?: string | null
  sshHostId?: string | null
  localHistory?: boolean
  args?: string[] | null
  autoCommand?: string | null
  scriptInput?: string | null
  zmodemEnabled?: boolean
  tabKey?: string
  containerWorkspaceId?: string
  containerShell?: string
}) {
  const [error, setError] = useState<string | null>(null)
  /** 会话序号：终端退出后「重新打开」时 +1，让下面的 effect 拆掉旧的 term/PTY 重建一条 */
  const [sessionSeq, setSessionSeq] = useState(0)
  /**
   * xterm 实例的**世代**：每次真的建出一个新 `Terminal` 就 +1（重建 = 换 shell / 重开会话 /
   * 换 SSH 主机…）。
   *
   * 存在的理由只有一个：下面那个「被看着就自动 focus」的 effect 原本只依赖 `visible`，
   * 于是在**首次挂载**时它跑在「建 term」那个 effect 之前 —— `termRef.current` 还是 null，
   * 直接 return 掉了。于是只有「先开着、之后才切到」的那些标签能自动聚焦，而**刚连上的
   * 终端（新建标签 / 重开会话）恰好是唯一不聚焦的一批**，与期望正相反。加了这个世代当依赖，
   * 实例一建出来就会再跑一次聚焦。
   */
  const [termEpoch, setTermEpoch] = useState(0)
  /**
   * 右键粘贴失败时的提示（读剪贴板被拒）。只在有值的那几秒里占终端上方一条
   * 细横栏；粘成功不打扰。
   */
  const [pasteHint, setPasteHint] = useState<string | null>(null)
  /** 主题 revision：保存自定义主题颜色时 `<style>` 被重写、`data-theme` 不变，MutationObserver 看不到 */
  const themeRevision = useThemeRevision()
  const containerRef = useRef<HTMLDivElement>(null)
  /** 进程与 xterm 实例都只建一次，存 ref 供拖拽条（改高度）与重开会话使用 */
  const processRef = useRef<TerminalProcess | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /**
   * 输出活动（收到多少段 + 最后一段什么时候来的）：登记给 AI 工具，`run_in_terminal`
   * 靠它判「命令的输出停了没有」，替代从前固定 sleep 3 秒的做法。
   *
   * 记在 **PTY 原始数据到达**这一层（不是 xterm 写完 / 渲染之后）：ZMODEM 排水期、
   * 大段输出被丢弃这些情况都不影响「有没有新输出」这个事实。
   */
  const outputActivityRef = useRef({ seq: 0, at: 0 })
  /**
   * 原始输出环形缓冲：给 AI 工具取「这条命令的新增输出」（`readSince`）。
   *
   * 为什么不直接拿 xterm 缓冲截：滚动缓冲只有 1000 行，长任务几秒就顶满，之后
   * `buffer.length` 不再增长（旧行被顶掉），「执行前后比长度」得到的是一段无意义的
   * 碎片 —— 工具回「没捕获到新输出」，模型就反复连读。这里自己按字符累计一份，
   * `offset` 单调递增，完全不受滚动 / 重排影响。
   */
  const rawOutputRef = useRef({ text: '', offset: 0 })
  /**
   * 主题 revision 变了：保存自定义主题颜色时只有注入的 `<style>` 被重写，`data-theme` 不变，
   * 上面那个 MutationObserver 看不到 —— 这里单独重设一次主题，不重建 xterm。
   */
  useEffect(() => {
    const term = termRef.current
    const container = containerRef.current
    if (term && container) term.options.theme = buildTheme(container)
  }, [themeRevision])
  /** 滚动缓冲行数（设置 → 终端）：改了立刻生效，不用重开标签（见下面的 effect） */
  const scrollbackLines = useTerminalScrollback()
  /**
   * 滚动缓冲是可写选项（xterm 的 `IOptions.scrollback`），改完直接赋给现有实例 ——
   * 重建 xterm 会把屏幕上的内容和正在跑的会话一起丢掉，为一行配置不值当。
   * 实例还没建时（首帧）什么都不用做：创建时已经按当时的值设过了。
   */
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.scrollback = scrollbackLines
  }, [scrollbackLines])
  /** 订阅的清理函数（输入 + 输出 + 退出，effect 内赋值，卸载 / 重建时调用） */
  let cleanupSubs: (() => void) | null = null
  /** onReady 的 ref：effect 只跑一次，回调要用最新值（否则闭包里是首帧的空函数） */
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  /** 已退出的 ref：xterm 的按键处理器闭包里读（那个闭包只随会话重建一次） */
  const exitedRef = useRef(false)
  /**
   * 运行脚本：待写入的脚本输入（终端就绪时写一次，写完置空）。
   * 只在**首个渲染**取 `scriptInput`（每个标签实例恒定，见 `ToolTab.scriptInput`），
   * 之后不再跟随 prop 变 —— 也正因如此不必进会话 effect 的依赖。
   */
  const scriptPendingRef = useRef<string | null>(scriptInput ?? null)

  /**
   * 关闭 / 刷新守卫（只给主区域工具标签，见 `tabKey` prop）：终端里还有活着的进程（连接中 /
   * 已连接，`processRef` 有值且 `exitedRef` 还没置位）时，关标签或**刷新标签**都要先确认
   * 「这条终端里正在跑的进程会一起结束」。已退出 / 还没连接 → 直接放行。
   *
   * 两个钩子的判据是同一份（重挂 = 卸载重来，PTY 照样被 kill），差别只在文案：刷新还要
   * 说清「屏幕上的输出也会清空」。读的是 ref，登记只随 `tabKey` 变 —— 进程起停不需要重登记。
   */
  const confirm = useConfirm()
  const { app } = useAppContext()
  const sshHost = sshHostId ? app.sshHosts.find((host) => host.id === sshHostId) : undefined
  const sshCharset: SshCharset =
    sshHost && 'charset' in sshHost ? (sshHost.charset ?? 'utf-8') : 'utf-8'
  useEffect(() => {
    if (!tabKey) return
    return registerTabCloseGuard(tabKey, {
      beforeClose: async () => {
        if (!processRef.current || exitedRef.current) return 'close'
        const ok = await confirm({
          title: '关闭这个终端？',
          description: '这条终端里正在运行的进程会一起结束。',
          confirmLabel: '关闭终端',
          destructive: true
        })
        return ok ? 'close' : 'cancel'
      },
      beforeReload: async () => {
        if (!processRef.current || exitedRef.current) return 'reload'
        const ok = await confirm({
          title: '刷新这个终端？',
          description: '这条终端里正在运行的进程会一起结束，屏幕上的输出也会清空。',
          confirmLabel: '刷新终端',
          destructive: true
        })
        return ok ? 'reload' : 'cancel'
      }
    })
  }, [tabKey, confirm])

  /**
   * 登记到渲染端终端登记表（见 `shared/lib/terminal/terminal-registry.ts`）：
   * 让 AI 助手能读到这条终端的输出、往它里面写命令。
   *
   * 只有**主区域工具标签**（有 `tabKey`）登记 —— 容器工作台 / 侧栏终端不参与，
   * 免得 AI 能操作一个用户根本没在看的会话。
   *
   * 读的是 ref，所以登记只随 `tabKey` 变：进程起停不需要重登记。
   */
  useEffect(() => {
    if (!tabKey) return
    const kind: 'ssh' | 'local' = sshHostId ? 'ssh' : 'local'
    registerTerminal({
      tabKey,
      // `cwd` 可能是空串（「主机与终端」开的宿主终端不指定目录 = 主目录）——
      // 用 `||` 而不是 `??`，否则登记表里会出现一个空标题
      title: sshHostId ? `SSH ${sshHostId}` : cwd || '本机终端',
      kind,
      read: (maxChars = 4000) => {
        const term = termRef.current
        if (!term) return ''
        const buffer = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i)
          if (line) lines.push(line.translateToString(true))
        }
        const text = stripAnsi(lines.join('\n')).replace(/\n{3,}/g, '\n\n').trimEnd()
        return text.length > maxChars ? text.slice(text.length - maxChars) : text
      },
      write: (data: string) => processRef.current?.write(data),
      // 焦点落回 xterm（脚本跑完后把光标还给用户）。读 ref 而不是闭包：term 换代不影响登记
      focus: () => termRef.current?.focus(),
      isAlive: () => !!processRef.current && !exitedRef.current,
      // 输出活动：给 `run_in_terminal` 判「安静了多久」，见 outputActivityRef 的说明
      outputSeq: () => outputActivityRef.current.seq,
      lastOutputAt: () => outputActivityRef.current.at,
      // 增量取用：给工具取「这条命令之后的新输出」，见 rawOutputRef 的说明
      outputOffset: () => rawOutputRef.current.offset,
      readSince: (since) => {
        const raw = rawOutputRef.current
        // 环形缓冲的起点：累计偏移减去还留着的字符数
        const keptStart = raw.offset - raw.text.length
        const text = stripAnsi(raw.text.slice(Math.max(0, since - keptStart)))
          // `\r` 是进度条 / 覆盖写：按换行处理，否则整段会挤成一行看不出来
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
        return { text, offset: raw.offset, truncated: since < keptStart }
      }
    })
    return () => unregisterTerminal(tabKey)
    // sshHostId / cwd 只在实例内恒定（换它们调用方会换 key 重建），不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])

  /** 可见性变化时自报「我现在被看着」—— 全局助手的工具目标缺省取它 */
  useEffect(() => {
    if (!tabKey) return
    if (!visible) return
    setActiveTerminal(tabKey)
  }, [tabKey, visible])

  // ---------- ZMODEM（rz/sz）文件传输 ----------
  /**
   * 传输状态；非空 = 终端上方浮出浮层（见下面的浮层 JSX）。
   *
   * 挂不挂嗅探器看 `zmodemEnabled`（缺省开，SSH 与本机终端都挂 —— `rz`/`sz` 是**被连那一侧**
   * 上的程序，web 的「本机终端」其实是服务端的 shell；容器工作台那条纯文本通道必须关掉，
   * 见 Sentry 定义处的说明）。
   */
  const [zmodem, setZmodem] = useState<ZmodemState | null>(null)
  /**
   * SSH 建连进度；非空 = 终端上方浮出连接进度卡片（仅 SSH 主机终端有，由 `proc.onProgress` 推来）。
   * 收到 `ready` / 首帧输出 / 退出即清空收起（见会话 effect）。
   */
  const [connectProgress, setConnectProgress] = useState<SshConnectProgress | null>(null)
  /** 进度卡片的延迟淡入：连接很快时不闪一下（参照 dogi，连接建立通常几百毫秒） */
  const [showConnect, setShowConnect] = useState(false)
  useEffect(() => {
    if (!connectProgress) {
      setShowConnect(false)
      return
    }
    const timer = window.setTimeout(() => setShowConnect(true), 250)
    return () => window.clearTimeout(timer)
  }, [connectProgress])
  /** 有文件正被拖到终端上（拖放高亮用） */
  const [dropActive, setDropActive] = useState(false)
  /**
   * ZMODEM 控制器（会话 effect 里创建，浮层按钮 / 拖放处理器在 effect 之外要用它）。
   * 传输状态本身走上面的 `zmodem` state；这里只借一个稳定的调用入口。
   */
  const zmodemRef = useRef<ZmodemController | null>(null)
  /** 拖放高亮的进出计数：抵消在子元素之间移动时反复触发 enter/leave 的抖动 */
  const dropDepthRef = useRef(0)

  // ---------- 拖拽上传（SFTP） ----------
  /**
   * 拖拽上传确认条状态；非空 = 终端上方浮出确认条（见下面的 JSX）。
   *
   * 为什么走 SFTP 而不是复用 rz（ZMODEM）：ZMODEM 只能逐个文件落到**远端当前目录**，
   * 协议本身不支持目录；而且要先在远端敲 `rz` 才能用。拖拽上传应该是「拖进去就行」。
   * 仅 SSH 会话可用 —— 本机终端没有「远端」这回事。
   */
  const [sftpDrop, setSftpDrop] = useState<SftpDropState | null>(null)
  /** 本会话上次用过的目标目录：连着拖几次不用重填（同 dogi） */
  const lastUploadDirRef = useRef<string | null>(null)
  /**
   * 拖拽被取消（Esc）时浏览器**不再**派发容器的 dragleave —— 唯一信号是鼠标已离开窗口
   * （clientX/Y 归零），靠它收掉高亮，否则那圈描边会一直挂着（与 composer 里那道护栏同款）。
   */
  useEffect(() => {
    const onWindowDragLeave = (e: DragEvent): void => {
      if (e.clientX > 0 || e.clientY > 0) return
      dropDepthRef.current = 0
      setDropActive(false)
    }
    window.addEventListener('dragleave', onWindowDragLeave)
    return () => window.removeEventListener('dragleave', onWindowDragLeave)
  }, [])

  /**
   * 底部虚拟键条是否显示。判据是**输入能力**（只有手指可用）而不是视口宽度 ——
   * 这条键条补偿的是「软键盘没有 Esc / Ctrl / Tab」，跟窗口多宽无关。详见
   * `shared/hooks/useVirtualKeyBar.ts` 文件头（扩展 / 窄窗口 / 手机横屏三种情形）。
   */
  const showKeyBar = useVirtualKeyBar()
  /** 虚拟键条用的「粘连」修饰键状态：开启后作用于下一次按键（软键盘字符或底部功能键），
   *  发完即复位。 */
  const [mods, setMods] = useState<ModsState>(NO_MODS)
  const modsRef = useRef<ModsState>(NO_MODS)
  /**
   * 按下快捷键那一下，终端里**本来有没有焦点**（= 软键盘当时开不开）。
   *
   * 在 `pointerdown` 时记、`click` 时用：等 click 已经晚了，浏览器在 touch 处理里
   * 就把它 blur 了（`document.activeElement` 变成 body），那时再判断什么都一样。
   *
   * ⚠️ 这个 ref 治的是「点快捷键把键盘弄没」。别改成「手机端一律 blur / 桌面一律
   * focus」：两者都错 —— blur 会把用户正开着的键盘强行收掉（点一个键就得重新唤键盘），
   * 而一律 focus 会把用户**主动收起的**键盘又弹出来。正确的语义是**不动用户的状态**：
   * 之前开着就还给他开着（touch 期间被浏览器 blur 了的，这里 focus 补回来），
   * 之前关着就还关着。
   */
  const hadFocusRef = useRef(false)
  const applyMods = useCallback((next: ModsState): void => {
    modsRef.current = next
    setMods(next)
  }, [])
  const resetMods = useCallback((): void => applyMods({ ...NO_MODS }), [applyMods])
  const toggleMod = useCallback(
    (k: keyof ModsState): void => {
      applyMods({ ...modsRef.current, [k]: !modsRef.current[k] })
      // 保持终端焦点：让软键盘不收起，这样「粘连修饰键 + 软键盘字母」才能配合（如 Ctrl+C）
      termRef.current?.focus()
    },
    [applyMods]
  )

  /** 终端字号：初始读 localStorage（没存过用缺省值，按当前根字号换算 —— 见 loadFontSize），滚轮 / Ctrl± 缩放时更新并回写 */
  const [fontSize, setFontSize] = useState<number>(() => loadFontSize())
  const fontSizeRef = useRef(fontSize)
  /**
   * 缩放：夹到 [MIN, MAX] 后写 state + localStorage。用 ref 兜当前值，
   * 滚轮 / 键盘处理器闭包里拿到的都是最新字号（不被 effect 只跑一次困住）。
   */
  const applyFontSize = useCallback((next: number): void => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(next)))
    fontSizeRef.current = clamped
    setFontSize(clamped)
    localStorage.setItem(FONT_SIZE_KEY, String(clamped))
  }, [])

  /** 重新打开一条终端：拆掉旧的 term + PTY，effect 随 sessionSeq 整体重建 */
  const restart = useCallback((): void => {
    exitedRef.current = false
    setSessionSeq((v) => v + 1)
  }, [])



  // ---------- 命令历史 + 命令预测（有历史作用域时启用，见 historyScope） ----------

  /**
   * 历史作用域：**三种终端的历史是三份独立数据**，不能混。
   * - `workspace`：**会话侧栏里**的本机（服务端）终端，按项目记，落
   *   `<项目>/.fizz/terminal-history.json`；
   * - `ssh`：SSH 主机终端，不挂项目、全局一份，落服务端数据目录；
   * - `local`：**「主机与终端」开出来的宿主本机终端**，不挂项目、全局一份，落服务端数据
   *   目录的 `local-terminal-history.json`（它是独立功能，与当前是哪个项目无关）。
   * 都没有（容器工作台的终端 / 容器内终端）就整块关掉：没有历史可依，也不弹预测。
   *
   * 用 useMemo 定住标识：它进下面几个 useCallback 的依赖，每次渲染都新建对象会让
   * 「挂载时拉一次历史」那个 effect 每帧重跑。
   */
  const historyScope = useMemo<
    { kind: 'workspace'; id: string } | { kind: 'ssh' } | { kind: 'local' } | null
  >(() => {
    if (sshHostId) return { kind: 'ssh' }
    if (workspaceId) return { kind: 'workspace', id: workspaceId }
    if (localHistory) return { kind: 'local' }
    return null
  }, [sshHostId, workspaceId, localHistory])

  /** 本作用域的命令历史镜像（最新在前）：预测的建议源，也是历史管理浮层的数据 */
  const [history, setHistoryState] = useState<CommandHistoryEntry[]>([])
  /** 同上一份的 ref 镜像：recompute 在按键闭包里跑，读 ref 才拿得到最新值 */
  const historyRef = useRef<CommandHistoryEntry[]>([])
  const setHistoryEntries = useCallback((entries: CommandHistoryEntry[]): void => {
    historyRef.current = entries
    setHistoryState(entries)
  }, [])

  /** 从服务端拉一遍本作用域历史（挂载时 + 打开管理浮层时刷新） */
  const refreshHistory = useCallback((): void => {
    const api = useAgentStore.getState().getApi()
    if (!api || !historyScope) return
    void (historyScope.kind === 'ssh'
      ? api.listSshTerminalHistory()
      : historyScope.kind === 'local'
        ? api.listLocalTerminalHistory()
        : api.listTerminalHistory(historyScope.id)
    )
      .then((res) => setHistoryEntries(res.entries ?? []))
      .catch(() => {})
  }, [historyScope, setHistoryEntries])

  // 挂载（或换作用域）时拉一次；失败静默 = 预测没有历史可用，终端本体不受影响
  useEffect(() => {
    refreshHistory()
  }, [refreshHistory])

  /** 回车提交了一条命令：按「记录历史」开关上报服务端，成功后用服务端的全量换掉镜像 */
  const recordCommand = useCallback(
    (cmd: string): void => {
      if (!historyScope || !getTerminalCommandHistoryEnabled()) return
      const api = useAgentStore.getState().getApi()
      if (!api) return
      void (historyScope.kind === 'ssh'
        ? api.addSshTerminalHistory(cmd)
        : historyScope.kind === 'local'
          ? api.addLocalTerminalHistory(cmd)
          : api.addTerminalHistory(historyScope.id, cmd)
      )
        .then((res) => setHistoryEntries(res.entries ?? []))
        .catch(() => {})
    },
    [historyScope, setHistoryEntries]
  )

  // 预测下拉框的本地跟踪行与建议状态：跟踪行走 ref（按键闭包读写），建议走 state
  //（快照里带上缓冲文本：下拉框渲染要用它拆「已敲 / 待补」两段，不能在渲染期读 ref）
  const inputBufRef = useRef<InputLine>(EMPTY_INPUT_LINE)
  const suggestionsRef = useRef<string[]>([])
  const activeIndexRef = useRef(0)
  const [suggestions, setSuggestions] = useState<{
    items: string[]
    index: number
    buf: string
  } | null>(null)
  // 历史管理浮层 + 预测下拉框的定位（相对终端容器）
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * 外层挂进悬浮球的动作（终端标签里的 AI 助手开关）。
   * 终端自己的「命令历史」也进同一个圆环 —— 见下面的 `fabActions`（terminal-actions.ts）。
   */
  const externalActions = useTerminalActions()
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const clearSuggestions = useCallback((): void => {
    suggestionsRef.current = []
    activeIndexRef.current = 0
    setSuggestions(null)
  }, [])

  /** 重置本地跟踪缓冲（Ctrl+C / 控制键 / 会话退出后，缓冲与 shell 已对不上） */
  const clearInputTracking = useCallback((): void => {
    inputBufRef.current = EMPTY_INPUT_LINE
    clearSuggestions()
  }, [clearSuggestions])

  /**
   * 「取消连接」（连接进度卡片底部）：中断正在进行的建连。
   *
   * ⚠️ **不能只 `kill()`**：两条传输层的 `kill()` 都把自己标成「我们主动关」
   * （web-host / desktop 的 `closedByUs`），WS 的 close 因此**不会**再回一个 `onExit`
   * —— 只调 kill 的话卡片会一直挂着。所以这里得自己把收尾做完：收起卡片、写「已取消」
   * 提示、置退出态（按 Enter 可重连）。与 `onExit` 那条分支同一套观感。
   *
   * **不关标签**：标签留着，用户随时按 Enter / 顶栏重连按钮再连一次。
   */
  const cancelConnect = useCallback((): void => {
    const proc = processRef.current
    if (!proc) return
    proc.kill()
    setConnectProgress(null)
    exitedRef.current = true
    // 标签条换红点：`kill()` 走的是「我们主动关」，不会回 `onExit`，这里不写就永远停在黄点
    if (tabKey) setTerminalPhase(tabKey, 'exited')
    clearInputTracking()
    const term = termRef.current
    if (term) {
      term.write('\r\n\x1b[33m● 已取消连接\x1b[0m\r\n' + '\x1b[90m  按 Enter 重连\x1b[0m\r\n')
      term.focus()
    }
  }, [clearInputTracking, tabKey])

  /** 预测下拉框定位：优先显示在光标下方，空间不足则显示在光标上方 */
  const positionDropdown = useCallback((): void => {
    const term = termRef.current
    const container = containerRef.current
    const box = dropdownRef.current
    if (!term || !container || !box) return
    const buf = term.buffer.active
    /**
     * 单元格尺寸：**只量公开 DOM**，不碰 xterm 内部字段。
     *
     * 以前这里读 `term._core._renderService.dimensions.actualCellWidth` —— 私有 API，
     * 升级 xterm 就可能变成 undefined（那时整个下拉框会飘到左上角）。`.xterm-screen`
     * 是 xterm 自己的文本区元素，宽高恰好是 `cols * cellW` / `rows * cellH`，除一下就有；
     * 量不到（还没布局 / 元素被换掉）再退回按容器均分。
     */
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
    const screenRect = screen?.getBoundingClientRect()
    const cellW = screenRect?.width
      ? screenRect.width / Math.max(1, term.cols)
      : container.clientWidth / Math.max(1, term.cols)
    const cellH = screenRect?.height
      ? screenRect.height / Math.max(1, term.rows)
      : container.clientHeight / Math.max(1, term.rows)
    const x = buf.cursorX * cellW
    const y = buf.cursorY * cellH
    const contW = container.clientWidth
    const contH = container.clientHeight
    const boxW = box.offsetWidth
    const boxH = box.offsetHeight
    const gap = 8
    const left = Math.min(Math.max(x, 0), Math.max(0, contW - boxW))
    const belowTop = y + cellH + gap
    let top = belowTop
    if (belowTop + boxH > contH) {
      const aboveTop = y - gap - boxH
      top = aboveTop >= 0 ? aboveTop : belowTop
    }
    top = Math.min(Math.max(top, 0), Math.max(0, contH - boxH))
    setPos({ top, left })
  }, [])

  // 建议变化时（键入 / 切换）重新定位
  useLayoutEffect(() => {
    if (suggestions) positionDropdown()
  }, [suggestions, positionDropdown])

  /** 按当前跟踪行重算建议（历史优先，常见命令兜底；预测关了直接收起） */
  const recomputeSuggestions = useCallback((): void => {
    // 预测随「命令历史」一起启用：没有历史作用域（容器工作台的终端）就没有历史可依，不弹
    if (!historyScope || !getTerminalCommandPrediction()) {
      clearSuggestions()
      return
    }
    const line = inputBufRef.current
    const trimmed = line.text.trimEnd()
    /**
     * 只在**光标停在行尾**时给建议。
     *
     * 补全是「往回填掉还没敲的部分」：接受时是把 `建议.slice(已敲长度)` 写进 PTY，
     * 写进去落在**光标处**。光标在行中间时这个后缀会插到句子中间（`docker ps` 光标停在
     * `docker` 后面接受 `docker ps -a` → `docker -a ps`），与用户看到的完全不同。
     * 所以行内编辑仍然跟踪（缓冲不丢，见 `trackInputLine`），但**不弹**建议。
     */
    if (!trimmed || line.caret !== line.text.length) {
      clearSuggestions()
      return
    }
    // 匹配 / 排序 / 截断规则都在 lib/terminal-prediction.ts（纯函数，方便单独验证）
    const top = computeSuggestions(trimmed, historyRef.current.map((e) => e.cmd))
    suggestionsRef.current = top
    activeIndexRef.current = 0
    setSuggestions(top.length ? { items: top, index: 0, buf: line.text } : null)
  }, [clearSuggestions, historyScope])

  /** 切换高亮建议（Ctrl+↑/↓ 循环） */
  const moveActive = useCallback(
    (dir: number): void => {
      const n = suggestionsRef.current.length
      if (!n) return
      activeIndexRef.current = (activeIndexRef.current + dir + n) % n
      setSuggestions({
        items: suggestionsRef.current,
        index: activeIndexRef.current,
        buf: inputBufRef.current.text
      })
    },
    []
  )

  /** 接受当前高亮建议：把剩余后缀写进 PTY（等同于正常键入），缓冲对齐成完整命令 */
  const acceptSuggestion = useCallback((): void => {
    const items = suggestionsRef.current
    if (!items.length) return
    const full = items[activeIndexRef.current] ?? items[0]
    const typed = inputBufRef.current.text
    const suffix = full.slice(typed.length)
    if (suffix) processRef.current?.write(suffix)
    inputBufRef.current = { text: full, caret: full.length }
    clearSuggestions()
  }, [clearSuggestions])

  /**
   * 一段原始输入进终端前的统一入口：先喂给预测的缓冲跟踪，再写 PTY。
   * 键盘（term.onData）与手机快捷键条（handleAction）都走这里，两边行为一致。
   */
  const sendInput = useCallback(
    (data: string): void => {
      /**
       * ZMODEM（rz/sz）传输期间禁掉一切手动输入。
       *
       * 这段字节流由 ZMODEM 会话**独占**（Sentry 把非协议字节回吐、协议字节吞掉），
       * 中途插进去的按键会被远端当成协议数据 → 传输直接失败 / 远端文件烂掉。
       * 键盘、手机快捷键条、历史回填三个入口都走这里，一处拦全拦。
       */
      if (zmodemRef.current?.isBusy()) return
      // shell 已退出：写出去也没人收，只认回车 —— 重开一条由 restart() 做
      //（键盘那条路见 customKeyEventHandler；这里兜的是不产生 keydown 的软键盘 / 输入法）
      if (exitedRef.current) {
        if (data === '\r') restart()
        return
      }
      const term = termRef.current
      if (!term) return
      /**
       * 备用屏幕（tmux / screen / vim / less / htop…）：全屏程序里没有 shell 的行编辑，
       * 本地缓冲也无从跟踪，而且它们会把「组合键之后的可打印键」当成自己的命令执行
       * —— 若照常累积就会在什么都没输入的情况下弹出预测面板。全屏期间既不跟踪也不拦截。
       */
      if (term.buffer.active.type === 'alternate') {
        clearInputTracking()
        processRef.current?.write(data)
        return
      }
      /**
       * 下拉框开着时只吃这三个键：接受（→）、Ctrl+↑/↓ 换选、以及 **Esc 收起**。
       * 其余（↑/↓/←）一律放行 —— 它们是 shell 的历史与光标移动。
       *
       * ⚠️ Esc 必须**本地吃掉、绝不转发给 shell**。
       *
       * 那个 `\x1b` 单字节在 bash 里是「meta 前缀」：readline 收到后会一直等下一位，
       * 好把 `\e` + `x` 认成一个 meta 绑定。此时用户再按方向键（`\e[D`），bash 看到的
       * 是 `\e\e` —— 没有这个绑定，于是把前两个字节当无效序列丢掉，剩下的 `[D` 当普通
       * 字符**插进命令行**。用户看到的就是「Esc 取消预测后再按方向键，终端里冒出
       * `[D` / `[C`」（用户报的正是这个）。预测下拉框是我们自己的 UI，收起它没有任何理由
       * 去打扰 shell。
       */
      if (suggestionsRef.current.length > 0) {
        if (data === '\x1b') {
          // 只收下拉框：跟踪行不动（shell 那一行还在，光标位置也没变）
          clearSuggestions()
          return
        }
        if (data === '\x1b[C') {
          acceptSuggestion()
          return
        }
        if (data === '\x1b[1;5B') {
          moveActive(1)
          return
        }
        if (data === '\x1b[1;5A') {
          moveActive(-1)
          return
        }
      }
      // 跟踪（回车记历史 / 退格 / 方向键挪光标 / Ctrl+C 清行），随后原样交给 shell
      if (data === '\r' || data === '\n') {
        const cmd = inputBufRef.current.text.trim()
        if (cmd) recordCommand(cmd)
        clearInputTracking()
      } else {
        // 认不出的输入（Tab 补全、历史召回、Ctrl 组合键…）→ trackInputLine 返回 null，
        // 这里清空跟踪：宁可下一条重新开始，也不要拿一条和 shell 对不上的行去套历史
        const next = trackInputLine(inputBufRef.current, data)
        if (next) {
          inputBufRef.current = next
          recomputeSuggestions()
        } else {
          clearInputTracking()
        }
      }
      processRef.current?.write(data)
    },
    [
      recordCommand,
      clearInputTracking,
      clearSuggestions,
      recomputeSuggestions,
      acceptSuggestion,
      moveActive,
      restart
    ]
  )

/**
 * 底部功能键：按当前修饰键合成转义序列走统一输入入口（预测拦截 / 缓冲跟踪都一致），然后复位粘连修饰键。
 *
 * ⚠️ **不要在这里动焦点**（这里踩过两次，记一下免得第三次）：
 * - 曾经无条件 `focus()`：手机上焦点落在 xterm 那个隐藏 textarea 上就等于软键盘弹出来，
 *   而当时工具条被键盘盖着（dvh 不管键盘，见底栏的 margin-bottom），于是「只能先收
 *   键盘才点得到、点一下又弹出来」；
 * - 于是改成手机端 `blur()`：又变成「点一下键盘就没了」，用户每发一个快捷键都得
 *   重新唤一次键盘。
 *
 * 正解是**尊重用户当下的状态**：按下时终端有焦点（键盘开着）就补一次 focus ——
 * 因为 touch 期间浏览器会先把 textarea blur 掉，不补键盘就真收了；按下时没焦点
 * （用户自己收起了键盘）就什么都别做，别把键盘招回来。判据在 `hadFocusRef`。
 */
  const handleAction = useCallback(
    (token: string): void => {
      const m = modsRef.current
      const seq = specialSeq(token, m)
      if (seq) sendInput(seq)
      if (hasAnyMod(m)) resetMods()
      // 键盘开着就补回焦点（抵消 touch 期间的浏览器 blur）；关着就留着关
      if (hadFocusRef.current) termRef.current?.focus()
    },
    [resetMods, sendInput]
  )

  /** 管理浮层里点某条历史：把命令原样写进终端（等同键入，不代按回车） */
  const insertHistoryCommand = useCallback(
    (cmd: string): void => {
      setHistoryOpen(false)
      sendInput(cmd)
      termRef.current?.focus()
    },
    [sendInput]
  )

  /** 删除单条历史（管理浮层的行内按钮）：按作用域走 SSH / 宿主本机 / 项目那三份 */
  const deleteHistoryEntry = useCallback(
    (cmd: string): void => {
      if (!historyScope) return
      const api = useAgentStore.getState().getApi()
      if (!api) return
      // 先本地摘掉（浮层立刻少一行），服务端确认后再用全量对齐
      setHistoryEntries(historyRef.current.filter((e) => e.cmd !== cmd))
      void (historyScope.kind === 'ssh'
        ? api.deleteSshTerminalHistory(cmd)
        : historyScope.kind === 'local'
          ? api.deleteLocalTerminalHistory(cmd)
          : api.deleteTerminalHistory(historyScope.id, cmd)
      )
        .then((res) => setHistoryEntries(res.entries ?? []))
        .catch(() => refreshHistory())
    },
    [historyScope, setHistoryEntries, refreshHistory]
  )

  /** 清空本作用域的全部历史（项目那份 = 本项目；SSH / 宿主本机那份 = 各自的全局历史） */
  const clearAllHistory = useCallback((): void => {
    if (!historyScope) return
    const api = useAgentStore.getState().getApi()
    if (!api) return
    setHistoryEntries([])
    void (historyScope.kind === 'ssh'
      ? api.clearSshTerminalHistory()
      : historyScope.kind === 'local'
        ? api.clearLocalTerminalHistory()
        : api.clearTerminalHistory(historyScope.id)
    ).catch(() => refreshHistory())
  }, [historyScope, setHistoryEntries, refreshHistory])

  /** 开 / 关历史管理浮层；打开时顺手刷新一遍（别的终端标签可能刚记了新命令） */
  const toggleHistory = useCallback((): void => {
    setHistoryOpen((open) => {
      if (!open) refreshHistory()
      return !open
    })
  }, [refreshHistory])

  /**
   * 悬浮球（`TerminalFab`）里的动作：外层挂进来的（终端标签里的 AI 助手）在前，
   * 终端自己的「命令历史」在后 —— 只有项目终端 / SSH 主机终端 / 宿主本机终端才有历史
   * 作用域，容器工作台与容器内终端不出现这一项。
   */
  const fabActions = useMemo<TerminalAction[]>(() => {
    const list = [...externalActions]
    if (historyScope) {
      list.push({
        key: 'history',
        label: '命令历史',
        icon: <History className="size-4" />,
        onClick: toggleHistory,
        active: historyOpen
      })
    }
    return list
  }, [externalActions, historyScope, toggleHistory, historyOpen])

  /**
   * 终端**建好**且这个标签**被看着**时自动 focus：新连上的终端、刚重开的会话、刚切回来的
   * 标签，一律落上焦点，用户可以直接敲，不用先点一下。
   *
   * ⚠️ 依赖里必须带 `termEpoch`（实例世代）：只依赖 `visible` 时，本 effect 在挂载那一刻
   * 就跑完了，而那时 `termRef.current` 还是 null（建 term 的 effect 排在它后面）→ 直接
   * return，于是「刚连上的终端」反而不聚焦（踩过）。
   *
   * 直接 `term.focus()` 不稳：面板从收起态展开是宽度 0 → W 的过渡，那一瞬容器的渲染高度
   * 可能还是 0，focus 会被浏览器拒收 / 看不到光标。做法：轮询等容器高度 `> 0` 再 focus，
   * 再挂一个 ~250ms 兜底，万一面板被别的样式盖住 / 过渡异常也至少聚焦一次。
   */
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return
    let raf = 0
    let done = false
    let fallback = 0
    const focusNow = (): void => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
      term.focus()
    }
    const tick = (): void => {
      if (container.getBoundingClientRect().height > 0) {
        focusNow()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    fallback = window.setTimeout(focusNow, 250)
    return () => {
      done = true
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
    }
  }, [visible, termEpoch])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 换 shell / 退出重开 = 重建会话：上一条会话残留的预测下拉与缓冲一并清掉
    //（换 shell 的 kill 不走 onExit，那边的清理接不住这条路）
    clearInputTracking()
    // 重建会话 = 重新连接：连接进度浮层回到初始（新会话的进度会由 onProgress 重新推来）
    setConnectProgress(null)
    /*
     * 标签条上换黄点：从这里开始算「在连」，一直到 `settleConnect`（`ready` 帧 / 首帧输出）
     * 才转绿。写在 try 之前 —— 连建连都还没开始的那一瞬，也不该挂着上一次的绿（重开一条
     * 终端时那个绿点是**上一条**会话留下的，会让人以为已经好了）。
     */
    if (tabKey) setTerminalPhase(tabKey, 'connecting')

    const term = new Terminal({
      fontSize,
      lineHeight: 1.25,
      /*
       * 能往上翻多少行（设置 → 终端 → 滚动缓冲）。不写就是 xterm 的默认 1000 行 ——
       * 一次 `npm test` / `cat 大文件` 就顶满，再往上就没了。
       * 创建期先按当前偏好设一次；之后改设置由上面那个 effect 直接写 `term.options`。
       */
      scrollback: getTerminalScrollback(),
      /* 终端字体栈与 dogi（上级目录）保持一致：Cascadia Mono 优先（Windows Terminal /
         VS 自带，字形最接近现代终端），依次回落 JetBrains Mono → Consolas → Courier New。
         原来的 `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, …` 是 macOS 优先的栈，
         在 Windows 上实际落到 Consolas —— 这就是两边终端「看着不一样」的原因。
         改这里只影响 xterm 自身（终端字体是 xterm 的独立选项，不吃全局 CSS 字体）。 */
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      convertEol: false,
      // xterm 6 的滚动条是自绘的（VS Code ScrollableElement），宽度没有独立选项，
      // 取的是 overviewRuler.width（默认 14）。收到 10，与 styles.css 里全局细滚动条一致
      overviewRuler: { width: 6 },
      /**
       * 背景透明：`buildTheme()` 给的 `background` 是全透明的，终端自己不画底 ——
       * 透出宿主容器那层 `bg-background` / `bg-surface-1`（配了背景图 / 视频时它就是
       * 主题遮罩），于是终端和对话区的底色是同一块，背景不会到终端就断掉。
       *
       * ⚠️ 这个开关**必须开**：它的语义就是「背景是否支持非不透明色」，默认 `false` 时
       * 给 `rgba(…, 0)` 也照样画成一块实色。它是**创建期选项**（必须在 `term.open()` 之前
       * 设好，之后改不了），所以写在 new Terminal 里而不是 theme 里。
       * 代价是每帧清屏不能走不透明快路径，对终端这种小面积刷新可以忽略。
       */
      allowTransparency: true,
      theme: buildTheme(container)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // URL 链接：仅在 Ctrl/Cmd + 左键时打开，避免普通点击误触；handled 由 addon 在
    // 链接命中时回调，这里自己判断修饰键（默认实现是单击即开）。
    // ⚠️ 必须走 `openExternal`（desktop = 主进程 `shell.openExternal` 拉起系统浏览器），
    // 不能裸调 `window.open` —— 主进程两个窗口都没注册 `setWindowOpenHandler`，
    // 渲染端的 `window.open` 会被 Electron 兜底成**新建一个内置 BrowserWindow**（无地址栏），
    // 就是「Ctrl+左键点 URL 弹出内置窗口而非系统浏览器」的根因。
    // web 端 `openExternal` 内部仍是 `window.open`（新标签页），行为不变。
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.ctrlKey && !event.metaKey) return
        void openExternal(uri)
      })
    )
    /**
     * 按键接管：Ctrl+C 三闸、Ctrl+±/0 缩放、退出后回车重开 —— 见 `terminal-key-handler.ts`。
     * 处理器挂在 xterm 实例上，实例 dispose 时一起没，所以这里不需要卸载。
     */
    attachTerminalKeyHandler({
      term,
      exitedRef,
      restart,
      processRef,
      zmodemRef,
      fontSizeRef,
      inputBufRef,
      applyFontSize,
      resetFontSize: () => applyFontSize(scalePx(DEFAULT_FONT_SIZE)),
      clearInputTracking
    })
    term.open(container)
    // 中文输入法在光标处向右展开组合串，一旦越过屏幕右缘，浏览器为露出焦点会把
    // 整页横向滚动（TUI 被挤到左边）—— 这里把组合串回拉到屏幕内，见 lib/terminal-ime.ts
    const unclampIme = clampCompositionOverflow(container)
    term.focus()
    termRef.current = term
    // 实例就位信号：让「自动 focus」那个 effect 醒来（见 termEpoch 的注释）
    setTermEpoch((n) => n + 1)
    fitRef.current = fit

    /**
     * 滚轮缩放 / 右键粘贴 / 选中即复制：三条只挂在 DOM 上、跟会话生命周期无关的交互，
     * 见 `terminal-interactions.ts`（那边解释了为什么两处监听都必须走 capture）。
     *
     * 右键粘贴失败（剪贴板权限被拒）只在这里挂一条 4 秒自动消失的横栏提示；粘成功不打扰。
     */
    let pasteHintTimer: number | null = null
    const showPasteHint = (text: string): void => {
      if (pasteHintTimer !== null) window.clearTimeout(pasteHintTimer)
      setPasteHint(text)
      pasteHintTimer = window.setTimeout(() => {
        pasteHintTimer = null
        setPasteHint(null)
      }, 4000)
    }
    const detachInteractions = attachTerminalInteractions({
      term,
      container,
      fontSizeRef,
      applyFontSize,
      sendInput,
      onPasteFailed: () => {
        // 浏览器（非 Electron）下 `readText` 可能弹权限框、用户拒了会 reject
        showPasteHint('读取剪贴板失败（需要剪贴板权限），可改用 Ctrl+V')
      },
      // 异步读剪贴板期间可能已经拆掉终端（换 shell / 关标签）
      isCurrent: () => termRef.current === term
    })

    /**
     * 触摸滚动：手指拖动翻 scrollback。
     *
     * 为什么非得自己挂：xterm.js 6 的 DOM 里**没有可滚的容器**（`.xterm-viewport` 是个空
     * div），它的滚动完全由滚轮 / 自定义滚动条程序化驱动 —— 触摸拖动原样是什么都不会发生。
     * 详见 `lib/terminal-touch-scroll.ts` 里那段 DOM 结构说明。
     *
     * 判定放在这个 effect 里（只在客户端跑）：不用担心 SSR，也不必为它单开一个 state ——
     * 手势跟 term 同寿命，term 拆了就一起退（纯鼠标设备上 supportsTouch 为假，什么都不挂）。
     */
    // 单指拖动翻 scrollback、双指捏合缩放字号（getFontSize 取当前字号作缩放基准，
    // onZoom 收到目标字号后由 applyFontSize 夹到 [MIN,MAX] 并走 fit）
    const detachTouchScroll = supportsTouch()
      ? attachTerminalTouchScroll(term, container, {
          getFontSize: () => fontSizeRef.current,
          onZoom: (size) => applyFontSize(size)
        })
      : null

    // 容器尺寸变化 → 重新 fit → 回写 PTY 尺寸（面板拖拽 / 窗口缩放共用这一条路）
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 容器尺寸为 0（还没布局完）时 fit 会抛错，忽略即可
        return
      }
      processRef.current?.resize(term.cols, term.rows)
      // 容器变了对预测下拉框重新定位（还开着的话）
      positionDropdown()
    })
    observer.observe(container)

    // 跟随主题：`<html>` 上挂 `class="dark"`（明暗）与 `data-theme="ocean"`（配色），
    // **两个都要盯** —— 只盯 class 的话，在同一明暗档里换配色主题，终端底色还停在旧主题。
    const themeObserver = new MutationObserver(() => {
      term.options.theme = buildTheme(container)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme']
    })

    // ---------- ZMODEM（rz/sz）----------
    /**
     * 传输层整个交给控制器（见 `zmodem-controller.ts`）：入站字节 → `consume()`，
     * Ctrl+C → `interrupt()`，拖放进来的文件 → `dropFiles()`。会话引用、取消标志、
     * 排水窗口都成了那边的私有变量，这里只留一个浮层状态。
     *
     * ⚠️ 必须建在「开进程」**之前**：Sentry 要先挂上才能接管第一帧输出（它靠扫入站字节嗅探）。
     */
    const zm = createZmodemController({
      term,
      processRef,
      enabled: zmodemEnabled,
      charset: sshCharset,
      onState: setZmodem,
      onDropActive: setDropActive
    })
    zmodemRef.current = zm

    // 开进程：PTY 初始尺寸用 fit 出来的实际值
    try {
      fit.fit()
    } catch {
      // 首帧布局未完成时容忍默认尺寸
    }
    try {
      // SSH 主机：走宿主 / 服务端的 SSH 通道（只说 hostId，凭据不出服务端）；
      // 本机终端：走 openTerminal 覆盖（容器工作台）或服务端 PTY，需要 cwd
      const proc = sshHostId
        ? openSshTerminal({
            hostId: sshHostId,
            cols: term.cols,
            rows: term.rows,
            // 远端工作区打开的终端：shell 就绪后切到该目录（缺省 = 登录目录）
            ...(cwd ? { cwd } : {})
          })
        : (openTerminal ?? openServerTerminal)({
            cwd: cwd ?? '',
            cols: term.cols,
            rows: term.rows,
            // shellId 为 null = 跟随服务端平台默认；传 undefined 而不是 null（服务端的判定是 `?: string`）
            ...(shellId ? { shellId } : {}),
            // 额外启动参数 / 启动后自动命令：只有本机终端这条分支用得上（SSH 分支上面已分走）
            ...(args?.length ? { args } : {}),
            ...(autoCommand ? { autoCommand } : {}),
            // 容器型项目：服务端据此把 spawn 换成 `docker exec`（桌面端也消费：经 IPC 桥
            // 连进程内后端，见 desktop host.ts 的 openBridgeContainerTerminal）
            ...(containerWorkspaceId ? { containerWorkspaceId } : {}),
            ...(containerShell ? { containerShell } : {})
          })
        processRef.current = proc
        /*
         * ⚠️ 这里**不**标绿（黄点已在 effect 开头写过）：`processRef` 有值只说明「进程对象
         * 建出来了」，SSH 还要握手 / 认证 / 起 shell，web 端本机终端还要等 WS 建连 + spawn。
         * 以前在这一行就 `setTerminalPhase(…, 'alive')`，用户在连接进度卡片还转着的时候
         * 已经看见绿点了（用户报过）。什么时候换绿见下面的 `settleConnect`。
         */
        /**
         * SSH 建连进度：只有 SSH 终端实现了 `onProgress`（本机 / 容器终端没有这条通道）。
         * 收到 `ready` 即代表连上，收起进度卡片；其余阶段刷新卡片。
         * ⚠️ 换会话后旧进程的 progress 会晚一拍回来，用 `processRef` 判当前会话（同 onExit）。
         */
        let connectSettled = false
        /**
         * 原始输出缓冲的**字节解码器**（只喂 `rawOutputRef`，不参与渲染 —— 渲染那条路
         * 由 ZMODEM 控制器负责，见下面的 `zm.consume`）。
         *
         * ⚠️ `onData` 给的是 `Uint8Array`。直接 `raw.text += data` 会走
         * `Array.prototype.toString`，把整段输出拼成「3,10,45,45,…」一串逗号分隔的数字
         * —— 终端助手 `run_in_terminal` 读到的就是这串数字（用户实测的症状）。
         *
         * 流式解码还顺带修正了量纲：`raw.offset` 从此按**字符**累计，与 `raw.text.length`
         * 同量纲，`readSince` 的切片才不会在中文 / emoji 上切歪（按字节算必然错位）。
         */
        const rawDecoder = new TextDecoder(sshCharset)
        /**
         * 连上了：收起连接进度卡片 + 标签条换绿点。
         *
         * 两个入口共用（**同一处判定，别分叉**）：SSH 的 `ready` 帧、以及首帧输出
         * —— 本机 / 容器终端没有 `onProgress`，首帧输出是唯一能观测到的「shell 起来了」。
         * 重复调用无害（`setTerminalPhase` 同值不通知）。
         */
        const settleConnect = (): void => {
          connectSettled = true
          setConnectProgress(null)
          if (tabKey) setTerminalPhase(tabKey, 'alive')
        }
        /**
         * 运行脚本：终端就绪时把待写入的脚本输入（逐行回车）写进 PTY，写一次即清空。
         * SSH 由 `ready` 帧触发，本机终端由首帧输出触发（见下面的调用点）。
         */
        const flushScriptInput = (): void => {
          const pending = scriptPendingRef.current
          if (!pending || processRef.current !== proc) return
          scriptPendingRef.current = null
          try {
            proc.write(pending)
          } catch {
            // 写入失败（进程刚没了）：忽略，脚本没跑成也不该让终端报错
          }
        }
        const offProgress = proc.onProgress?.((progress) => {
          if (processRef.current !== proc) return
          if (progress.stage === 'ready') {
            settleConnect()
            flushScriptInput()
            return
          }
          if (!connectSettled) setConnectProgress(progress)
        })
        /**
         * 输出：PTY → xterm 渲染；输入：键盘 / 粘贴 → PTY（漏了这条终端就只能看不能敲）。
         */
        const offData = proc.onData((data) => {
          // 输出活动（AI 工具的「安静了没有」靠它）：记在原始数据到达这一层，
          // 不管下面 ZMODEM 怎么处理
          outputActivityRef.current.seq += 1
          outputActivityRef.current.at = Date.now()
          // 原始输出留一份给 AI 工具取增量（见 rawOutputRef 的说明）。
          // 摊还裁剪：超过 2 倍上限才切一次，别让每个 chunk 都拷一遍几十 KB
          const raw = rawOutputRef.current
          const chunk = rawDecoder.decode(data, { stream: true })
          raw.offset += chunk.length
          raw.text += chunk
          if (raw.text.length > RAW_OUTPUT_KEEP * 2) raw.text = raw.text.slice(-RAW_OUTPUT_KEEP)
          // 收到首帧输出 = 连接已就绪（`ready` 帧之外再兜一道）：收起进度卡片、标签条换绿点
          if (!connectSettled) settleConnect()
          // 本机终端没有 `onProgress`：首帧输出就是「shell 起来了」的信号，在这里补写脚本
          flushScriptInput()
          /*
           * 输出统一交给 ZMODEM 控制器：排水期丢弃、挂了嗅探器就过 Sentry、
           * 没挂（容器工作台）直接写终端 —— 三条路都在 `consume` 里（见 zmodem-controller.ts）。
           * SSH 非 UTF-8 会话的解码也在那边做。
           */
          zm.consume(data)
        })
        const offExit = proc.onExit((code, reason) => {
          /**
           * ⚠️ 只认「当前这条会话」的退出。换会话（退出后重开 / 换了工作区）时旧进程的 exit
           * 会晚一拍回来，而这个组件实例还活着 —— 不判断就会在新终端上盖一个
           * 「● 会话已结束（退出码 -1）」，看着就像「重开没生效」（用户实测反馈）。
           */
          if (processRef.current !== proc) return
          exitedRef.current = true
          // 标签条上换红点（同理只认当前这条会话的退出，旧进程晚一拍的 exit 已经在上面的
          // 守卫里 return 了）
          if (tabKey) setTerminalPhase(tabKey, 'exited')
          // 连接还没就绪就退出了（建连失败 / 认证失败）：进度卡片收起，错误行由下面写进终端
          setConnectProgress(null)
          // 预测还挂着的话收起来：shell 都没了，缓冲也不再有意义
          clearInputTracking()
          /**
           * 断开提示**直接写进终端**（不占终端上方那条横栏）。`reason` 有值 = 不是 shell
           * 自己退出（连接断了 / 启动失败），这时 `code` 只是宿主编的兜底值（web 端恒为 -1），
           * 显示出来只会让人猜「-1 是什么意思」—— 有 reason 就只说 reason。
           *
           * 写完把焦点还给终端，用户直接按 Enter 就能重开（见 customKeyEventHandler）。
           * ⚠️ 这里（以及 restart 之前）**不要**写「正在重连…」那种话：restart() 是把整个
           * term 拆掉重建，那行字当场就没了，等新会话出来也没有可承接它的位置。
           */
          term.write(
            `\r\n\x1b[33m● ${reason ?? `会话已结束（退出码 ${code}）`}\x1b[0m\r\n` +
              '\x1b[90m  按 Enter 重连\x1b[0m\r\n'
          )
          term.focus()
        })
        // 输入：键盘 / 粘贴 / 手机快捷键条统一走 sendInput（预测拦截 + 缓冲跟踪 + 写 PTY）
        const inputSub = term.onData((data) => {
          const m = modsRef.current
          // 粘连修饰键（Ctrl/Alt/Shift）作用于下一次软键盘字符：Ctrl 清高位成控制字符，
          // Alt 前缀 ESC；发完即复位，避免后续普通输入仍被 modifiers 污染。
          // 控制字符会让缓冲跟踪重置 —— 这正是想要的：组合键之后缓冲本来就对不上了。
          if (hasAnyMod(m)) {
            sendInput(transformChar(data, m))
            resetMods()
            return
          }
          sendInput(data)
        })
        // 四路订阅一起退：onData / onExit / onProgress 闭包着**已经 dispose 的 term** 与组件状态，
        // 留着会在下次 effect 重建后继续往里写（原来只退了输入这一路）
        cleanupSubs = () => {
          inputSub.dispose()
          offData()
          offExit()
          offProgress?.()
        }
        // 通知宿主（快捷功能的 runCommand 在等这个进程；写入会被 ConPTY 缓冲到 shell 就绪）
        onReadyRef.current?.(proc)
    } catch (err) {
      // 保留堆栈：下面那条只显示 message，而 `RangeError: Maximum call stack size exceeded`
      // 这种「看起来像别处出的错」必须能看帧才查得动（安卓侧从 chrome://inspect 或 logcat 取）
      console.error('终端启动失败', err)
      setError(err instanceof Error ? err.message : String(err))
      // 连进程都没起来：标签条上同样是「这条终端没了」，与 shell 退出同一个红点
      if (tabKey) setTerminalPhase(tabKey, 'exited')
    }

    return () => {
      detachInteractions()
      if (pasteHintTimer !== null) window.clearTimeout(pasteHintTimer)
      detachTouchScroll?.()
      unclampIme()
      cleanupSubs?.()
      observer.disconnect()
      themeObserver.disconnect()
      // ZMODEM：会话随 term / PTY 一起拆，控制器连同浮层状态一并清掉
      //（传输不可能跨会话重建存活，把残留的进度条留在新终端上只会骗人）
      zm.dispose()
      zmodemRef.current = null
      dropDepthRef.current = 0
      // 拖拽上传：会话拆了（换主机 / 重开 / 关标签）就把确认条收掉。
      // ⚠️ **正在传的那些不管**：传输已经交给引擎，进度 / 取消都在传输徽标里 —— 关掉一个
      // 终端标签不该顺手掐掉传到一半的文件（用户可以在清单里自己决定）。
      // `lastUploadDirRef` **不清**：重连之后用户多半还想传到同一个目录。
      setSftpDrop(null)
      processRef.current?.kill()
      processRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // cwd 变化由调用方用 key 重建本组件（= 换个工作区换条终端），不进依赖；
    // sessionSeq 变化 = 退出后「重新打开」，shellId 变化 = 换了终端类型，
    // sshHostId 变化 = 换了 SSH 主机，都要把整个 effect（term + PTY）重建一遍；
    // workspaceId 同理（换项目 = 换 cwd）；args 用 join 出来的字符串比（数组身份不可靠）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTerminal, cwd, sessionSeq, shellId, workspaceId, sshHostId, sshCharset, autoCommand, args?.join('\u0000'), containerWorkspaceId, containerShell])

  /**
   * 字号变化（滚轮 / Ctrl± 触发）：写进 xterm 并重新 fit + 回写 PTY 尺寸。
   * 挂载时也会跑一次（与创建时设的字号一致，再 fit 一次无害）。
   */
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    try {
      fit.fit()
    } catch {
      // 布局未就绪（容器高 0）时忽略
    }
    processRef.current?.resize(term.cols, term.rows)
  }, [fontSize])

  /**
   * 拖放该由谁处理：
   * - `zmodem` —— 远端 `rz` 正在等文件（老路径，优先 —— 用户已经在等我们发文件了）；
   * - `none`   —— 有 ZMODEM 会话正在传（两套通道同时跑会互相干扰），或本机终端（没有远端）；
   * - `sftp`   —— SSH 终端且没在传文件（新路径）。
   */
  const dropMode: 'zmodem' | 'none' | 'sftp' = zmodem
    ? zmodem.awaitingFiles
      ? 'zmodem'
      : 'none'
    : sshHostId
      ? 'sftp'
      : 'none'

  /** 往终端里写一行 ● 提示（与「会话已结束」「已取消连接」同一套约定） */
  const writeHint = (text: string, color = '33'): void => {
    termRef.current?.write(`\r\n\x1b[${color}m● ${text}\x1b[0m\r\n`)
  }

  /**
   * 拖进来的文件 → 起一条 SFTP 上传：先连一次拿远端家目录当目标目录初值，再让用户确认。
   *
   * **「先连上再问目录」是刻意的**（同 dogi）：连不上（主机被删 / 认证失败 / 跳板不通）
   * 就得当场说清楚，而不是等用户填完目录、点了上传才失败 —— 那时他已经做了一轮无用功。
   * 所以哪怕有记住的目录，也照样先解析一次（顺带把连接建起来）。
   */
  const beginSftpDrop = (files: File[]): void => {
    const hostId = sshHostId
    if (!hostId) return
    setSftpDrop({ files, dir: lastUploadDirRef.current ?? '', phase: 'connecting' })
    void (async () => {
      try {
        // 家目录是兜底初值；用户上次改过的话按他上次的来
        const home = await app.sftpRealpath(hostId)
        setSftpDrop((p) =>
          p ? { ...p, dir: lastUploadDirRef.current || home, phase: 'ready' } : p
        )
      } catch (err) {
        setSftpDrop((p) =>
          p
            ? {
                ...p,
                phase: 'connectFailed',
                error: err instanceof Error ? err.message : String(err)
              }
            : p
        )
      }
    })()
  }

  /** 关掉确认条（纯关闭，不影响已经在跑的上传 —— 那在清单里） */
  const dismissSftpDrop = (): void => {
    setSftpDrop(null)
    termRef.current?.focus()
  }

  /**
   * 确认目标目录并开始上传。
   *
   * 确认之后**立刻收起确认条**：进度、速度、取消、失败原因全在状态栏的传输徽标里，这条
   * 只负责「传到哪个目录」。留着它既挡住终端，又和清单显示同一件事。
   *
   * ⚠️ **串行**逐文件传（`for` + `await`，**不是** `Promise.all`）：一次拖入几十个文件时
   * 并发会把连接与内存打满，而且同一文件内部分片本来就是串行的，并发只会互相抢带宽。
   */
  const confirmSftpUpload = async (): Promise<void> => {
    const state = sftpDrop
    const hostId = sshHostId
    if (!state || !hostId) return
    const dir = state.dir.trim()
    if (!dir) return

    // 用户确认过这个目录了，记下来当下次的默认值（同 dogi：连着拖几次不用重填）
    lastUploadDirRef.current = dir
    setSftpDrop(null)
    termRef.current?.focus()

    let done = 0
    let failed = 0
    for (const file of state.files) {
      const outcome = await runUpload({
        file,
        hostId,
        hostLabel: sshHost?.name ?? hostId,
        dir
      })
      if (outcome === 'done') done += 1
      else if (outcome === 'failed') failed += 1
      // canceled：用户自己点的取消，不是失败，也不进终场提示
    }

    // 终端里留一行小结（滚上去也还看得见）；逐项的细节在清单里
    if (done) writeHint(`已上传 ${done} 项到 ${dir}`, '32')
    if (failed) writeHint(`有 ${failed} 项上传失败（详见状态栏的传输徽标）`, '31')
  }

  return (
    /**
     * 底色**不在这里画**（`bg-transparent`）：xterm 的 `theme.background` 是全透明的
     * （见 `terminal-theme.ts`），终端要透出的是**宿主容器**那层底 —— 侧栏里是
     * `SidePanel` 的 `bg-surface-1`，整页终端是画布那层 `bg-background`。这里再画一层
     * `bg-background` 的话，两层遮罩（0.86 × 0.72）叠成 0.96，配了背景图 / 视频也几乎
     * 看不见 —— 那就白透明了。
     *
     * 下面的 `pasteHint` / 连接浮层 / 底部工具栏各自带底色，不受这条影响。
     */
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {/* 右键粘贴失败提示：几秒后自己消失，点一下就关（不拦终端本身的交互） */}
      {pasteHint && (
        <div className="flex items-center justify-between gap-2 border-b bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span className="truncate">{pasteHint}</span>
          <button
            type="button"
            className="shrink-0 rounded px-1 hover:bg-foreground/10"
            onClick={() => setPasteHint(null)}
          >
            知道了
          </button>
        </div>
      )}
      {/* 容器不随可见性卸载：xterm 重建会丢渲染状态（会话在宿主 / 服务端活着） */}
      {/* 注意：不要在这里 onKeyDownCapture stopPropagation —— React 合成事件的
          stopPropagation 会调用原生 event.stopPropagation()，把 keydown 挡死在
          xterm 的 textarea 之前，所有 Ctrl 组合键（中断 / 控制序列）就全废了。
          应用级快捷键由 AgentApp 在 window 捕获阶段处理，本就不受这里影响。 */}
      {/* `touch-none`：把手势交给自实现的触摸滚动（见上面那个 attachTerminalTouchScroll）。
          touch-action 只管触摸输入，纯鼠标设备上一成不变。
          relative：预测下拉框 / 历史管理浮层都锚在这个容器里（按光标 / 右上角定位）。 */}
      <div
        ref={containerRef}
        className={cn(
          'relative min-h-0 flex-1 touch-none px-2',
          // 拖放高亮：真有文件悬在终端上、且这次拖放有地方可去时才亮
          dropActive && 'rounded-md ring-2 ring-inset ring-primary/60'
        )}
        /*
         * 拖放投放，两条路（由 `dropMode` 决定）：
         * - `zmodem`：远端 `rz` 正在等文件 → 喂给现有 ZMODEM 通道（老路径，优先级最高）；
         * - `sftp`  ：SSH 终端且没在传文件 → 起一条 SFTP 上传（先连一次拿家目录，再让用户确认）。
         *
         * 三点讲究：
         * - `dragover` 必须 `preventDefault`，否则浏览器压根不派发 `drop`；
         * - **没地方可去时也拦掉带文件的拖放**，但 `dropEffect = 'none'` —— 不拦的话浏览器会
         *   **导航到那个文件**，整个应用被顶掉（与 composer 里那道窗口级护栏同一个理由）；
         * - ZMODEM 正在传时不接管（`dropMode === 'none'`）：两套通道同时往远端写容易互相干扰。
         */
        onDragEnter={(e) => {
          if (dropMode === 'none') return
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          // 计数抵消在子元素之间移动时反复 enter/leave 的抖动
          dropDepthRef.current += 1
          setDropActive(true)
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = dropMode === 'none' ? 'none' : 'copy'
        }}
        onDragLeave={() => {
          if (dropMode === 'none') return
          dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
          if (dropDepthRef.current === 0) setDropActive(false)
        }}
        onDrop={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          dropDepthRef.current = 0
          setDropActive(false)
          if (dropMode === 'none') return
          const files = Array.from(e.dataTransfer.files)
          // 拖进来的不是文件（例如拖了一段选中的文本）→ 忽略，不打扰
          if (files.length === 0) return
          if (dropMode === 'zmodem') {
            zmodemRef.current?.dropFiles(files)
            return
          }
          // 确认条还开着就又拖了一批进来：直接换成新的这批，别叠成两条
          beginSftpDrop(files)
        }}
      >
        {/*
          SSH 连接进度：铺一层与终端同底色的遮罩，居中浮一张进度卡片 —— 连接期间终端是空的，
          盖住它反而更清楚（否则先露出空光标，像是卡住了）。`ready` / 首帧输出 / 退出即收起。
        */}
        {connectProgress && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-background p-4">
            {showConnect && <SshConnectCard progress={connectProgress} onCancel={cancelConnect} />}
          </div>
        )}
        {/*
          拖放高亮的文案层。`pointer-events-none` 不能省：不加的话这一层会**接住**拖拽事件，
          容器上的 dragenter/dragleave 计数就乱了（dogi 同款处理）。
        */}
        {dropActive && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10">
            <div className="rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs text-foreground shadow">
              {dropMode === 'sftp' ? '松手即可上传到远端（SFTP）' : '松手即发送（rz/sz）'}
            </div>
          </div>
        )}
        {/*
          ZMODEM（rz/sz）传输进度：浮在终端上方居中。传输期间手动输入被拦掉
          （见 sendInput），所以这条是「现在只有传输在动」的唯一提示；✕ / Ctrl+C 取消。
        */}
        {zmodem && (
          <div
            className={cn(
              'absolute top-3 left-1/2 z-20 w-72 -translate-x-1/2 rounded-md border bg-card/95 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur',
              // 「等文件」态用虚线框：一眼分明这是「等你给文件」而不是「正在传」
              zmodem.awaitingFiles ? 'border-dashed border-primary/60' : 'border-border'
            )}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">
                {zmodem.direction === 'upload' ? '↑ 上传' : '↓ 下载'}：
                {zmodem.awaitingFiles ? '等待文件' : zmodem.name || '…'}
              </span>
              {!zmodem.awaitingFiles && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.round(zmodem.progress)}%
                </span>
              )}
              <IconTip label="取消传输">
                <button
                  type="button"
                  aria-label="取消传输"
                  // preventDefault：点击不抢走终端焦点（与预测下拉同款）
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => zmodemRef.current?.cancel()}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </IconTip>
            </div>
            {zmodem.awaitingFiles ? (
              // 没有进度可看：给两条出路 —— 拖进终端 / 重开系统选框（系统框那条路仍在）
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-muted-foreground">把文件拖进终端，或</span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => zmodemRef.current?.pickFiles()}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-foreground transition-colors hover:bg-secondary"
                >
                  选择文件
                </button>
              </div>
            ) : (
              <>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-150',
                      zmodem.direction === 'upload' ? 'bg-emerald-500' : 'bg-sky-500'
                    )}
                    style={{ width: `${zmodem.progress}%` }}
                  />
                </div>
                <div className="mt-1 truncate text-muted-foreground">{zmodem.text}</div>
              </>
            )}
          </div>
        )}
        {/*
          拖拽上传（SFTP）确认条：浮在终端上方居中。
          目标目录**必须让用户过一眼** —— 终端当前工作目录拿不到（shell 默认不发 OSC 7、
          解析提示符不可靠），默认只能给远端家目录。「传到哪」是用户最可能想改的一项，
          所以它不该是个悄无声息的后台动作。
          ⚠️ 它只管「传到哪个目录」：确认之后立刻收起，进度 / 速度 / 取消全在状态栏那颗
          传输徽标里（`TransferBadge`），这里不再画进度条。
        */}
        {sftpDrop && (
          <div className="absolute top-3 left-1/2 z-20 w-96 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md border border-border bg-card/95 p-3 text-xs text-foreground shadow-lg backdrop-blur">
            <div className="mb-2 flex items-center gap-2">
              <Upload className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">
                上传 {sftpDrop.files.length} 项到远端
              </span>
              <IconTip label="关闭">
                <button
                  type="button"
                  aria-label="关闭"
                  // preventDefault：点击不抢走终端焦点（与预测下拉同款）
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={dismissSftpDrop}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </IconTip>
            </div>

            {sftpDrop.phase === 'connecting' ? (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在连接 SFTP…
              </div>
            ) : sftpDrop.phase === 'connectFailed' ? (
              <div className="space-y-2">
                <div className="break-all text-destructive">连接失败：{sftpDrop.error}</div>
                <div className="text-muted-foreground">关闭后重新拖入即可重试</div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={dismissSftpDrop}
                  >
                    关闭
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <label className="mb-1 block text-muted-foreground" htmlFor="sftp-drop-dir">
                  目标目录
                </label>
                <Input
                  id="sftp-drop-dir"
                  autoFocus
                  value={sftpDrop.dir}
                  placeholder="远端目录，如 /root"
                  onChange={(e) => setSftpDrop((p) => (p ? { ...p, dir: e.target.value } : p))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmSftpUpload()
                    else if (e.key === 'Escape') dismissSftpDrop()
                  }}
                  className="h-7 text-xs"
                />
                {sftpDrop.phase === 'failed' && sftpDrop.error && (
                  <div className="mt-1 break-all text-destructive">{sftpDrop.error}</div>
                )}
                <div className="mt-2 flex items-center justify-between gap-2">
                  {/* 与 dogi 同一句提示：拖进来的文件夹会作为同名子目录传上去 */}
                  <span className="truncate text-muted-foreground">目标目录不存在时会逐层创建</span>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={dismissSftpDrop}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={!sftpDrop.dir.trim()}
                      onClick={() => void confirmSftpUpload()}
                    >
                      上传
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {/* 命令预测下拉框：按光标位置浮在终端上；开着时 → 接受、Ctrl+↑/↓ 换选（见 sendInput） */}
        {suggestions && (
          <div
            ref={dropdownRef}
            style={pos ? { top: pos.top, left: pos.left } : undefined}
            className="absolute z-10 max-h-56 w-80 overflow-y-auto rounded-md border border-border bg-popover/95 p-1 text-xs shadow-lg backdrop-blur"
          >
            <div className="px-2 py-1 text-muted-foreground">
              命令预测 · → 接受 · Ctrl+↑/↓ 选择 · Esc 收起
            </div>
            {suggestions.items.map((item, i) => {
              const buf = suggestions.buf
              const rest = item.slice(buf.length)
              return (
                <button
                  key={item}
                  type="button"
                  // preventDefault：点击不抢走终端焦点，光标不闪、输入不断
                  onMouseDown={(e) => {
                    e.preventDefault()
                    activeIndexRef.current = i
                    acceptSuggestion()
                    termRef.current?.focus()
                  }}
                  className={cn(
                    'flex w-full items-center rounded px-2 py-1 text-left',
                    i === suggestions.index
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary'
                  )}
                >
                  {/* 两段文字留在同一个元素里：button 是 flex 容器，拆成两个子 span
                      会各自成为块容器，边界空格落在行盒边缘被裁掉（显示成「gitstatus」） */}
                  <span className="truncate">
                    {buf}
                    <span className="font-medium text-primary">{rest}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {historyScope && historyOpen && (
          <div className="absolute top-11 right-2 z-20 flex max-h-[70%] w-96 max-w-[calc(100%-1rem)] flex-col rounded-md border border-border bg-popover/95 shadow-lg backdrop-blur">
            <div className="flex shrink-0 items-center gap-2 px-3 py-2">
              <span className="text-xs font-medium">命令历史</span>
              <span className="text-xs text-muted-foreground">{history.length} 条</span>
              <span className="ml-auto text-[0.6875rem] text-muted-foreground">
                {historyScope?.kind === 'ssh'
                  ? '点条目填回终端 · 存服务端（不挂项目）'
                  : historyScope?.kind === 'local'
                    ? '点条目填回终端 · 存服务端（本机终端，不挂项目）'
                    : '点条目填回终端 · 落在项目 .fizz/'}
              </span>
              <IconTip label="关闭命令历史">
                <button
                  type="button"
                  aria-label="关闭命令历史"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleHistory}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </IconTip>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {history.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  还没有记录。在终端里按回车执行过的命令会出现在这里。
                </div>
              ) : (
                history.map((entry) => (
                  <div
                    key={entry.cmd}
                    className="group flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-secondary"
                  >
                    <button
                      type="button"
                      title={`${entry.cmd}（点击填回终端，回车自己按）`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertHistoryCommand(entry.cmd)}
                      className="min-w-0 flex-1 truncate text-left font-mono"
                    >
                      {entry.cmd}
                    </button>
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums group-hover:hidden">
                      {formatHistoryTime(entry.ts)}
                    </span>
                    <IconTip label={`删除这条记录：${entry.cmd}`}>
                      <button
                        type="button"
                        aria-label={`删除 ${entry.cmd}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => deleteHistoryEntry(entry.cmd)}
                        className="hidden shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:block"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </IconTip>
                  </div>
                ))
              )}
            </div>
            {history.length > 0 && (
              <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
                <span className="text-[0.6875rem] text-muted-foreground">重复执行会置顶并刷新时间</span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearAllHistory}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                  清空
                </button>
              </div>
            )}
          </div>
        )}
        {/*
          入口统一收进**悬浮球**（可拖动，松手自动贴边；点开在未贴边侧展开）：命令历史 /
          AI 助手不再占终端顶部那一排 —— 终端右上角本来就该是命令行内容。球本身不拦截
          终端的鼠标与触摸事件（除球与动作按钮外整层 `pointer-events-none`，见 `TerminalFab`）。
        */}
        <TerminalFab actions={fabActions} />
      </div>
      {error && <div className="px-3 pb-2 text-xs text-muted-foreground">{error}</div>}
      {/* 虚拟键盘缺修饰键 / 功能键：底部常驻快捷键条（占布局高度，不浮在终端上层）。
          修饰键（Ctrl/Alt/Shift）是「粘连」式，开启后作用于下一次按键（软键盘字符或功能键）再自动复位。

          显示条件见 `useVirtualKeyBar()`：按**输入能力**判（只有手指可用），不看窗口宽度 ——
          扩展 / 桌面窄窗口都有实体键盘，不该有这条；手机横屏超过 768px 反而该有。

          ⚠️ **别用 `margin-bottom` 吃 `--kb-inset` 把这条抬到键盘上方**（曾经这么做，已撤）：
          它是 `flex h-full flex-col` 里 `shrink-0` 的最后一项，margin 算进**外尺寸**参与 flex
          剩余空间分配，结果是终端区等量变矮、这条被挪到距容器底 `inset` px 处，**下面留出
          一条 `inset` px 的空白**（只有刚好整块落在键盘背后时才看不见）。键盘遮挡现在由
          **高度链**解决：`useKeyboardInset` 把「应用高度 = innerHeight − 键盘遮挡」写进
          <html> 的 `--app-height`，整条链缩到键盘上沿，这条自然就在键盘上方
          （见 lib/keyboard-inset.ts 文件头）。 */}
      {showKeyBar && (
        <div
          className="grid shrink-0 grid-cols-7 bg-background"
          // pointerdown 时就记下「终端里本来有没有焦点」—— 等 click 已经晚了，浏览器在
          // touch 处理里就把 textarea blur 了。记下来是为了点完快捷键把用户的键盘状态
          // 原样还给他（开着就补 focus，关着就别招回来），见 hadFocusRef 与 handleAction。
          onPointerDown={() => {
            hadFocusRef.current = document.activeElement === termRef.current?.textarea
          }}
        >
          {/*
            固定 7 列 × 2 行，所有键等宽铺满：手机上没有键盘的物理布局，键距不均时
            最容易误触。

            按键顺序（用户指定）：
            - **Esc 在左上角，Tab 在 Esc 正下方，Ctrl 在 Esc 右边**；
            - **Home 紧贴 ↑ 左侧、End 紧贴 ↑ 右侧**（寻址键包住方向键，与笔记本键盘一致）；
            - **PgUp 占最右上角、PgDn 占最右下角**（两颗同一列上下相对，翻页不用横着摸）。

            「End 在 ↑ 右边」与「PgUp 占右上角」本来抢同一格（第 7 列）—— 所以 ↑ 连同
            Home 一起左移一格，第 7 列留给 PgUp 与 PgDn；挤出来的第 4 格（原来是 Shift）
            正好接住 End。**Shift 因此下移到第 2 行第 3 格（Alt 正下方）**，修饰键仍是
            左侧那一条纵向带状区域，没有散到右边去。

            方向键保持普通键盘的倒 T：↑ 在第 5 列，← ↓ → 在第 2 行第 4~6 列，↑ 正对 ↓。
          */}
          <MobileKey label="Esc" onClick={() => handleAction('Escape')} />
          <MobileKey active={mods.ctrl} label="Ctrl" onClick={() => toggleMod('ctrl')} />
          <MobileKey active={mods.alt} label="Alt" onClick={() => toggleMod('alt')} />
          <MobileKey label="Home" onClick={() => handleAction('Home')} />
          <MobileKey label="↑" ariaLabel="上方向键" onClick={() => handleAction('ArrowUp')} repeat />
          <MobileKey label="End" onClick={() => handleAction('End')} />
          <MobileKey label="PgUp" ariaLabel="上一页" onClick={() => handleAction('PageUp')} repeat />
          <MobileKey label="Tab" onClick={() => handleAction('Tab')} />
          <MobileKey label="Del" ariaLabel="删除键" onClick={() => handleAction('Delete')} />
          <MobileKey active={mods.shift} label="Shift" onClick={() => toggleMod('shift')} />
          <MobileKey label="←" ariaLabel="左方向键" onClick={() => handleAction('ArrowLeft')} repeat />
          <MobileKey label="↓" ariaLabel="下方向键" onClick={() => handleAction('ArrowDown')} repeat />
          <MobileKey label="→" ariaLabel="右方向键" onClick={() => handleAction('ArrowRight')} repeat />
          <MobileKey label="PgDn" ariaLabel="下一页" onClick={() => handleAction('PageDown')} repeat />
        </div>
      )}
    </div>
  )
}
