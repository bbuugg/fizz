/**
 * 「这个工作区还不是 git 仓库」的**统一空态**：图标 + 一句话 + 「初始化 git 仓库」按钮 +
 * `.gitignore` 提醒。
 *
 * 两处共用（长相只有一份）：
 * - `GitPanel` 的整页空态（外面给 `flex-1` 撑满面板）；
 * - `BranchPicker` 分支面板里的非仓库态（`py-4`，面板只有 288px 宽，紧凑一点）。
 *
 * 刻意不做成 `PickerEmpty` 那种一行灰字：初始化是这一步唯一的动作，得让人一眼看到按钮。
 */
import { GitBranch, Plus } from 'lucide-react'
import { SpinnerButton } from '@fizz/ui/spinner-button'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function NotARepoState({
  busy = false,
  initializing = false,
  onInit,
  className
}: {
  /** 有写操作在跑（按钮一并禁用） */
  busy?: boolean
  /** 正在执行的就是 `git init`（按钮转圈） */
  initializing?: boolean
  onInit: () => void
  className?: string
}) {
  const t = useT()
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        className
      )}
    >
      <GitBranch className="size-6 text-muted-foreground/50" />
      <p className="text-sm text-foreground">{t('这个工作区还不是 git 仓库。')}</p>
      <SpinnerButton
        className="h-7! gap-1.5 text-xs"
        disabled={busy}
        loading={initializing}
        spinnerClassName="size-3.5"
        title={t(
          '在这个工作区目录里执行 git init（初始分支沿用你 git 配置里的 init.defaultBranch）'
        )}
        onClick={onInit}
      >
        {!initializing && <Plus className="size-3.5" />}
        {t('初始化 git 仓库')}
      </SpinnerButton>
      <p className="max-w-[280px] text-xs text-muted-foreground">
        {t('建议先补')} <code>.gitignore</code>{' '}
        {t('再提交。')}
      </p>
    </div>
  )
}
