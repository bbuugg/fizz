/**
 * 主区域面板的**标签 key 方案**（纯函数、零依赖、零 React）。
 *
 * 主区域的面板（`PanelView`）里现在住着**两种东西**：
 * - **对话标签** —— key 就是会话 id（空态是 `__new__`），内容由 `ConversationTab` 渲染，
 *   与「当前会话」一一对应；
 * - **工具标签** —— 连到某台 SSH 主机的终端、以及随手开的本机终端。它们**不对应任何会话**，
 *   打开 / 关闭都不该动 `activeConversationId`。
 *
 * ## 为什么用「带前缀的 key」而不是给标签加个 type 字段
 *
 * `panel-store` / `panel-groups` 那套状态机（拖拽、分屏、合并、`alignToTabs`）只认
 * **一个字符串**。要让工具标签也能被拖、被分屏、被并入，最省事也最不易错的做法就是
 * 「key 自带类型」—— 状态机一行都不用改，类型只在渲染层（`PanelView`）解析一次。
 * 参考实现（dogi）走的是给 `PanelTab` 加 `type` 字段那条路，于是「标签列表」与
 * 「分组状态」两份数据都要带着 type 一起搬，多一处同步点。
 *
 * ⚠️ **前缀是保留命名空间**：会话 id 由服务端生成（uuid / 短 id），不会以 `host:` /
 * `local:` 开头；`__new__` 是空态专用的哨兵。新增工具标签类型时**必须**在这里加前缀，
 * 不要在别处临时拼字符串。
 */

/** 「新对话 / 初始页」这个特殊标签的 key */
export const NEW_TAB_KEY = '__new__'

/** 连到某台 SSH 主机的终端标签：`host:<hostId>#<seq>`（同一台主机**可多开**，seq 区分） */
const HOST_TAB_PREFIX = 'host:'
/**
 * 主机标签里 hostId 段与序号段的分隔符。
 *
 * hostId 是服务端生成的 uuid / 短 id，**不含 `#`**，所以用 `#` 切第一段就是 hostId。
 * 用序号而不是「把 hostId 变成数组」是为了让 key 仍是**一个字符串**（状态机只认它）。
 */
const HOST_TAB_SEQ_SEP = '#'
/** 随手开的**本机**终端标签：`local:<n>`（每开一次都是新的一条，不复用） */
const LOCAL_TAB_PREFIX = 'local:'
/**
 * 接口请求标签：`api:<requestId>`。
 *
 * requestId 是服务端生成的 uuid / 短 id，**不含 `:`**；「新建草稿」用哨兵
 * `NEW_API_REQUEST_ID`（见 `features/api/api-client.ts`）当 requestId，于是草稿也是
 * 一个正常的 `api:` 标签，能被拖、被分屏，无需为它单独开一套机制。
 * **一个请求 = 一条标签**（同 id 复用同一条，不做多开）—— 同一请求在两个标签里各改一份
 * 再保存会互相覆盖，dogi 也是这么取舍的（见 `tool-tabs.ts` 的 `openApiTab`）。
 */
const API_TAB_PREFIX = 'api:'
/**
 * 插件界面标签：`plugin:<n>`（n 由 `tool-tabs.ts` 的自增源给）。
 *
 * ⚠️ **别把 pluginId 编进 key**：插件 id 是入口文件的绝对路径
 * （`C:\Users\…\plugins\redis.ts`）—— Windows 路径自带 `:`，按 `:` 分段必然切错。
 * 与 `local:<n>` 同一取舍：key 只当**不透明 id**，真正的归属记在登记表里
 * （`ToolTab` 的 `pluginId` / `surfaceId`）。
 */
const PLUGIN_TAB_PREFIX = 'plugin:'
/**
 * SFTP 文件管理标签：`sftp:<hostId>`。
 *
 * hostId 是服务端生成的 uuid / 短 id，**不含 `:`**，所以切掉前缀就是 hostId。
 * **一台主机 = 一条标签**（同 id 复用同一条，不做多开）：文件管理页里有「浏览到哪个目录」
 * 这类位置状态，开两份容易互相看晕；与接口请求 / 脚本同一取舍（见 `tool-tabs.ts`）。
 */
const SFTP_TAB_PREFIX = 'sftp:'

/**
 * 隧道管理标签：`tunnel:list`（**全局单例**）。
 *
 * 与 SFTP / 脚本那批「一个对象一条标签」不同：隧道列表本来就**横跨多台主机**
 * （每条隧道自己记 `hostId`），拆成「一台主机一条标签」反而看不到全貌，
 * 也跟 dogi 的单例面板对不上。key 固定，不需要自增序号。
 *
 * 从主机右键进来的「预选主机」是**打开时的参数**，记在登记表里（`ToolTab.tunnelHostId`），
 * **不编进 key** —— 否则同一台主机开两次会得到两条标签。
 */
const TUNNEL_TAB_PREFIX = 'tunnel:'

/**
 * 笔记标签：`note:<n>`（n 由 `tool-tabs.ts` 的自增源给）。
 *
 * ⚠️ **别把「根 id + 相对路径」编进 key**：相对路径是 `a/b.md` 这种**分层**结构，还可能是
 * Windows 路径；而且笔记可以被**重命名**，编进 key 后重命名就得同步改标签 key（状态机不认
 * 「改 key」这件事）。与 `plugin:<n>` 同一取舍：key 只当**不透明 id**，真正的归属记在
 * 登记表里（`ToolTab` 的 `noteRootId` / `notePath`）。
 */
const NOTE_TAB_PREFIX = 'note:'

/** 第 n 条笔记标签的 key（`n` 由 `tool-tabs.ts` 的自增源给） */
export function noteTabKey(seq: number): string {
  return `${NOTE_TAB_PREFIX}${seq}`
}

export function isNoteTabKey(key: string): boolean {
  return key.startsWith(NOTE_TAB_PREFIX)
}

/**
 * 外部文件标签：`file:<n>`（n 由 `tool-tabs.ts` 的自增源给）。
 *
 * 「外部文件」= 用本应用打开的**本机绝对路径** Markdown 文档（双击系统里的 `.md` 进来）。
 * 与「笔记」是两条完全独立的数据通路（那条走登记根 + notes API）。
 *
 * ⚠️ **绝对路径绝不能编进 key**：Windows 路径自带 `:` 和 `\`（`C:\notes\a.md`），
 * 按 `:` 分段必然切错；而且同一个文件要能被「按路径去重」地复用已有标签。
 * 与 `plugin:<n>` / `note:<n>` 同一取舍：key 只当**不透明 id**，
 * 真正的归属记在登记表里（`ToolTab.externalPath`）。
 */
const LOCAL_FILE_TAB_PREFIX = 'file:'

/** 第 n 条外部文件标签的 key */
export function localFileTabKey(seq: number): string {
  return `${LOCAL_FILE_TAB_PREFIX}${seq}`
}

export function isLocalFileTabKey(key: string): boolean {
  return key.startsWith(LOCAL_FILE_TAB_PREFIX)
}

/**
 * 文件管理器标签：`files:list`（**全局单例**）。
 *
 * 与日志 / 隧道 / 脚本同一取舍：浏览的是**服务端那台机器的整盘**，与当前工作区无关，
 * 也不存在「一台主机一条」这种天然切分（这里的路径本来就是本机绝对路径）。
 * 一条标签、一份现场（当前目录 / 选中项 / 剪贴板），再点一次只是聚焦。
 */
const FILES_TAB_PREFIX = 'files:'

/** 文件管理器面板唯一的标签 key */
export function filesTabKey(): string {
  return `${FILES_TAB_PREFIX}list`
}

export function isFilesTabKey(key: string): boolean {
  return key.startsWith(FILES_TAB_PREFIX)
}

/**
 * 系统监控 + 任务管理器标签：`sysmon:list`（**全局单例**）。
 *
 * 与文件管理器 / 日志同一个形状：它看的是**服务端那台机器**（CPU、内存、磁盘、每个进程），
 * 与当前工作区 / 会话 / 主机都无关，也不存在「一台机器一条标签」这种切分 —— 服务端就是
 * 一台机器。一条标签、一份现场（筛选词 / 排序 / 选中行），再点一次只是聚焦。
 *
 * ⚠️ 前缀**没有**复用 `tasks:`：`triggers:` 那套「定时任务」在中文里也叫「任务」，
 * 两个前缀都带 task 会让「点错标签」变成常态。`sysmon` 是 system monitor 的缩写，
 * 与面板里那个「任务管理器」是包含关系（任务管理器是系统监控的一部分），不会歧义。
 */
const SYSMON_TAB_PREFIX = 'sysmon:'

/** 系统监控面板唯一的标签 key */
export function sysmonTabKey(): string {
  return `${SYSMON_TAB_PREFIX}list`
}

export function isSysmonTabKey(key: string): boolean {
  return key.startsWith(SYSMON_TAB_PREFIX)
}

/**
 * 应用日志标签：`logs:list`（**全局单例**）。
 *
 * 与隧道同一取舍：日志是**横跨所有命名空间**的一份流（面板内部用 Tab 切命名空间），
 * 拆成「一个命名空间一条标签」只会让人看不到全貌，也无从对照。key 固定，无自增序号。
 */
const LOGS_TAB_PREFIX = 'logs:'

/** 应用日志面板唯一的标签 key */
export function logsTabKey(): string {
  return `${LOGS_TAB_PREFIX}list`
}

export function isLogsTabKey(key: string): boolean {
  return key.startsWith(LOGS_TAB_PREFIX)
}

/**
 * 定时任务管理面板：`triggers:list`（**全局单例**）。
 *
 * 与日志 / 隧道同一取舍：定时任务横跨所有项目（每条都挂在某个项目上，但管理时是
 * 「我有哪些自动跑的东西、有没有正常跑」这一个视角），拆成「一个项目一条标签」
 * 只会让人看不到全貌。key 固定，无自增序号。
 *
 * ⚠️ 不要用「当前项目」做 key 的组成部分：面板里可以改项目（新建时选），
 * 跟着项目变就得重开标签，正在编辑的表单会被销毁。
 */
const TRIGGERS_TAB_PREFIX = 'triggers:'

/** 定时任务面板唯一的标签 key */
export function triggersTabKey(): string {
  return `${TRIGGERS_TAB_PREFIX}list`
}

export function isTriggersTabKey(key: string): boolean {
  return key.startsWith(TRIGGERS_TAB_PREFIX)
}

/** 隧道面板唯一的标签 key */
export function tunnelTabKey(): string {
  return `${TUNNEL_TAB_PREFIX}list`
}

export function isTunnelTabKey(key: string): boolean {
  return key.startsWith(TUNNEL_TAB_PREFIX)
}

/** 某台主机的 SFTP 文件管理标签 key */
export function sftpTabKey(hostId: string): string {
  return `${SFTP_TAB_PREFIX}${hostId}`
}

export function isSftpTabKey(key: string): boolean {
  return key.startsWith(SFTP_TAB_PREFIX)
}

/** 从 SFTP 标签 key 里取回 hostId（不是该类型标签时返回 null） */
export function sftpHostIdOfTabKey(key: string): string | null {
  return isSftpTabKey(key) ? key.slice(SFTP_TAB_PREFIX.length) : null
}

/** 第 n 条插件界面标签的 key */
export function pluginTabKey(seq: number): string {
  return `${PLUGIN_TAB_PREFIX}${seq}`
}

export function isPluginTabKey(key: string): boolean {
  return key.startsWith(PLUGIN_TAB_PREFIX)
}

/** 某台主机的第 `seq` 条标签 key（**多开**：每点一次就新建一条，不复用已有标签） */
export function hostTabKey(hostId: string, seq: number): string {
  return `${HOST_TAB_PREFIX}${hostId}${HOST_TAB_SEQ_SEP}${seq}`
}

export function isHostTabKey(key: string): boolean {
  return key.startsWith(HOST_TAB_PREFIX)
}

/** 从主机标签 key 里取回主机配置 id（不是主机标签时返回 null；序号段被剥掉） */
export function hostIdOfTabKey(key: string): string | null {
  if (!isHostTabKey(key)) return null
  const rest = key.slice(HOST_TAB_PREFIX.length)
  const sep = rest.indexOf(HOST_TAB_SEQ_SEP)
  return sep >= 0 ? rest.slice(0, sep) : rest
}

/** 第 n 条本机终端的标签 key（`n` 由 `tool-tabs.ts` 的自增源给） */
export function localTabKey(seq: number): string {
  return `${LOCAL_TAB_PREFIX}${seq}`
}

export function isLocalTabKey(key: string): boolean {
  return key.startsWith(LOCAL_TAB_PREFIX)
}

/**
 * 「新建请求草稿」标签用的哨兵 requestId。
 *
 * 草稿不落盘、不进请求列表，但仍是主区域里一个正常的 `api:<id>` 标签（能被拖、被分屏）。
 * 真正的保存发生在用户按 Ctrl/Cmd+S 之后（那时才向服务端要一个真 id）。
 *
 * ⚠️ 定义放在这里而不是 `features/api/api-client.ts`：哨兵是**标签 key 的一部分**，
 * 而 `shared/lib/tool-tabs.ts` 要拿它建草稿标签 —— 定义在 feature 里就变成
 * `shared → features` 的反向边。feature 那边仍可 `import` 到（见 api-client 的转发）。
 */
export const NEW_API_REQUEST_ID = '__new_api__'

/**
 * 「新建 WebSocket 草稿」标签用的哨兵 requestId。
 *
 * 与 `NEW_API_REQUEST_ID` 同一套机制，只是草稿的 `protocol` 定死为 `ws`，保存后由
 * `PanelView` 按协议分派到 `WsPage`。两个哨兵值必须不同：它们各自对应一个草稿标签，
 * 复用同一个 key 会让「新建请求」和「新建 WebSocket」互相顶掉。
 */
export const NEW_WS_REQUEST_ID = '__new_ws__'

/** 接口请求标签 key（`api:<requestId>`；草稿的 requestId 是哨兵 `NEW_API_REQUEST_ID`） */
export function apiTabKey(requestId: string): string {
  return `${API_TAB_PREFIX}${requestId}`
}

export function isApiTabKey(key: string): boolean {
  return key.startsWith(API_TAB_PREFIX)
}

/** 从接口请求标签 key 里取回 requestId（不是该类型标签时返回 null） */
export function apiRequestIdOfTabKey(key: string): string | null {
  return isApiTabKey(key) ? key.slice(API_TAB_PREFIX.length) : null
}

/**
 * 脚本管理面板：`scripts:list`（**全局单例**）。
 *
 * 这一页是脚本的**清单**（分组 / 新建 / 编辑 / 重命名 / 删除 / 运行）。脚本清单横跨
 * 所有主机（同一个脚本可以选任意主机跑），所以和定时任务 / 隧道一样做成全局单例。
 *
 * 前缀用复数 `scripts:`：它指的是「脚本这一堆」，而单个脚本的编辑**已经不是标签**了
 * （`ScriptEditDialog` 模态框，见该文件头）—— 留复数是为了别让人以为它对应某一个脚本。
 */
const SCRIPTS_TAB_PREFIX = 'scripts:'

/** 脚本管理面板唯一的标签 key */
export function scriptsTabKey(): string {
  return `${SCRIPTS_TAB_PREFIX}list`
}

export function isScriptsTabKey(key: string): boolean {
  return key.startsWith(SCRIPTS_TAB_PREFIX)
}

/**
 * 设置面板唯一的标签 key（`settings:list`，**全局单例**）。
 *
 * 为什么设置也进主区域：桌面端原先把它开成独立 BrowserWindow
 * （`apps/desktop/src/renderer/app/SettingsWindow.tsx`），而那是**另一个渲染进程 =
 * 另一份模块级 store 单例**。于是「在设置里停用了插件，主窗口活动栏的图标还在」
 * 这类问题只能靠焦点重拉 / 轮询去猜（见 `shared/lib/plugin-surfaces.ts` 的注释）；
 * 改成标签后设置与对话共享同一个 `AppProvider`，改完主窗口立刻就是对的。
 *
 * 与日志 / 脚本 / 定时任务同一取舍：一份现场、一条标签，已开着时只聚焦。
 */
const SETTINGS_TAB_PREFIX = 'settings:'

export function settingsTabKey(): string {
  return `${SETTINGS_TAB_PREFIX}list`
}

export function isSettingsTabKey(key: string): boolean {
  return key.startsWith(SETTINGS_TAB_PREFIX)
}

/**
 * 是不是工具标签（主机 / 本机终端 / 接口请求 / 脚本管理面板 / 插件界面 / SFTP 文件管理 /
 * 隧道 / 应用日志 / 文件管理 / 系统监控 / 定时任务 / 笔记 / 外部文件 / 设置面板）—— 它们
 * 不参与「当前会话」的同步。
 *
 * 容器型项目的预览**不在此列**：它是会话 SidePanel 的一条标签（`SideTabKey` 的
 * `preview`），不是主区域的工具标签。
 *
 * ⚠️ **新增一种工具标签类型就必须加进这个 OR**：漏了的话它会被 `isConversationTabKey`
 * 判成对话标签，点一下就会去改 `activeConversationId`（顶栏和侧栏高亮跟着跳到别的会话上）。
 * 实测过的症状：漏了 `files:` 时点「文件管理」，面板会去 `openConversation('files:list')`
 * —— 一个不存在的会话 id，于是整块主区域落到 `ConversationTab` 的「新对话」空态上。
 * `panel-tabs.test.ts` 里那组用例就是把这条钉住的（新增前缀往 `cases` 补一行）。
 */
export function isToolTabKey(key: string): boolean {
  return (
    isHostTabKey(key) ||
    isLocalTabKey(key) ||
    isApiTabKey(key) ||
    isScriptsTabKey(key) ||
    isPluginTabKey(key) ||
    isSftpTabKey(key) ||
    isTunnelTabKey(key) ||
    isLogsTabKey(key) ||
    isFilesTabKey(key) ||
    isSysmonTabKey(key) ||
    isTriggersTabKey(key) ||
    isNoteTabKey(key) ||
    isLocalFileTabKey(key) ||
    isSettingsTabKey(key)
  )
}

/**
 * 是不是**对话标签**（会话 id 或空态哨兵）。
 *
 * 「点标签 = 切当前会话」这条同步只对对话标签成立：点一个主机标签去改
 * `activeConversationId`，会让顶栏 / 侧栏高亮跟着跳到一个跟它无关的会话上。
 */
export function isConversationTabKey(key: string): boolean {
  return !isToolTabKey(key)
}
