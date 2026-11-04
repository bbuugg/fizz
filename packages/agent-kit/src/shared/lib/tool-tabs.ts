/**
 * 主区域里的**工具标签**（主机终端 / 本机终端）的运行时登记表。
 *
 * ## 为什么要这张表
 *
 * `panel-store` 只存**标签 key**（见 `panel-tabs.ts` 的 key 方案）。工具标签要渲染出
 * 一条终端，还需要一些「建标签那一刻就定下、之后不该变」的东西：
 * - 本机终端：工作目录、shell、所属工作区 —— 它们**不能**在渲染时现读 `activeWorkspace`，
 *   否则切一下工作区，所有已开的终端都会按新目录重建（`TerminalPanel` 认的是 props 变化）。
 * - 主机终端：主机配置 id；标签名另有一份**打开时的快照**，供主机被改名 / 删除后兜底。
 *
 * ## 为什么不需要订阅（不用 `useSyncExternalStore`）
 *
 * 读它的只有 `PanelView` 的标签条与内容区，而它们**已经**订阅了 `panel-store`；
 * 每个工具标签的写入都紧跟一次 `openTab()`（同一个同步块里），必然带出一轮重渲染。
 * 再挂一套订阅就是重复的唤醒源。**前提**：写入必须发生在 `openTab` 之前 ——
 * 反过来的话首帧会渲染出一个查不到元数据的标签。
 *
 * ## 只活在内存里
 *
 * 与布局树同一条口径（见 `panel-store.ts` 文件头）：这是「这一次打开的样子」，
 * 不落盘。刷新后标签本来就没了，登记表也该跟着空。条目在标签关闭后被
 * `pruneToolTabs()` 回收（由 `PanelView` 的一个 effect 统一驱动）。
 */
import type { SshHostConfig } from '@fizz/contracts/types'
import type { ApiRequestEntry } from '@fizz/contracts/types'
import { openTab } from '@fizz/agent-kit/shared/lib/panel-store'
import {
  apiTabKey,
  filesTabKey,
  hostTabKey,
  localTabKey,
  localFileTabKey,
  logsTabKey,
  noteTabKey,
  pluginTabKey,
  scriptsTabKey,
  settingsTabKey,
  sftpTabKey,
  sysmonTabKey,
  triggersTabKey,
  tunnelTabKey,
  NEW_API_REQUEST_ID,
  NEW_WS_REQUEST_ID
} from '@fizz/agent-kit/shared/lib/panel-tabs'

/**
 * 工具标签的各种类别：连远端主机 / 开本机终端 / 打开一个接口请求 / 打开**脚本管理面板**
 * / 打开一个**插件界面** / 打开一台主机的 **SFTP 文件管理**
 * / 打开全局的 **SSH 隧道面板** / 打开全局的**应用日志面板** / 打开全局的**定时任务管理面板**
 * / 打开一篇**笔记** / 打开一个**本机 Markdown 文档** / 打开全局的**设置面板**
 *（新增一类时，`isToolTabKey` 那条 OR 必须同步补上，理由见那里的注释）
 *
 * 「单个主机脚本」**不在**这里：脚本的新建 / 编辑已经是模态框（`ScriptEditDialog`），
 * 不再占一条标签（理由见该文件头）。
 *
 * 容器型项目的预览**不在这里**：它是会话 SidePanel 里的一条标签（`SideTabKey` 的
 * `preview`），跟着对话走，不是主区域的工具标签。
 */
export type ToolTabKind =
  | 'host'
  | 'local'
  | 'api'
  | 'scripts'
  | 'plugin'
  | 'sftp'
  | 'tunnel'
  | 'logs'
  | 'triggers'
  | 'note'
  | 'local-file'
  /** 全局单例：服务端那台机器的**整盘文件管理器**（`files:list`） */
  | 'files'
  /** 全局单例：服务端那台机器的**系统监控 + 任务管理器**（`sysmon:list`） */
  | 'sysmon'
  /** 全局单例：**设置面板**（`settings:list`）—— 取代桌面端原来的独立设置窗口 */
  | 'settings'

export interface ToolTab {
  /** 与 `panel-store` 里的标签 key 一致（`host:<id>` / `local:<n>`） */
  key: string
  kind: ToolTabKind
  /** 打开时定下的短名（主机被改名 / 删除后作为兜底显示） */
  label: string
  /**
   * **只改显示名**的别名（用户在主区域标签上就地改名）。
   *
   * 与 `label` 分开：`label` 是「打开那一刻从数据源取的快照」（主机名 / 终端 N / 脚本名），
   * 别名只是盖在它上面的一层显示名 —— **不落盘、不回写数据源**，标签一关（条目被
   * `pruneToolTabs` 回收）就没了，重开恢复原名。对话标签不走这里（改的是会话标题）。
   */
  alias?: string
  /** 悬停提示（更完整的描述，如 `SSH · root@10.0.0.8:22`） */
  title: string
  /** 本机终端：工作目录（**建标签那一刻**定下，之后不跟随当前工作区变；空串 = 主目录） */
  cwd?: string
  /** 本机终端：shell id（null = 跟随平台默认） */
  shellId?: string | null
  /**
   * 本机终端：shell 的**展示名**（`PowerShell 7` / `Git Bash` …）。
   *
   * 存打开时的快照而不是渲染时拿 `shellId` 去清单里反查：同一台机器可能检出好几种
   * shell（见 `@fizz/shells` 的 `detectShells`），标签名 / 悬停提示要能分辨它们；
   * 而清单是**可变的**（卸掉一个 shell 就没了），反查会在那时退化成光秃秃的「终端」。
   */
  shellName?: string
  /** 本机终端：额外启动参数（追加在 shell 自带 args 之后） */
  args?: string[]
  /** 本机终端：启动后自动执行的一条命令（shell 起来后写进 PTY） */
  autoCommand?: string
  /** 主机标签：SSH 主机配置 id */
  sshHostId?: string
  /** 接口请求标签：请求 id（草稿是哨兵 `NEW_API_REQUEST_ID`） */
  apiRequestId?: string
  /**
   * SFTP 文件管理标签：哪台 SSH 主机。
   *
   * 与 `sshHostId` 分开存而不是复用：两者语义不同（一个是「开个终端连过去」，一个是
   * 「开个文件浏览器」），共用字段会让 `PanelView` 的分发要靠 key 前缀再去区分一次。
   */
  sftpHostId?: string
  /**
   * 插件界面标签：哪个插件 + 它的哪个面。
   *
   * ⚠️ 归属**只记在这里**，不编进 key —— 插件 id 是绝对路径（Windows 下带 `:`），
   * 编进 key 就得分段解析，而 `:` 段会被路径自己的盘符吃掉（见 `panel-tabs.ts`）。
   */
  pluginId?: string
  /** 插件界面标签：面 id（插件内部唯一） */
  surfaceId?: string
  /**
   * 插件界面标签：这个面是**哪一种**（默认 `view`）。
   *
   * 清单里现在只允许 `view`，但老插件可能还声明着 `sider`（入口统一到「插件」列表后，
   * sider 面也开成标签页）—— 没有这个字段就得以错的 kind 去请求渲染，服务端找不到面。
   */
  surfaceKind?: 'sider' | 'view'
  /**
   * 插件界面标签：**这一页是哪个参数开的**（如「哪个连接」）。
   *
   * 有了它，同一个面就能开出**多屏**（一个连接一页）—— 宿主把参数原样带回插件的
   * `render` / `onAction`，由插件区分实例。与 `pluginId` 一样只记在登记表里，不编进 key。
   */
  params?: Record<string, string | number | boolean>
  /**
   * 主机 / 本机终端：**终端就绪时写入一次**的脚本输入（逐行回车，见 `scriptToTerminalInput`）。
   *
   * 运行脚本时把内容挂在这上面（而不是走 `autoCommand`）—— `autoCommand` 只有本机 PTY
   * 那条分支用得上，SSH 分支不转发；`scriptInput` 由 `TerminalPanel` 在「SSH 建连就绪 /
   * 首帧输出」时写进 PTY，SSH 与本机两类目标都覆盖。
   */
  scriptInput?: string
  /**
   * 隧道标签：从主机右键菜单进来时要**预选**的主机（「给这台主机配一条隧道」）。
   *
   * 与 `sftpHostId` 分开：它不是一个「归属」，而是**一次性指令**（面板读到就把新建弹窗
   * 打开、并把主机选好）。所以还配了 `tunnelRequestSeq`：同一台主机连点两次也得再触发一次
   * —— 只比 `tunnelHostId` 的话，第二次值没变，面板收不到任何信号。
   */
  tunnelHostId?: string
  /** 隧道标签：预选请求的序号（每次 `openTunnelTab` 带 hostId 调用都 +1，见上） */
  tunnelRequestSeq?: number
  /**
   * 笔记标签：哪本笔记根（`NotesRoot.id`）+ 根内的**相对路径**。
   *
   * ⚠️ 归属**只记在这里**，不编进 key —— 相对路径是分层的、还可能是 Windows 路径，
   * 且笔记会被重命名（编进 key 就得改 key，状态机不认）。与 `pluginId` 同一取舍。
   *
   * 两者**缺一不可**：只有路径的话，两个根下同名的 `README.md` 会被当成同一篇。
   */
  noteRootId?: string
  notePath?: string
  /**
   * 外部文件标签：本机**绝对路径**（用本应用打开的那篇 Markdown）。
   *
   * 与 `notePath` 不同，这里是绝对路径、且**没有「根」的概念**（路径本身就是全部归属）。
   * 同样只记在这里、不编进 key（Windows 路径自带 `:`，见 `panel-tabs.ts` 的 `file:<n>`）。
   */
  externalPath?: string
  /**
   * 设置面板：**这次打开要落到哪个分组**（`'models'` / `'acp'` …，取值见
   * `features/settings/types` 的 `SettingsTabId`）。
   *
   * 用 `string` 而不是直接引 `SettingsTabId`：这张表在 `shared/lib`，不该反向依赖
   * `features/settings`（类型倒是不会产生运行时依赖，但会让这份「通用标签登记表」
   * 看上去像是知道设置页的存在）。消费方只有 `SettingsTabContent`，它自己转一次。
   *
   * 与 `tunnelHostId` 同一类「一次性指令」，但多一个 `settingsRequestSeq`：标签已经
   * 开着时 `openTab` 只做激活（状态引用不变 → 不 emit），面板收不到任何信号 ——
   * 每次带分组的调用都把序号 +1，由 `SettingsTabContent` 拿它当 React `key` 把外壳
   * 重挂一次（与原先 `SettingsWindow` 用 `key={`${tab}#${seq}`}` 的做法同源）。
   *
   * 不带分组调用（普通入口 / 快捷键）时**不覆盖已有的值**：用户正停在「模型」，从
   * 菜单点设置不该被弹回「通用」。
   */
  settingsTab?: string
  /** 设置面板：分组请求的序号（每次 `openSettingsTab(tab)` 都 +1，见上） */
  settingsRequestSeq?: number
}

const tabs = new Map<string, ToolTab>()

/** 读一个工具标签的元数据（对话标签 / 已关闭的标签都返回 undefined） */
export function getToolTab(key: string): ToolTab | undefined {
  return tabs.get(key)
}

/**
 * 回收已经不在面板里的条目（标签被关掉、被 `alignToTabs` 摘掉都算）。
 *
 * 由 `PanelView` 的 effect 在每次面板状态变化后调用 —— 集中一处，省得「关闭标签」的
 * 每条路径（×、右键关闭其他、关闭整个组…）都要记得顺手清一次。
 */
export function pruneToolTabs(openKeys: readonly string[]): void {
  if (tabs.size === 0) return
  const alive = new Set(openKeys)
  for (const key of [...tabs.keys()]) {
    if (!alive.has(key)) tabs.delete(key)
  }
}

/**
 * 打开某台主机的终端标签（**每次调用都新开一条**，与 dogi 一致）。
 *
 * 主机是「可以同时看多个」的东西（同一台机器开两个终端跑不同的事），所以不再复用已有
 * 标签 —— key 带上自增序号（见 `panel-tabs.ts` 的 `hostTabKey`）。主机被改名后新开的
 * 标签用新名字，已开的旧标签名由 `PanelView` 读清单实时刷新，不受影响。
 */
let hostSeq = 0
export function openHostTab(host: SshHostConfig, options?: { scriptInput?: string }): string {
  const seq = ++hostSeq
  const key = hostTabKey(host.id, seq)
  tabs.set(key, {
    key,
    kind: 'host',
    label: host.name,
    title: `SSH · ${host.username}@${host.host}:${host.port}`,
    sshHostId: host.id,
    // 运行脚本时带上：终端就绪后由 TerminalPanel 写入一次（一条脚本 = 一条新标签）
    ...(options?.scriptInput ? { scriptInput: options.scriptInput } : {})
  })
  openTab(key)
  return key
}

/** 本机终端的自增序号：每开一条 +1（标签名「终端 N」也用它） */
let localSeq = 0

/**
 * 开一条**本机**终端标签（宿主 shell）。
 *
 * ⚠️ **它与任何项目 / 会话都无关**：「主机与终端」是独立功能，只是把终端摆进主区域当
 * 标签用。所以这里**没有** `workspaceId` 入参 —— 历史走全局一份
 * （`local-terminal-history.json`，见 `TerminalPanel` 的 `localHistory`），容器 / 会话一律
 * 不参与。会话侧栏里那条「属于某个会话」的终端不走这里（它是 `panel.terminals`，
 * 由 `openTerminalTabOf` 建）。
 *
 * `cwd` / `shellId` 由调用方在**打开那一刻**取好传进来 —— 在这里现读 `activeWorkspace`
 * 会让「切工作区」把已开的终端全按新目录重建。`cwd` 传空串 = 落到主目录。
 *
 * `shellName` 只是展示用（进悬停提示）；真正的 shell 由 `shellId` 交给服务端
 * `resolveShell` 解析，界面这边**不**拿名字去启动进程。`args` / `autoCommand` 是
 * 本机终端配置里带的启动参数与启动后自动命令，一路透到 PTY。
 */
export function openLocalTerminalTab(options: {
  cwd: string
  shellId: string | null
  /** shell 的展示名（`PowerShell 7` / `Git Bash` …），用于悬停提示里区分多条终端 */
  shellName?: string
  /** 标签名；不传 = `终端 N`（本机终端配置存了名字时用它） */
  label?: string
  /** 额外启动参数（追加在 shell 自带 args 之后） */
  args?: string[]
  /** 启动后自动执行的一条命令（shell 起来后写进 PTY） */
  autoCommand?: string
  /** 终端就绪时写入一次的脚本输入（运行脚本用；见 `ToolTab.scriptInput`） */
  scriptInput?: string
}): string {
  const seq = ++localSeq
  const key = localTabKey(seq)
  /** 悬停提示：有目录写目录，没有（主目录）就只说 shell —— 别留一个 `终端 · ` 的尾巴 */
  const detail = [options.shellName, options.cwd].filter(Boolean).join(' · ')
  tabs.set(key, {
    key,
    kind: 'local',
    label: options.label?.trim() || `终端 ${seq}`,
    title: detail ? `终端 · ${detail}` : '终端',
    cwd: options.cwd,
    shellId: options.shellId,
    shellName: options.shellName,
    ...(options.args?.length ? { args: options.args } : {}),
    ...(options.autoCommand ? { autoCommand: options.autoCommand } : {}),
    ...(options.scriptInput ? { scriptInput: options.scriptInput } : {})
  })
  openTab(key)
  return key
}

/**
 * 打开一个**已保存**的接口请求标签（`api:<requestId>`）。
 *
 * **一个请求 = 一条标签**：同一个请求再点一次是「聚焦已有标签」，不新开（`openTab`
 * 对已在面板里的 key 就是切过去）。理由见 `panel-tabs.ts` 的 api 前缀注释（两份编辑态
 * 互相覆盖）。标签名 / 悬停提示只在**打开这一刻**记一份快照，请求被改名后由 `PanelView`
 * 读清单实时刷新，不受影响。
 */
export function openApiTab(request: ApiRequestEntry): string {
  const key = apiTabKey(request.id)
  const isWs = request.protocol === 'ws'
  tabs.set(key, {
    key,
    kind: 'api',
    label: request.name.trim() || request.url.trim() || (isWs ? 'WebSocket' : '接口请求'),
    // WebSocket 没有方法，悬停提示用协议前缀区分，别显示成 `GET wss://...`
    title: isWs
      ? `WS ${request.url || '（未填写地址）'}`
      : `${request.method || 'GET'} ${request.url || '（未填写地址）'}`,
    apiRequestId: request.id
  })
  openTab(key)
  return key
}

/**
 * 打开一个**未保存的新 WebSocket 连接**草稿标签（key 用哨兵 `NEW_WS_REQUEST_ID`）。
 *
 * 与 `openApiDraftTab` 同一套机制：草稿不落盘，真正的保存发生在 WsPage 里按 Ctrl/Cmd+S
 * 之后。草稿也是正常的 `api:` 标签（只是 requestId 用了另一个哨兵），能被拖 / 分屏。
 */
export function openWsDraftTab(): string {
  const key = apiTabKey(NEW_WS_REQUEST_ID)
  tabs.set(key, {
    key,
    kind: 'api',
    label: '新建连接',
    title: '新建 WebSocket 连接（未保存）',
    apiRequestId: NEW_WS_REQUEST_ID
  })
  openTab(key)
  return key
}

/**
 * 打开一个**未保存的新请求草稿**标签（key 用哨兵 `NEW_API_REQUEST_ID`）。
 *
 * 草稿不落盘、不进请求列表，真正的保存发生在用户在编辑页按 Ctrl/Cmd+S 之后。
 * 同一时刻只保留**一个**草稿标签（复用同一个 key），与 dogi 一致。
 */
export function openApiDraftTab(): string {
  const key = apiTabKey(NEW_API_REQUEST_ID)
  tabs.set(key, {
    key,
    kind: 'api',
    label: '新请求',
    title: '新建接口请求（未保存）',
    apiRequestId: NEW_API_REQUEST_ID
  })
  openTab(key)
  return key
}

/**
 * 打开某台主机的 **SFTP 文件管理**标签（`sftp:<hostId>`，**一台主机一条**）。
 *
 * 入口是主机行的右键菜单（「SFTP 文件管理」）；同一台主机再点一次是「聚焦已有标签」，
 * 不开第二条（文件管理页有「浏览到哪个目录」这类位置状态，开两份容易互相看晕）。
 *
 * 只在 `kind !== 'local'` 的主机上可用 —— 本机终端没有远端可浏览；调用方（主机侧栏）
 * 已经在菜单里按类型挡掉了，这里再挡一层，避免别处漏判时开出一个注定报错的标签。
 */
export function openSftpTab(host: SshHostConfig): string {
  const key = sftpTabKey(host.id)
  tabs.set(key, {
    key,
    kind: 'sftp',
    label: `${host.name} 文件`,
    title: `SFTP · ${host.username}@${host.host}:${host.port}`,
    sftpHostId: host.id
  })
  openTab(key)
  return key
}

/** 隧道面板「预选主机」的自增序号（每次带 hostId 打开都 +1，见 `ToolTab.tunnelRequestSeq`） */
let tunnelSeq = 0
/**
 * 打开全局的 **SSH 隧道面板**（`tunnel:list`，**全局单例**）。
 *
 * 入口有两个：主机行的右键菜单（「隧道…」，带上这台主机做**预选**）与命令面板 / 工具标签栏
 * （不带主机，纯打开列表）。已在面板里时是「聚焦已有标签」，不新开 —— 隧道列表横跨多台
 * 主机，开两份只会互相看晕（见 `panel-tabs.ts` 的 tunnel 前缀注释）。
 *
 * ⚠️ 隧道面板显示的是**服务端所在机器**上的监听端口，不是浏览器那台（`ssh -L/-R/-D`
 * 的标准语义）。面板文案要写清这一点。
 */
export function openTunnelTab(options?: { hostId?: string }): string {
  const key = tunnelTabKey()
  tabs.set(key, {
    key,
    kind: 'tunnel',
    label: '隧道',
    title: 'SSH 隧道 · 本地转发 / 远程转发 / SOCKS5 动态代理',
    // 带主机进来 = 「给这台主机配一条隧道」：面板读到就开新建弹窗并预选它。
    // 序号每次 +1，保证同一台主机连点两次也能重新触发（只比 hostId 收不到信号）。
    ...(options?.hostId ? { tunnelHostId: options.hostId, tunnelRequestSeq: ++tunnelSeq } : {})
  })
  openTab(key)
  return key
}

/** 插件界面标签的自增序号（key 是 `plugin:<n>`，归属记在表里的 `pluginId` / `surfaceId`） */
let pluginSeq = 0
/**
 * 打开一个**插件界面**标签。
 *
 * **一个插件的一个面 = 一条标签**：再点一次是「聚焦已有标签」，不新开 —— 与接口请求 /
 * 主机脚本同一取舍（插件面里常有「查了一半的状态」，开两份会互相覆盖）。
 *
 * ⚠️ 归属只写进登记表，key 是不透明的 `plugin:<n>`：插件 id 是绝对路径（Windows 下带 `:`），
 * 编进 key 会切错段（见 `panel-tabs.ts` 的 plugin 前缀注释）。
 */
/** 参数的稳定表示（用来判断「是不是同一屏」；对象直接比永远不相等） */
function paramsKeyOf(params?: Record<string, string | number | boolean>): string {
  return params ? JSON.stringify(params) : ''
}

/**
 * 打开全局的**文件管理器面板**（`files:list`，**全局单例**）。
 *
 * 入口是状态栏那颗「文件夹」图标（与「应用日志」并排）。浏览的是**服务端那台机器**
 * 的文件系统（整盘，绝对路径），与当前工作区 / 会话都无关，所以与日志 / 隧道 / 脚本
 * 同一取舍：一份现场、一条标签，已在时只聚焦 —— 开两份会让当前目录、选中项、
 * 剪贴板各算一套，人反而分不清哪个是真的。
 */
export function openFilesTab(): string {
  const key = filesTabKey()
  tabs.set(key, {
    key,
    kind: 'files',
    label: '文件管理',
    title: '文件管理 · 服务端这台机器上的文件（整盘，可上传 / 下载 / 压缩 / 回收站）'
  })
  openTab(key)
  return key
}

/**
 * 打开全局的**系统监控 + 任务管理器面板**（`sysmon:list`，**全局单例**）。
 *
 * 入口是状态栏那颗「系统监控」图标（文件管理的左边）。它看的是**服务端那台机器**的
 * CPU / 内存 / 磁盘 / 每个进程，与当前工作区、会话、SSH 主机都无关，所以与文件管理 /
 * 日志同一取舍：一份现场、一条标签，已在时只聚焦。
 *
 * ⚠️ 与状态栏右端那颗**监控徽标**（`SystemMonitorBadge`）是两个东西：那颗是「扫一眼」，
 * 走常驻采样器的快照；这个面板是「干活」用的，进程表是按需现采的。两条通路互不影响
 * （见 `apps/server/src/server/system-tasks/index.ts` 文件头的对照表）。
 */
export function openSysmonTab(): string {
  const key = sysmonTabKey()
  tabs.set(key, {
    key,
    kind: 'sysmon',
    label: '系统监控',
    title: '系统监控 · 服务端这台机器的 CPU / 内存 / 磁盘，以及任务管理器（可结束进程）'
  })
  openTab(key)
  return key
}

/**
 * 打开全局的**应用日志面板**（`logs:list`，**全局单例**）。
 *
 * 入口是标题栏项目名右侧那颗按钮（桌面端 `TitleBar` / Web 端 `WebTitleBar`）。
 * 已在面板里时是「聚焦已有标签」，不新开 —— 日志横跨所有命名空间，开两份只会互相看晕
 * （与隧道面板同一取舍）。面板内部用 Tab 切命名空间，所以这里不需要任何参数。
 */
export function openLogsTab(): string {
  const key = logsTabKey()
  tabs.set(key, {
    key,
    kind: 'logs',
    label: '日志',
    title: '应用日志 · 全部业务事件记录（按命名空间分组）'
  })
  openTab(key)
  return key
}

/**
 * 打开全局的**定时任务管理面板**（`triggers:list`，**全局单例**）。
 *
 * 入口是侧栏顶部那颗「定时任务」（原先它是折叠一块清单，现在改成开这个标签页）。
 * 已在面板里时是「聚焦已有标签」，不新开 —— 清单横跨所有项目，开两份只会互相看晕
 * （与日志 / 隧道同一取舍）。
 */
export function openTriggersTab(): string {
  const key = triggersTabKey()
  tabs.set(key, {
    key,
    kind: 'triggers',
    label: '定时任务',
    title: '定时任务 · 到点自动起一轮会话（可绑工作区，也可每次自动新建）'
  })
  openTab(key)
  return key
}

/**
 * 打开全局的**脚本管理面板**（`scripts:list`，**全局单例**）。
 *
 * 入口是主机侧栏顶部那颗「脚本」（原先脚本是侧栏里的一个可折叠组，260px 宽只够看名字，
 * 分组 / 搜索 / 运行都挤在一起）。脚本横跨所有主机（同一段命令可以选任意机器跑），
 * 所以与定时任务 / 隧道同一取舍：一份清单、一条标签，已在时只聚焦。
 */
export function openScriptsTab(): string {
  const key = scriptsTabKey()
  tabs.set(key, {
    key,
    kind: 'scripts',
    label: '脚本',
    title: '脚本 · 管理可复用的命令（按分组整理，选任意主机运行）'
  })
  openTab(key)
  return key
}

/**
 * 打开**设置面板**（`settings:list`，**全局单例**）。
 *
 * 桌面端原先把它开成独立 BrowserWindow，那是**另一个渲染进程 = 另一份模块级 store
 * 单例**；「在设置里停用插件、主窗口活动栏图标不走」这类问题都源于此（见
 * `panel-tabs.ts` 的 `settingsTabKey` 注释）。改成标签后设置与对话共享同一个
 * `AppProvider`，改完主窗口立刻就是对的，也顺带省掉了独立窗口那套「两份 store /
 * 两条 WS / 靠 `storage` 事件与 `/api/prefs` 双通道同步」的维护成本。
 *
 * `tab` 是「落到哪个分组」的一次性指令（模型选择下拉那颗齿轮、ACP 页的指引链接）：
 * 已开着时不是重开一条，而是原地切过去 —— 机制见 `ToolTab.settingsTab`。
 */
export function openSettingsTab(tab?: string): string {
  const key = settingsTabKey()
  const prev = tabs.get(key)
  tabs.set(key, {
    key,
    kind: 'settings',
    label: '设置',
    title: '设置 · 模型 / 智能体 / 工具与技能 / 外观 / 快捷键',
    // 不带分组时**不覆盖**：普通入口（菜单 / 快捷键）该停在用户上次看的那一页
    settingsTab: tab ?? prev?.settingsTab,
    // 带分组时才 +1 —— 这是「请切到这一页」的信号，同一页连点两次也得再触发
    settingsRequestSeq: tab ? (prev?.settingsRequestSeq ?? 0) + 1 : prev?.settingsRequestSeq
  })
  // 已开着时 `openTab` 只激活、不 emit（状态引用没变），面板只能靠版本号知道
  // 表被就地改了 —— 与下方 `retargetNoteTab` 同一套机制
  if (prev) bumpToolTabsVersion()
  openTab(key)
  return key
}

// ---------- 笔记标签 ----------
//
// ## 为什么这里比别的标签多一套「版本订阅」
//
// 其余工具标签的元数据建好之后**再也不变**（主机名变了由 `PanelView` 去清单里现读）。
// 笔记不一样：**重命名**要同时改标签名与保存目标路径，而标签 key 是不透明的 `note:<n>`
// （归属记在表里，见 `ToolTab.noteRootId`）—— 表被就地改了，`panel-store` 却**没有变化**
// （`openTab` 对已存在的 key 是「切过去」，状态引用不变 → 不 emit → 不重渲染）。
//
// 所以给这张表加一个**自增版本号**：`retargetNoteTab` 改完表就 bump 一次，
// `NoteTabContent` 用 `useToolTabsVersion()` 订阅它、重新读一遍表。别指望「反正会重渲染」
// —— 用户重命名一篇正开着的笔记时，恰好什么都没在渲染，界面就会停在旧路径上，
// 下一次「保存」会**按旧路径重新长出一个文件**（原文件还在，等于凭空多一份）。

let tabVersion = 0
const tabVersionListeners = new Set<() => void>()

/** 订阅登记表的版本变化（`useSyncExternalStore` 的 subscribe） */
export function subscribeToolTabs(listener: () => void): () => void {
  tabVersionListeners.add(listener)
  return () => {
    tabVersionListeners.delete(listener)
  }
}

/** 登记表版本（`useSyncExternalStore` 的 getSnapshot；没订阅时也得是稳定值） */
export function getToolTabsVersion(): number {
  return tabVersion
}

function bumpToolTabsVersion(): void {
  tabVersion += 1
  for (const listener of tabVersionListeners) listener()
}

/**
 * 给工具标签**改显示名**（主区域标签的右键「重命名」）。
 *
 * 只写 `alias` 这一层，`label` 原样不动 —— 所以：
 * - **不落盘**：登记表本来就在内存里（见文件头），别名跟着它一起没；
 * - **标签一关就恢复**：条目被 `pruneToolTabs` 回收，重开时由 `openXxxTab` 重新按数据源
 *   取名字，不会继承上一次的别名；
 * - **不回写数据源**：主机名 / 接口名 / 脚本名都不动（那是另一个功能的数据）。
 *
 * 传空串 = 清掉别名（回到原名）。改完 bump 版本让标签条重渲染（理由同 `retargetNoteTab`：
 * 表变了但 `panel-store` 没变化，不 bump 就不重渲染）。
 */
export function renameToolTab(key: string, alias: string): void {
  const tab = tabs.get(key)
  if (!tab) return
  const next = alias.trim()
  if ((tab.alias ?? '') === next) return
  if (next) tab.alias = next
  else delete tab.alias
  bumpToolTabsVersion()
}

/** 笔记标签的自增序号（key 是 `note:<n>`，归属记在表里的 `noteRootId` / `notePath`） */
let noteSeq = 0

/**
 * 打开一篇**笔记**标签。
 *
 * **一篇笔记 = 一条标签**：同一个根下的同一个相对路径再点一次是「聚焦已有标签」，不新开
 * —— 笔记有「改了没保存」的现场，开两份必然互相覆盖（与接口请求 / 主机脚本同一取舍）。
 * 两个根下同名的 `README.md` 是**两篇**（归属比对 `noteRootId` + `notePath` 两项）。
 */
export function openNoteTab(options: {
  rootId: string
  /** 相对所属根的路径（`/` 分隔） */
  path: string
  /** 标签名（默认取文件名） */
  label?: string
  title?: string
}): string {
  const existing = [...tabs.values()].find(
    (tab) =>
      tab.kind === 'note' && tab.noteRootId === options.rootId && tab.notePath === options.path
  )
  if (existing) {
    openTab(existing.key)
    return existing.key
  }
  const key = noteTabKey(++noteSeq)
  const label = options.label?.trim() || options.path.split('/').pop() || '笔记'
  tabs.set(key, {
    key,
    kind: 'note',
    label,
    title: options.title?.trim() || options.path,
    noteRootId: options.rootId,
    notePath: options.path
  })
  openTab(key)
  return key
}

/**
 * 重命名后把已开的标签**改到新路径**（同时刷新标签名）。
 *
 * 不新开标签、也不关旧标签：文件内容没变（只换了名字），编辑器里那份「改了没保存」的
 * 现场必须留着 —— 换路径只是换**保存目标**（`NoteEditor` 用 ref 读最新路径）。
 * 改完 bump 版本，让 `NoteTabContent` 重新读表。
 *
 * 返回受影响的标签 key（没有开着的就返回空数组）。
 */
export function retargetNoteTab(
  rootId: string,
  oldPath: string,
  next: { path: string; label?: string }
): string[] {
  const affected: string[] = []
  for (const tab of tabs.values()) {
    if (tab.kind !== 'note' || tab.noteRootId !== rootId || tab.notePath !== oldPath) continue
    tab.notePath = next.path
    tab.label = next.label?.trim() || next.path.split('/').pop() || tab.label
    tab.title = next.path
    affected.push(tab.key)
  }
  if (affected.length > 0) bumpToolTabsVersion()
  return affected
}

/** 某个笔记文件对应的标签 key（没有开着就 null）—— 删除文件时用来关掉它的标签 */
export function noteTabKeyOf(rootId: string, path: string): string | null {
  for (const tab of tabs.values()) {
    if (tab.kind === 'note' && tab.noteRootId === rootId && tab.notePath === path) return tab.key
  }
  return null
}

// ---------- 外部文件标签（用本应用打开的本机 Markdown） ----------
//
// 与「笔记」是两条**完全不同**的数据通路：笔记走登记根 + notes API（服务端按根做
// `resolveInside`），这里走桌面端主进程的 fs + 路径闸（`@fizz/agent-host` 的 `local-files`）。
// 别把两者合并成一套 —— 笔记根是「服务端那台机器上的目录」，而这个文件在**用户本机**，
// 服务端可能根本不在同一台机器上。

/** 外部文件标签的自增序号（key 是 `file:<n>`，绝对路径记在表里的 `externalPath`） */
let localFileSeq = 0

/** 规范化：路径分大小写（Windows 不敏感）与末尾分隔符，去重时按这个比 */
function normalizeAbsPath(path: string): string {
  const trimmed = path.trim()
  // 尾部分隔符去掉（`D:\a\` 与 `D:\a` 是同一个位置）；盘符根保留（`D:\` → `D:`，
  // 这一条只影响去重比较，渲染与读写始终用原串）
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed
}

/**
 * 打开一个**本机 Markdown 文档**标签。
 *
 * **一个文件 = 一条标签**：同一个绝对路径再开一次是「聚焦已有标签」，不新开 ——
 * 这篇文档有「改了没保存」的现场，开两份必然互相覆盖（与笔记 / 接口请求同一取舍）。
 * 这也是**双击同一个文件两次**时只看到一条标签的原因。
 */
export function openLocalFileTab(options: { absPath: string; label?: string }): string {
  const wanted = normalizeAbsPath(options.absPath)
  const existing = [...tabs.values()].find(
    (tab) => tab.kind === 'local-file' && normalizeAbsPath(tab.externalPath ?? '') === wanted
  )
  if (existing) {
    openTab(existing.key)
    return existing.key
  }
  const key = localFileTabKey(++localFileSeq)
  const label = options.label?.trim() || filenameOf(wanted) || 'Markdown'
  tabs.set(key, {
    key,
    kind: 'local-file',
    label,
    // 悬停提示给**完整绝对路径**：同名的 README.md 一多，标签名根本分不清是哪个
    title: wanted,
    externalPath: wanted
  })
  openTab(key)
  return key
}

/** 路径里的文件名（两个分隔符都认：主进程传来的 Windows 路径在 mac 上也得能取） */
function filenameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}

export function openPluginTab(options: {
  pluginId: string
  surfaceId: string
  /** 面种类（缺省 `view`；老插件的 `sider` 面也开成标签页） */
  surfaceKind?: 'sider' | 'view'
  label: string
  title?: string
  /** 这一页的参数（如「哪个连接」）：**参数不同 = 不同的一屏**，各自一条标签 */
  params?: Record<string, string | number | boolean>
}): string {
  const wanted = paramsKeyOf(options.params)
  const existing = [...tabs.values()].find(
    (tab) =>
      tab.kind === 'plugin' &&
      tab.pluginId === options.pluginId &&
      tab.surfaceId === options.surfaceId &&
      paramsKeyOf(tab.params) === wanted
  )
  if (existing) {
    // 已在面板里：openTab 对存在的 key 就是切过去
    openTab(existing.key)
    return existing.key
  }
  const key = pluginTabKey(++pluginSeq)
  tabs.set(key, {
    key,
    kind: 'plugin',
    label: options.label.trim() || '插件',
    title: options.title?.trim() || options.label,
    pluginId: options.pluginId,
    surfaceId: options.surfaceId,
    ...(options.surfaceKind && options.surfaceKind !== 'view'
      ? { surfaceKind: options.surfaceKind }
      : {}),
    ...(options.params ? { params: options.params } : {})
  })
  openTab(key)
  return key
}
