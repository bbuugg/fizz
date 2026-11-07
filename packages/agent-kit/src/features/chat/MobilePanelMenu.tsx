import {
  Ellipsis,
  Files,
  GitBranch,
  Globe,
  MonitorPlay,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@fizz/ui/dropdown-menu'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/**
 * 手机顶栏的「更多」菜单（`sm:hidden`）：把文件 / 源码 / 预览 / 浏览器 / 面板几颗开关收成一颗。
 *
 * 桌面（`sm` 以上）仍然在顶栏平铺这几颗按钮 —— 手机上顶栏一行要放标题 + 快捷功能 +
 * 终端（分裂两颗），再平铺三颗开关就把标题挤到只剩两三个字。菜单项的文案跟着当前
 * 状态走（「收起面板」/「展开面板」），点完菜单自动关闭，用户不会以为没生效。
 */
export function MobilePanelMenu({
  sideTab,
  gitChangeCount,
  canExpandPanel,
  showPreview,
  showBrowser,
  showFiles = true,
  showGit = true,
  onToggleFiles,
  onToggleGit,
  onTogglePreview,
  onToggleBrowser,
  onTogglePanel,
}: {
  sideTab: string | null
  /** 未提交改动数量（0 = 不显示；>0 时在菜单项右侧显示数量徽标） */
  gitChangeCount: number
  /** 面板里是否已经挂出至少一个标签（没挂出就没有「展开面板」可言） */
  canExpandPanel: boolean
  /** 容器型项目才有预览这一项 */
  showPreview: boolean
  /** 真实会话才有浏览器画面（草稿标签连不到 `agent-browser` 会话） */
  showBrowser: boolean
  /** 文件面板 / 源码管理：默认露头（远端工作区也支持，见 FilesPanel / gitExecFor）；`false` 留给没有目录的场景 */
  showFiles?: boolean
  showGit?: boolean
  onToggleFiles: () => void
  onToggleGit: () => void
  onTogglePreview: () => void
  onToggleBrowser: () => void
  onTogglePanel: () => void
}) {
  const tr = useT()
  const active = sideTab !== null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-7! w-8! p-0! sm:hidden', active && 'text-primary')}
          aria-label={tr('更多面板入口')}
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {showFiles && (
          <DropdownMenuItem onSelect={onToggleFiles}>
            <Files className="size-3.5 shrink-0" />
            {sideTab === 'files' ? tr('收起工作区文件') : tr('工作区文件')}
          </DropdownMenuItem>
        )}
        {showGit && (
          <DropdownMenuItem onSelect={onToggleGit}>
            <GitBranch className="size-3.5 shrink-0" />
            {sideTab === 'git' ? tr('收起源代码管理') : tr('源代码管理')}
            {gitChangeCount > 0 && (
              <span className="ml-auto min-w-4 shrink-0 rounded-full bg-destructive px-1 text-center text-[0.625rem] font-medium leading-4 text-white tabular-nums">
                {gitChangeCount}
              </span>
            )}
          </DropdownMenuItem>
        )}
        {showPreview && (
          <DropdownMenuItem onSelect={onTogglePreview}>
            <MonitorPlay className="size-3.5 shrink-0" />
            {sideTab === 'preview' ? tr('收起预览') : tr('预览（容器页面）')}
          </DropdownMenuItem>
        )}
        {showBrowser && (
          <DropdownMenuItem onSelect={onToggleBrowser}>
            <Globe className="size-3.5 shrink-0" />
            {sideTab === 'browser' ? tr('收起浏览器') : tr('浏览器画面')}
          </DropdownMenuItem>
        )}
        {canExpandPanel && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onTogglePanel}>
              {active ? (
                <PanelRightClose className="size-3.5 shrink-0" />
              ) : (
                <PanelRightOpen className="size-3.5 shrink-0" />
              )}
              {active ? tr('收起面板') : tr('展开面板')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
