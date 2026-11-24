/**
 * 客户端偏好的**服务端权威表**：哪些 key 要跨端一致、各自怎么归一化。
 *
 * ## 为什么需要这张表
 *
 * 这批偏好原本是各模块自己 `localStorage.setItem`，于是有三个坑：
 * 1. 桌面端设置页是独立窗口（另一个渲染进程 = 另一份 store 单例），改完主窗口不生效；
 * 2. 手机 / 另一台机器打开看到的是自己那份，永远对不齐；
 * 3. 最要命的一条：`maxRetries` / `maxSteps` / `toolCallConcurrency` / `toolIntent` 是
 *    **服务端 agent 循环真正读取的值**，存在浏览器里意味着**定时任务**（`scheduler.ts`
 *    直接 `startTurn`，不经过任何渲染端）永远只能拿到 `runAgent` 的缺省值 ——
 *    用户在设置页填的数字对无人值守的任务完全不生效。
 *
 * 现在改成：服务端存一份（`CoreData.prefs`），写入走**一个通用 patch 接口**
 * `POST /api/prefs`（提交几个 key 就改几个，不按 key 开接口），变更经 `state-ws` 的
 * `prefs` 域推给所有端；各端只把 localStorage 当**首帧缓存**（避免默认值闪一下、离线可用）。
 *
 * ## 值一律是字符串
 *
 * localStorage 里本来全是字符串，服务端沿用同形就能直接镜像：前端 `writePref` 原样上行、
 * 下行原样写回，不用两套序列化，也不会因为「服务端存数字、本地存字符串」而反复判等失败。
 * 归一化只在这一层做一次，服务端只落合法值。
 *
 * ## 谁**不**在这张表里
 *
 * - `fizz.language`：已有专属字段 `CoreData.language` + `/api/system/language`（服务端构建
 *   系统提示词也要用），再存一份就是双真源；
 * - `fizz.web.colorThemes`：自定义主题含背景图 **data URL**（单张上限 1.6MB），本来就在
 *   localStorage 配额边缘，不适合塞进每次全量推送的快照（要同步得走对象存储）；
 * - 设备形态相关的：`terminalFontSize` / `shortcuts` / `keepScreenAwake` /
 *   监控轮询间隔 / 面板宽度 —— 手机与桌面的诉求相反（字号、键位、亮屏、屏宽、
 *   1 秒轮询在手机上就是耗电耗流量），同步过去是**负体验**；它们继续留在本地
 *   （跨窗口由 `prefs-sync` 的本地总线管）。
 *
 * 「通知开关」曾经也在这份名单里，现在挪进来了：它是**用户的意愿**（"别打扰我"），
 * 不随设备变；而真正的差异是**系统授权**，那是每台设备各问一次的，不该由偏好表代管
 * （偏好开着但没授权的端会自己退到应用内 toast，见 `notify.ts`）。
 */

/** 服务端同步的偏好 key（与 localStorage 的 key 完全相同，一处改两处都要认） */
export const PREF_KEYS = [
  // ---- A：服务端执行语义（agent 循环读数；改完立刻影响下一轮，不用重启） ----
  /** 权限档：full / confirm / readonly */
  'fizz.web.permissionMode',
  /** 命令沙箱：off（默认）/ workspace-write（Linux bwrap / macOS sandbox-exec） */
  'fizz.web.sandboxMode',
  /** 审批超时（**分钟**，0 = 一直等）；前端存分钟，服务端用时再换成毫秒 */
  'fizz.web.confirmTimeout',
  /** 模型请求自动重试次数（0..50） */
  'fizz.web.maxRetries',
  /** 一轮最多跑多少步（1..500） */
  'fizz.web.maxSteps',
  /** 同一批 tool-call 的并发上限（1..16） */
  'fizz.web.toolCallConcurrency',
  /** 工具卡「意图」开关（'1' / '0'） */
  'fizz.web.toolIntent',

  // ---- B：与设备形态无关的用户偏好 ----
  /** 默认 shell 的 id（**服务端机器**上的 shell，所以要跟着服务端走；空串 = 自动探测） */
  'fizz.agent.terminalShell',
  'fizz.web.terminalCopyOnSelect',
  'fizz.web.terminalPasteOnRightClick',
  'fizz.web.terminalCommandPrediction',
  'fizz.web.terminalCommandHistory',
  /** 滚动缓冲行数（只允许 1000 / 5000 / 10000 / 50000，防止几个 G 的 cell 缓冲） */
  'fizz.web.terminalScrollback',
  'fizz.web.gitTreeView',
  'fizz.web.fsShowIgnored',
  /** 'on' / 'off'（Monaco 的 wordWrap 取值，不是 1/0） */
  'fizz.web.editorWordWrap',
  'fizz.web.editorLineNumbers',
  /** 'list' / 'grid' */
  'fizz.file-manager.view',
  'fizz.file-manager.show-hidden',
  /** 通知总闸门（'1' / '0'）：系统授权是每台设备各问一次的，不在这一层 */
  'fizz.web.notify',
  /** 语音输入连续静音超时（**秒**，0 = 不自动停；合法区间 [0, 3600]） */
  'fizz.web.voiceSilenceTimeout'
] as const

export type PrefKey = (typeof PREF_KEYS)[number]

/** 一份完整的偏好（服务端 `CoreData.prefs` 与 `prefs` 快照域的形状） */
export type PrefsSnapshot = Record<PrefKey, string>

/** 只提交改动项（`POST /api/prefs` 的 body）；缺的 key = 保留原值 */
export type PrefsPatch = Partial<PrefsSnapshot>

/** `GET/POST /api/prefs` 的应答：服务端归一化后的**全量**一份 */
export interface PrefsResult {
  prefs: PrefsSnapshot
}

/**
 * 数值上下限**直接用 agent-api 的常量**，不在这里重写一遍：
 * 两边一旦漂移，就会出现「服务端允许 10、prefs 卡在 16」或反之，夹紧逻辑互相打架。
 */
import {
  MAX_MAX_STEPS,
  MAX_TOOL_CALL_CONCURRENCY,
  MIN_MAX_STEPS,
  MIN_TOOL_CALL_CONCURRENCY
} from './agent-api'

/** 归一化器：返回 `null` = 这个值不合法，**不要**用它覆盖已有配置 */
type PrefCodec = (raw: unknown) => string | null

function intInRange(min: number, max: number): PrefCodec {
  return (raw) => {
    if (typeof raw !== 'number' && typeof raw !== 'string') return null
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (text === '') return null
    const value = Number(text)
    if (!Number.isFinite(value)) return null
    return String(Math.min(max, Math.max(min, Math.round(value))))
  }
}

/**
 * 只夹上界、下界外一律判非法（= 保留原值）。
 *
 * 与 `intInRange` 的区别不是风格，是**各自对齐旧的读侧**：`maxSteps` 老实现会把
 * -3 夹成 1（所以这里也夹），而语音静音超时的老实现把负数当「没存过」回落默认 ——
 * 负数一旦被夹成 0，语义就从「60 秒后自动停」变成「永远不停、麦克风一直开」。
 */
function intAtLeast(min: number, max: number): PrefCodec {
  return (raw) => {
    if (typeof raw !== 'number' && typeof raw !== 'string') return null
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (text === '') return null
    const value = Number(text)
    if (!Number.isFinite(value) || value < min) return null
    return String(Math.min(max, Math.round(value)))
  }
}

function oneOf(values: readonly string[]): PrefCodec {
  return (raw) => (typeof raw === 'string' && values.includes(raw) ? raw : null)
}

const bool = oneOf(['0', '1'])

/** shell id 只认 `pwsh` / `wsl` / `gitbash` / 绝对路径这类：挡住换行与控制字符 */
const shellId: PrefCodec = (raw) => {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '') return '' // 空 = 自动探测，是合法值
  return /^[\w.:\\/\- ]{1,260}$/.test(value) ? value : null
}

/**
 * 每个 key 的归一化器。
 *
 * ⚠️ 顺序与 `PREF_KEYS` 无关（是 Record），但**加 key 时必须两处都加**：`PREF_KEYS` 决定
 * 服务端收不收、推不推，这里决定收下之后存成什么。
 */
const CODECS: Record<PrefKey, PrefCodec> = {
  'fizz.web.permissionMode': oneOf(['full', 'confirm', 'readonly']),
  // 沙箱是**显式开启**的能力：默认 off，且没有可用后端的平台保持 off（见 CommandSandboxMode）
  'fizz.web.sandboxMode': oneOf(['off', 'workspace-write']),
  // 上限刻意放宽：设置页是自由输入（只有 `min={0}`），用户填 7 天 / 100 次这种也该原样生效，
  // 这里的区间只用来挡 `Infinity` / 负数 / 天文数字，不做体验上的「替用户决定」
  'fizz.web.confirmTimeout': intInRange(0, 365 * 24 * 60),
  'fizz.web.maxRetries': intInRange(0, 1000),
  'fizz.web.maxSteps': intInRange(MIN_MAX_STEPS, MAX_MAX_STEPS),
  'fizz.web.toolCallConcurrency': intInRange(MIN_TOOL_CALL_CONCURRENCY, MAX_TOOL_CALL_CONCURRENCY),
  'fizz.web.toolIntent': bool,

  'fizz.agent.terminalShell': shellId,
  'fizz.web.terminalCopyOnSelect': bool,
  'fizz.web.terminalPasteOnRightClick': bool,
  'fizz.web.terminalCommandPrediction': bool,
  'fizz.web.terminalCommandHistory': bool,
  'fizz.web.terminalScrollback': oneOf(['1000', '5000', '10000', '50000']),
  'fizz.web.gitTreeView': bool,
  'fizz.web.fsShowIgnored': bool,
  'fizz.web.editorWordWrap': oneOf(['on', 'off']),
  'fizz.web.editorLineNumbers': bool,
  'fizz.file-manager.view': oneOf(['list', 'grid']),
  'fizz.file-manager.show-hidden': bool,
  'fizz.web.notify': bool,
  'fizz.web.voiceSilenceTimeout': intAtLeast(0, 3600)
}

/**
 * 缺省值。与各模块原来的读侧回落**必须一一对齐**（否则没设置过的用户升级后行为会变）：
 * 尤其 `gitTreeView` 是「`!== '0'` 即树状」、`terminalScrollback` 是 5000、`wordWrap` 是 on。
 */
export const DEFAULT_PREFS: PrefsSnapshot = {
  'fizz.web.permissionMode': 'confirm',
  'fizz.web.sandboxMode': 'off',
  'fizz.web.confirmTimeout': '10',
  'fizz.web.maxRetries': '2',
  'fizz.web.maxSteps': '80',
  'fizz.web.toolCallConcurrency': '3',
  'fizz.web.toolIntent': '1',

  'fizz.agent.terminalShell': '',
  'fizz.web.terminalCopyOnSelect': '1',
  'fizz.web.terminalPasteOnRightClick': '1',
  'fizz.web.terminalCommandPrediction': '1',
  'fizz.web.terminalCommandHistory': '1',
  'fizz.web.terminalScrollback': '5000',
  'fizz.web.gitTreeView': '1',
  'fizz.web.fsShowIgnored': '0',
  'fizz.web.editorWordWrap': 'on',
  'fizz.web.editorLineNumbers': '1',
  'fizz.file-manager.view': 'grid',
  'fizz.file-manager.show-hidden': '0',
  // 老读侧是 `getItem() !== '0'` → 没存过 = 开
  'fizz.web.notify': '1',
  'fizz.web.voiceSilenceTimeout': '60'
}

const PREF_KEY_SET: ReadonlySet<string> = new Set(PREF_KEYS)

/** 这个 key 要不要同步到服务端（前端 `writePref` 据此决定推不推） */
export function isPrefKey(key: string): key is PrefKey {
  return PREF_KEY_SET.has(key)
}

/** 读侧归一化：缺失 / 非法一律回落默认值（`store.load` 与前端收到快照时都用它） */
export function normalizePref(key: PrefKey, raw: unknown): string {
  return CODECS[key](raw) ?? DEFAULT_PREFS[key]
}

/** 读侧全量：老数据文件 / 脏快照都补成一份完整、合法的偏好 */
export function normalizePrefs(input: unknown): PrefsSnapshot {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const result = {} as PrefsSnapshot
  for (const key of PREF_KEYS) result[key] = normalizePref(key, source[key])
  return result
}

/**
 * 写侧：只保留**认识且合法**的 key。
 *
 * 非法值直接丢弃（不是回落成默认值）——「设置页手滑传了 `maxRetries: NaN`」不该把用户
 * 原来的 5 冲成 2；前端只提交用户真正改过的 key，丢掉一项不影响其它项。
 */
export function normalizePrefsPatch(input: unknown): PrefsPatch {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const patch: PrefsPatch = {}
  for (const key of PREF_KEYS) {
    if (!(key in source)) continue
    const value = CODECS[key](source[key])
    if (value !== null) patch[key] = value
  }
  return patch
}
