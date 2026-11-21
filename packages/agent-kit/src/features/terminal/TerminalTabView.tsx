/**
 * 终端标签的容器:终端本体 + **可展开的内嵌 AI 助手**。
 *
 * ## 为什么助手挂在终端标签里
 *
 * 用户要的是「在任意标签页上挂载」——终端标签是最需要的那一类:看着一台机器的输出,
 * 想让 AI 直接接手排查。所以每个终端标签可以展开一个助手,它:
 *
 * - **绑定这个终端**(`boundTerminalTabKey`) —— 发消息时把终端工具随请求上送,
 *   模型能执行命令 / 读输出 / 发按键(执行在渲染端,见 `shared/lib/client-tools.ts`);
 * - **各自一条会话**(按 tabKey 记忆) —— 多个终端标签各聊各的,互不顶掉上下文;
 * - 作用域是 `terminal` —— 只有这个终端的工具,**没有**项目管理工具(见契约的 `scope`)。
 *
 * 全局面板(app-shell 右侧停靠那份)保持原样,两者互不影响。
 *
 * ## 入口进终端的**悬浮球**
 *
 * 不自己绝对定位一颗按钮 —— 终端里已经有一颗可拖动的悬浮球（`TerminalFab`，点开是圆环），
 * 这里通过 `terminal-actions` 把「AI 终端助手」这一项**交给终端**排进圆环里。终端自己的
 * 「命令历史」也在同一圈，谁加入口都不会互相压住，也不再占终端顶部一条区域。
 *
 * ## 收起不卸载终端
 *
 * 助手收起只是不渲染 aside —— 终端始终在流里（它的 PTY / xterm 不能重建）。
 *
 * ## 宽度可以拖（全局一份）
 *
 * aside 左缘有一颗 `ResizeHandle`（`invert`：面板在右侧，向左拖才变宽），宽度记在
 * `lib/terminal-assistant-width.ts`。默认按容器三成出头算、**上限是容器的一半**（再多
 * 就把终端挤没了），两个都跟着容器走 —— 终端标签可能被塞进对话右侧那种 400px 级的
 * 窄面板里，写死 `w-96` 会把终端挤没。没拖过（`null`）时才用默认值，拖过就尊重用户。
 *
 * ## 窄容器改成覆盖形态（手机 / 侧栏里的终端）
 *
 * 容器窄于 `TERMINAL_SPLIT_MIN_WIDTH`（640 = 助手 320 + 终端 320）时不做左右分屏 ——
 * 分屏的最小宽是硬碰硬的：`375px` 的手机上助手会顶到 320、终端只剩 55px。这时助手改成
 * 绝对定位**盖住终端**，一次只看一个（与 `SidePanel` 手机端的 overlay 同约定）。终端
 * 始终在流里、不卸载，关掉助手立刻回到全宽。
 *
 * 判据用**容器宽**而不是 `useIsMobile()`：终端标签会出现在主区 / 对话右侧面板 / 容器
 * 工作台等任何容器里，该跟着容器走。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { AssistantPanel } from '@fizz/agent-kit/features/projects/AssistantPanel'
import {
  TerminalActionsProvider,
  type TerminalAction
} from '@fizz/agent-kit/features/terminal/terminal-actions'
import { ResizeHandle } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { useContainerWidth } from '@fizz/agent-kit/features/chat/SidePanel'
import {
  TERMINAL_ASSISTANT_MIN_WIDTH,
  TERMINAL_SPLIT_MIN_WIDTH,
  defaultTerminalAssistantWidth,
  maxTerminalAssistantWidth,
  resetTerminalAssistantWidth,
  setTerminalAssistantWidth,
  useTerminalAssistantWidth
} from '@fizz/agent-kit/shared/lib/terminal-assistant-width'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function TerminalTabView({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  /**
   * 容器宽度：助手面板的默认宽度与拖拽上限都按它算（见文件头）。
   *
   * 挂在**根节点**上而不是终端那一侧：aside 变宽时根节点是 `w-full`、宽度不变，
   * 不会形成「拖宽 → 容器变 → 上限跟着变」的回环。
   */
  const [containerRef, containerWidth] = useContainerWidth()
  const userWidth = useTerminalAssistantWidth()
  /** 正在拖动：拖动期间给 aside 关掉 `pointer-events`（见下面样式处） */
  const [dragging, setDragging] = useState(false)
  /**
   * 窄容器不做左右分屏，助手改成**覆盖层**盖住终端。
   *
   * 判据用**容器宽**而不是 `useIsMobile()`：终端标签会出现在任何容器里（主区、对话右侧
   * 那种 380px 级的面板、容器工作台），该跟着容器走。分屏最小宽是 640（助手 320 +
   * 终端 320），容器不够时 `max()` 兜底会把助手顶到 320、终端压到几十 px。
   *
   * `containerWidth > 0` 是首帧守卫：`useContainerWidth` 首帧是 0，不守卫会让宽容器也先
   * 渲染一帧覆盖形态。助手默认收起（`open` 为 false），所以那一帧并不会真画出来。
   */
  const overlay = containerWidth > 0 && containerWidth < TERMINAL_SPLIT_MIN_WIDTH
  const maxWidth = maxTerminalAssistantWidth(containerWidth)
  /** `ResizeHandle` 提交的已经是夹好的合法值，这里再夹一次只防容器变窄后的旧值 */
  const width =
    userWidth === null
      ? defaultTerminalAssistantWidth(containerWidth)
      : Math.min(Math.max(userWidth, TERMINAL_ASSISTANT_MIN_WIDTH), maxWidth)

  /**
   * 塞进终端悬浮球圆环里的那一项（「AI 终端助手」）。
   *
   * 展开后不再显示 —— 收起动作由 aside 顶栏那颗「收起助手面板」负责，
   * 同一个动作不摆两处（与 `SidebarTopBar` 那条注释同一条理由）。
   * 用 `useMemo` 定住数组引用：上下文值每次渲染都换新数组会让 `TerminalPanel` 里
   * 那层 `fabActions` 的 memo 每帧失效。
   */
  const fabActions = useMemo<TerminalAction[]>(
    () =>
      open
        ? []
        : [
            {
              key: 'assistant',
              label: 'AI 终端助手',
              icon: <Sparkles className="size-4" />,
              onClick: () => setOpen(true)
            }
          ],
    [open]
  )

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full">
      {/* 终端本体:必须常挂 —— 收起助手不能重建 PTY / xterm */}
      <div className="relative min-w-0 flex-1">
        <TerminalActionsProvider value={fabActions}>{children}</TerminalActionsProvider>
      </div>

      {/*
        助手面板：`open` 只是**挂载条件**，不是「会话边界」—— 收起再展开接着上一段聊。
        现场在 store 里（按 tabKey 存），跨刷新还有本地存档，见 AssistantPanel / 助手切片。
      */}
      {open && (
        <>
          {/* 拖拽条在**面板左侧**：往左拖才是把它拉宽 → invert。
              可拖范围为 0 时（窄容器把上限夹到了下限，见 width 模块的说明）干脆不渲染 ——
              留一颗拖了没反应的抓手比没有更糟。覆盖形态也不给：那时宽度跟着容器走。 */}
          {!overlay && maxWidth > TERMINAL_ASSISTANT_MIN_WIDTH && (
            <ResizeHandle
              invert
              width={width}
              min={TERMINAL_ASSISTANT_MIN_WIDTH}
              max={maxWidth}
              onResize={setTerminalAssistantWidth}
              onDragStart={() => setDragging(true)}
              onDragEnd={() => setDragging(false)}
              onDoubleClick={resetTerminalAssistantWidth}
            />
          )}
          <aside
            className={cn(
              'flex flex-col bg-background',
              // 覆盖形态：铺满容器、盖在终端上（与 `SidePanel` 手机端同款）。终端不卸载，
              // 关掉助手立刻回到全宽 —— 收起 / 展开都不重建 PTY / xterm。
              overlay
                ? 'absolute inset-y-0 right-0 z-30 w-full shadow-2xl'
                : 'shrink-0 border-l',
              /*
               * 拖拽中整块面板**不吃指针事件** —— 与 `SidePanel` 同一条（那边注释里有完整由来）。
               *
               * 这里的方向性是重点：抓手在面板**左缘**，向右拖 = 指针钻进面板内部，而面板里
               * 可能有预览的 `<iframe>` / `<webview>`，`pointermove` 一进 guest 就被它吞掉，
               * window 上的监听收不到 → 宽度卡住、等指针离开 guest 又猛跳一截。向左拖是指针
               * 离开面板进终端区（同文档，不吞事件），所以只有「向右拖不跟手」。
               *
               * 跨源 guest 上 `setPointerCapture` 在部分 Chromium 里也无效，只能靠这一层挡。
               */
              dragging && 'pointer-events-none'
            )}
            style={overlay ? undefined : { width }}
          >
            <AssistantPanel
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              scope="terminal"
              boundTerminalTabKey={tabKey}
              onClose={() => setOpen(false)}
            />
          </aside>
        </>
      )}
    </div>
  )
}
