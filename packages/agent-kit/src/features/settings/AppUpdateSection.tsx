/**
 * 软件更新（打包版专属：desktop 安装包 / 安卓 APK）：检查 / 下载 / 安装应用自身的更新。
 *
 * 与 dogi 的同一套约定：**静默只检查，下载必须用户点**，装也要用户点。
 * 界面按主进程那份状态机的六个档位渲染（`available` = 有新版本等你点下载），
 * 状态来自 `shared/lib/app-update.ts`（模块级一份订阅，与状态栏指示条 / 应用内提示共用）。
 * 安卓壳没有「重启安装」这一步（下载完调起系统安装器），文案按 `isNativeShell()` 换。
 *
 * 两个渲染纪律：
 *
 * 1. **能力探测 `appUpdateAvailable()` 放在 hooks 之后** return —— 条件 return 提前会让
 *    hooks 顺序在两次渲染之间漂（React 直接报错）。与 `RemoteAccessSection` 同一纪律。
 * 2. **首个快照到达前不渲染正文**（`status` 为 null 时只留标题与说明）：状态是异步取的
 *    （一次 IPC 往返），先按默认值画会把「开发模式不支持自动更新」这种话闪一下再消失。
 */
import { useState } from 'react'
import { Download, Loader2, RefreshCw, RotateCw, X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Progress } from '@fizz/ui/progress'
import { Switch } from '@fizz/ui/switch'
import {
  appUpdateAvailable,
  cancelAppUpdate,
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  saveUpdateNotifyEnabled,
  useAppUpdateStatus,
  useUpdateNotifyEnabled
} from '@fizz/agent-kit/shared/lib/app-update'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { isNativeShell } from '@fizz/agent-kit/shared/lib/native-notify'

export function AppUpdateSection() {
  const tr = useT()
  const status = useAppUpdateStatus()
  const notifyEnabled = useUpdateNotifyEnabled()
  /** 按钮的「正在发指令」态：只覆盖 IPC 往返那一小段，真正的进度看 status.state */
  const [busy, setBusy] = useState(false)

  // 宿主没有这个能力（web / 非 desktop）：整块不渲染
  if (!appUpdateAvailable()) return null

  const state = status?.state ?? 'idle'
  const percent = status?.percent ?? 0
  /** 安卓壳里安装 = 调起系统安装器（没有「重启安装」这一步），文案要跟着换 */
  const native = isNativeShell()

  /** 包一层：把 busy 开关收在一个地方，免得每个按钮各写一遍 */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <RefreshCw className="size-3.5" />
        {tr('软件更新')}
      </div>
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('启动后自动检查新版本')}
      </p>

      {status && !status.supported && (
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('当前不是安装包启动，自动更新不可用。')}
        </p>
      )}

      {status?.supported && (
        <>
          {/*
            「有更新时提醒我」：关掉只影响**打扰**（状态栏指示 + 应用内 toast），
            这一节本身永远显示 —— 用户说的「只在设置中显示」就是它。
          */}
          <div className="flex items-center gap-2">
            <Switch
              id="update-notify-enabled"
              checked={notifyEnabled}
              onCheckedChange={saveUpdateNotifyEnabled}
            />
            <label htmlFor="update-notify-enabled" className="text-xs text-muted-foreground">
              {tr('有更新时提醒我')}
            </label>
          </div>
          <p className="text-xs leading-4 text-muted-foreground">
            {notifyEnabled
              ? tr('有新版本时，状态栏会出现一条指示、应用内也会弹一条提示。')
              : tr('已关闭：状态栏与应用内都不再提醒，有新版本只在这里显示。')}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {tr('当前版本')} <code className="text-foreground">v{status.current}</code>
            </span>

            {(state === 'idle' || state === 'up-to-date') && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(checkAppUpdate)}
              >
                <RefreshCw />
                {state === 'up-to-date' ? tr('再检查一次') : tr('检查更新')}
              </Button>
            )}

            {state === 'checking' && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {tr('正在检查…')}
              </span>
            )}

            {state === 'up-to-date' && (
              <span className="text-xs text-muted-foreground">{tr('已是最新版本')}</span>
            )}

            {state === 'available' && (
              <>
                <span className="text-xs text-foreground">
                  {tr('发现新版本')} <code>v{status.latest ?? '?'}</code>
                </span>
                <Button size="sm" disabled={busy} onClick={() => void run(downloadAppUpdate)}>
                  <Download />
                  {tr('下载')}
                </Button>
              </>
            )}

            {state === 'downloaded' && (
              <>
                <span className="text-xs text-foreground">
                  {tr('新版本')} <code>v{status.latest ?? '?'}</code>{' '}
                  {native
                    ? tr('已下载，点「打开安装器」完成安装')
                    : tr('已下载，重启后生效')}
                </span>
                <Button size="sm" disabled={busy} onClick={() => void run(installAppUpdate)}>
                  <RotateCw />
                  {native ? tr('打开安装器') : tr('重启并安装')}
                </Button>
              </>
            )}

            {state === 'downloading' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(cancelAppUpdate)}
              >
                <X />
                {tr('取消')}
              </Button>
            )}
          </div>

          {state === 'downloading' && (
            <>
              <div className="flex items-center gap-2">
                <Progress value={percent} className="h-1.5" />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {percent}%
                </span>
              </div>
              <p className="text-xs leading-4 text-muted-foreground">
                {tr('正在后台下载，可继续使用。')}
              </p>
            </>
          )}

          {state === 'downloaded' && (
            <p className="text-xs leading-4 text-muted-foreground">
              {native
                ? tr('会打开系统安装器，确认后完成安装。')
                : tr('会退出应用，安装完成后自动打开。')}
            </p>
          )}
        </>
      )}

      {status?.error && <p className="text-xs leading-4 text-destructive">{status.error}</p>}
    </section>
  )
}
