/**
 * 「在文件面板里打开某个文件」的两条通路。
 *
 * - **请求**（`requestOpenWorkspaceFile` / `useOpenFileRequest`）：先存后取，给「发起方
 *   知道是哪个工作区、但面板可能还没挂出来」的场景用（消息下方的文档入口）；
 * - **宿主通道**（`WorkspaceFileOpenerProvider` / `useWorkspaceFileOpener`）：由会话宿主
 *   递下去一个「怎么打开」的回调，给「发起方在消息流深处、不知道自己在哪个面板」的场景用
 *   （工具卡里那颗文件名，见 `PartView`）。
 *
 * 两者不合并：前者的调用方本来就知道 `workspaceId`，后者得由宿主现算（会话 → 工作区 →
 * 面板 key），硬塞进同一个 API 只会让调用方各自重复算一遍。
 *
 * ## 为什么需要它（两个方案都不行的理由）
 *
 * - **传 props 不行**：发起方是消息下方的文档入口（在 `ChatPanel` 里），消费方是右侧
 *   面板里的 `FilesPanel`，中间隔着 `ConversationTab` 的面板装配 —— 不是一棵能直接
 *   传回调的子树；
 * - **window 事件不行**：点入口时会先 `showSideTab('files')` 把面板**挂出来**，事件在
 *   FilesPanel 的监听挂上之前就发完了，请求直接丢（面板本来就在时又恰好能用 —— 这类
 *   「有时灵」的 bug 最难查）。
 *
 * 所以需要一个**先存后取**的位置：发起方写进来，FilesPanel 挂载时 / 挂载后读走。
 * 与 `lib/pending-draft.ts` 同一个思路（那边是「新会话挂上来之后自取预填草稿」）。
 *
 * ## 为什么带 workspaceId
 *
 * 各会话各挂一套面板（面板常驻、工作区不中途变），同时活着的可能不止一套。带上归属，
 * 每套面板只认自己那一个工作区的请求 —— 否则点会话 A 的文档，会话 B 的面板也会去开。
 *
 * ## 为什么还要 panelKey
 *
 * 分屏 / 后台标签里可能同时挂着**同一个工作区的多套**文件面板。只按 workspaceId 认领时，
 * 请求会被最先跑 effect 的那套面板消费掉 —— 发起方这一侧的面板打开了，文件却开在别的
 * 标签里（表现为「只打开文件面板、文件没打开」，偶发，取决于面板挂载顺序）。
 * 所以请求同时带**发起方标签的 panel key**，只有目标面板能消费。
 */
import { createContext, useContext, useSyncExternalStore } from 'react'

export interface OpenFileRequest {
  /** 发起方所在标签的面板 key（`ConversationTab` 的 key：会话 id / `draft:<工作区>`） */
  panelKey: string
  /** 目标文件所属工作区（`FilesPanel` 只认自己那一个） */
  workspaceId: string
  /** 工作区相对路径（'/' 分隔） */
  path: string
  /** 自增序号：值相同 = 同一条请求（同一个路径连点两次也能再触发一次） */
  nonce: number
}

let current: OpenFileRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 请求在（某个标签的）文件面板里打开一个文件。
 *
 * 面板还没挂出来也没关系 —— 请求留在这里，面板挂上后的第一次渲染就会取走它。
 *
 * @param panelKey 发起方所在标签的面板 key（见 `ConversationTab` 的 key）
 */
export function requestOpenWorkspaceFile(
  panelKey: string,
  workspaceId: string,
  path: string
): void {
  if (!panelKey || !workspaceId || !path) return
  current = { panelKey, workspaceId, path, nonce: ++seq }
  emit()
}

/**
 * 这条请求是不是发给**这个面板**的。
 *
 * `panelKey` 是主判据：同一个工作区可能同时挂着多套文件面板（分屏 / 后台标签），
 * 只按 workspaceId 认领会被别的面板先消费掉。workspaceId 同时核对一次，防止
 * 面板 key 复用或工作区切换瞬间的错配。
 */
export function matchesOpenFileRequest(
  request: OpenFileRequest | null,
  panelKey: string | undefined,
  workspaceId: string | undefined
): request is OpenFileRequest {
  return (
    !!request &&
    !!panelKey &&
    !!workspaceId &&
    request.panelKey === panelKey &&
    request.workspaceId === workspaceId
  )
}

/**
 * 消费掉一条请求（面板处理完立刻调用，否则每次重渲染都会把同一个文件重开一遍）。
 *
 * 按 `nonce` 核对：期间又来了新请求（用户连点两份文档）时不能误清掉新的那条。
 */
export function consumeOpenFileRequest(nonce: number): void {
  if (current?.nonce !== nonce) return
  current = null
  emit()
}

/** 订阅当前待处理的请求（没有则 null）。必须在 React 组件里用。 */
export function useOpenFileRequest(): OpenFileRequest | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current,
    () => null
  )
}

// ---------- 宿主通道：工具卡里「点文件名 → 打开」 ----------

/**
 * 「把这个文件打开到右侧文件面板」的宿主能力。
 *
 * 由会话宿主（`ChatPanel`）经 context 递下去：只有它同时知道**这个标签的面板 key**与
 * **会话所属的工作区**，而发起方（`PartView` 的工具卡）在消息流深处，两者都拿不到。
 */
export interface WorkspaceFileOpener {
  /**
   * 工作区根目录的**绝对路径**（`''` = 不知道根）。
   *
   * 给调用方判「这个路径能不能落到工作区里」用：工具入参里的 `file_path` 可能是绝对路径，
   * 只有先削掉这个前缀才是文件面板要的相对路径（见 `shared/lib/workspace-path.ts`）。
   */
  root: string
  /**
   * 在右侧「文件」面板里打开这个文件。
   *
   * 入参可以是绝对路径，也可以是工作区相对路径 —— 归一化在这里面做（调用方不必先算一遍）。
   * 工作区外 / 没有工作区目录时是空操作。
   */
  open: (path: string) => void
}

const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null)

export const WorkspaceFileOpenerProvider = WorkspaceFileOpenerContext.Provider

/**
 * 取「打开文件」的宿主能力；不在会话宿主里（容器工作台的片段渲染、项目管理助手）时是
 * `null` —— 调用方据此**不做成可点**，而不是点了没反应。
 *
 * ⚠️ 宿主必须保证这个值是**引用稳定**的：它是 context，一变整列 memo 过的 `PartView`
 * 都会白重渲（流式期间每来一帧一次）。
 */
export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext)
}
