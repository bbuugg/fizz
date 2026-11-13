/**
 * 工作区快捷功能：工作区工具条上的一个下拉按钮（Zap 图标），菜单里是
 * `<工作区>/.fizz/workspace.json` 配好的快捷功能，点一下执行
 * （打开链接 / 跑命令 / 打开路径）。
 *
 * 从根应用 `WorkspaceQuickActions.tsx` 迁移到 shadcn DropdownMenu。
 *
 * ## 按钮**始终渲染**，增删改的入口在列表最底部
 *
 * 以前这里是「纯启动器」：没有配置时整颗隐藏，增删改去顶栏齿轮打开的「工作区设置」
 * 弹窗。2026-10 那颗齿轮和弹窗一起删了，管理入口收进本下拉**最底部的「管理快捷功能…」**
 * （`QuickActionsDialog`）。于是按钮不能再藏：0 条时它是「进这个功能」的**唯一**入口，
 * 藏起来等于整个功能从界面上消失。
 *
 * 菜单结构固定成两段：上面是能直接点的动作（0 条时整段不渲染），下面一条分隔线 +
 * 「管理快捷功能…」。管理项**永远在最底部**，不会随条目多少上下漂。
 *
 * ⚠️ 触发器统一用 `LiquidGlassButton` + `DropdownMenuTrigger asChild`：与同排的
 * 「终端 / 浏览器 / 文件」共用同一套液态玻璃材质与 `rounded-md` 圆角，
 * 也保留 focus 环与 disabled 态。别再换回普通 `Button variant="outline"`。
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Settings2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { LiquidGlassButton } from '@fizz/ui/liquid-glass'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'
import { QUICK_ACTION_ICONS, runQuickAction } from '@fizz/agent-kit/shared/lib/quick-actions'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { QuickAction } from '@fizz/contracts/workspace-config'

export function WorkspaceQuickActions({
  workspaceId,
  workspacePath,
  actions,
  onRunCommand,
  onOpenExternal,
  onOpenPath,
  onManage
}: {
  workspaceId: string
  /** 工作区根目录绝对路径（path 类动作按它解析相对路径） */
  workspacePath: string
  /** 该工作区配好的快捷功能（AgentApp 按工作区加载）；空数组 = 只剩「管理快捷功能…」 */
  actions: QuickAction[]
  /** 在工作区目录里**新开一条**内嵌终端执行命令（AgentApp 提供） */
  onRunCommand: (command: string) => Promise<void>
  onOpenExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  onOpenPath: (path: string) => Promise<{ ok: boolean; error?: string }>
  /** 打开「快捷功能」管理弹窗（增删改 / 排序；AgentApp 提供） */
  onManage: () => void
}) {
  const tr = useT()
  /** 执行中标记：挡住连续点击（菜单点完就收） */
  const runningRef = useRef(false)
  /** 执行中才显示的小转圈，给用户一个「点了，正在跑」的反馈 */
  const [running, setRunning] = useState(false)

  // 工作区切换时清掉执行态（上一个工作区的执行不该影响下一个）
  useEffect(() => {
    runningRef.current = false
    setRunning(false)
  }, [workspaceId])

  const run = async (id: string): Promise<void> => {
    if (runningRef.current) return
    const action = actions.find((a) => a.id === id)
    if (!action) return
    runningRef.current = true
    setRunning(true)
    try {
      const error = await runQuickAction(action, {
        workspacePath,
        runCommand: onRunCommand,
        openExternal: onOpenExternal,
        openPath: onOpenPath
      })
      // 成功不提示：浏览器 / 终端 / 资源管理器本身就是反馈
      if (error) toast.error(tr('「{name}」执行失败：{error}', { name: action.label, error }))
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  // 没有任何快捷功能时也**照样渲染**：这时它是「去添加一条」的唯一入口（见文件头）。
  // 早先这里是 `if (actions.length === 0) return null` —— 配合顶栏那颗齿轮才说得通。

  return (
    <DropdownMenu>
      {/* Tooltip 套在 DropdownMenuTrigger 外面（Radix 的 asChild 会链式转发到同一个 button）。
          `variant="outline"`：与同排「打开 / 终端 / 文件」同款描边 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <LiquidGlassButton tone="contrast"
              className="inline-flex h-7 w-8 items-center justify-center rounded-md p-0 focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={tr('工作区快捷功能')}
            >
              {running ? <Loader2 className="size-4 animate-spin text-primary" /> : <Zap className="size-4" />}
            </LiquidGlassButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tr('工作区快捷功能')}</TooltipContent>
      </Tooltip>
      {/* align="end"（与顶栏「打开」下拉一致）：菜单右缘对齐按钮右缘、向左展开，
          不会从窗口右缘溢出去；max-w 限制长说明被 truncate，避免菜单横向拉太宽 */}
      <DropdownMenuContent align="end" className="max-w-80 min-w-44">
        {actions.map((action) => {
          const Icon = QUICK_ACTION_ICONS[action.kind]
          return (
            <DropdownMenuItem key={action.id} onSelect={() => void run(action.id)}>
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="truncate">{action.label}</span>
              {action.description && (
                <span className="ml-auto truncate pl-4 text-xs text-muted-foreground" title={action.description}>
                  {action.description}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
        {/* 管理入口钉在**最底部**：0 条时连分隔线一起省掉，菜单里只剩这一项 */}
        {actions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onManage}>
          <Settings2 className="size-3.5 text-muted-foreground" />
          <span className="truncate">{tr('管理快捷功能…')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

