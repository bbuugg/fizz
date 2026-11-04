/**
 * 通用设置：结束通知 + 语音输入 + 屏幕常亮 + 系统监控 + 远程访问 + 软件更新。
 *
 * **跟 AI 行为有关的几项（工具权限 / 并发 / 意图 / 子任务 / 审批超时 / 重试）不在
 * 这里**，已经搬到 `AiPreferencesTab`（设置 → AI → 通用）：通用只管「宿主环境与提醒」。
 *
 * - 结束通知：任务出错 / 结束 / 中断、单轮结束、对话一轮结束时提醒一次 ——
 *   页面在后台走系统通知、在前台走应用内 toast（分流逻辑在 `lib/notify.ts`，
 *   这里只管偏好与系统通知的授权）。触发逻辑在 `hooks/use-notify-watcher.ts`。
 * - 屏幕常亮：手机息屏期间页面在后台收不到任何东西，锁屏把「跑完的结果」也一起挡掉了。
 *   三档（关 / 只在一轮跑的时候 / 始终），生命周期在 `lib/wake-lock.ts`，
 *   这里只管偏好与能力探测。
 * - 系统监控：状态栏左侧那条服务器性能监控的总开关（服务端全局一份）。关掉后
 *   服务端**连采样一起停**、状态栏也不再渲染监控条。
 * - 软件更新（desktop 专属）：应用自身的自动更新入口，见 `AppUpdateSection`。
 *   静默只检查、**下载必须用户点**（产品约定）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Bell, Copy, ExternalLink, Globe, Languages, Mic, Sun } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { NumberField } from '@fizz/ui/number-field'
import { Switch } from '@fizz/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { getAgentHost, type RemoteAccessState } from '@fizz/agent-client/host'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import {
  DEFAULT_SYSTEM_MONITOR_SETTINGS,
  type SystemMonitorSettings
} from '@fizz/contracts'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { APP_LANGUAGES } from '@fizz/contracts'
import { toast } from 'sonner'
import {
  notifyPermission,
  notifySupported,
  refreshNotifyPermission,
  requestNotifyPermission,
  saveNotifyEnabled,
  useNotifyEnabled,
  type NotifyPermissionResult
} from '@fizz/agent-kit/shared/lib/notify'
import { isNativeShell } from '@fizz/agent-kit/shared/lib/native-notify'
import {
  setVoiceSilenceTimeout,
  useVoiceSilenceTimeout
} from '@fizz/agent-kit/shared/lib/voice-prefs'
import {
  retryWakeLock,
  saveWakeLockMode,
  useWakeLockDesired,
  useWakeLockMode,
  useWakeLockState,
  wakeLockSupported,
  type WakeLockMode
} from '@fizz/agent-kit/shared/lib/wake-lock'
import { AppUpdateSection } from './AppUpdateSection'
import {
  Segmented,
  type SegmentedOption
} from '@fizz/agent-kit/shared/components/Segmented'

/** 屏幕常亮的档位：关 / 只在一轮 Agent 跑的时候 / 页面在前台就始终 */
const WAKE_LOCK_OPTIONS: ReadonlyArray<SegmentedOption<WakeLockMode>> = [
  { value: 'off', label: '关闭', title: '不申请屏幕唤醒锁' },
  {
    value: 'running',
    label: '会话进行中',
    title: '只在有会话正在跑（含后台会话）时保持屏幕常亮，跑完立刻释放'
  },
  {
    value: 'always',
    label: '始终',
    title: '页面在前台就保持屏幕常亮（旧版开关的行为）'
  }
]

export function GeneralTab({ app }: { app: AgentApp }) {
  const tr = useT()
  /** 语音输入在 desktop 宿主不可用（宿主缺语音服务）：下面那一节整块不渲染 */
  const isDesktopHost = !getAgentHost().capabilities.voice

  /** 语音输入静音超时（秒）：偏好存 localStorage，Composer 读它决定语音识别何时停 */
  const silenceSec = useVoiceSilenceTimeout()

  /**
   * 屏幕常亮：偏好档位 + 浏览器能力 + **实际有没有锁上** + **当前该不该锁**。
   *
   * ⚠️ 状态文案不能只看偏好：这个 API 的锁随时可能被系统收掉（省电策略、用户锁屏），
   * 而且「会话进行中」档在空闲时本来就该是没锁的 —— 只看档位会显示成「已开启」，
   * 变成一个查不到的问题。
   */
  const wakeSupported = wakeLockSupported()
  const wakeMode = useWakeLockMode()
  const wakeDesired = useWakeLockDesired()
  const lockState = useWakeLockState()
  const wakeStatus =
    wakeMode === 'off'
      ? '已关闭'
      : lockState === 'on'
        ? wakeMode === 'running'
          ? '会话进行中，已保持常亮'
          : '始终保持常亮'
        : lockState === 'error'
          ? '没能拿到锁'
          : wakeDesired
            ? '正在申请锁…'
            : '会话进行中时自动开启（当前没有任务）'

  /**
   * 结束通知：偏好（总闸门，两条通道都归它管）+ 系统授权（只影响后台那条系统通知）。
   *
   * 安卓壳里的系统权限只能**跨桥异步查询**，而 `notifyPermission()` 是同步函数
   * （它读 `native-notify.ts` 的缓存），所以挂载后补一次真实状态，否则进设置页
   * 会先闪一下「还没授权」。
   */
  const nativeShell = isNativeShell()
  const supported = notifySupported()
  const notifyEnabled = useNotifyEnabled()
  const [permission, setPermission] = useState<NotifyPermissionResult>(notifyPermission)

  useEffect(() => {
    if (!nativeShell) return
    let alive = true
    void refreshNotifyPermission().then((next) => {
      if (alive) setPermission(next)
    })
    return () => {
      alive = false
    }
  }, [nativeShell])

  /**
   * 系统监控偏好（服务端全局一份，desktop / web 共享）。
   * `null` = 还没拉到 → 按默认值（开）渲染，免得首帧闪一下「已关闭」。
   */
  const systemMonitor = app.systemMonitorSettings ?? DEFAULT_SYSTEM_MONITOR_SETTINGS
  const [monitorSaving, setMonitorSaving] = useState(false)
  /** 保存系统监控偏好：失败要说出来（同 saveBrowser） */
  const saveMonitor = async (patch: Partial<SystemMonitorSettings>): Promise<void> => {
    setMonitorSaving(true)
    const ok = await app.saveSystemMonitorSettings(patch)
    setMonitorSaving(false)
    if (!ok) toast.error(tr('保存失败：{reason}', { reason: useAgentStore.getState().error ?? tr('未知原因') }))
  }

  /**
   * 开：偏好先置上（前台的 toast 不需要任何授权），再顺手申请系统通知权限 ——
   * 只有**后台**（页面不可见 / 窗口不在前台）那条通道要它。被拒 / 弹窗被静默拦截
   * 都不影响前台提示，所以也不撤回偏好。
   */
  const onToggle = async (next: boolean): Promise<void> => {
    if (!next) {
      saveNotifyEnabled(false)
      return
    }
    saveNotifyEnabled(true)
    if (permission !== 'granted') {
      const result = await requestNotifyPermission()
      setPermission(result)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Languages className="size-3.5" />
          {tr('界面语言')}
        </div>
        <Segmented
          ariaLabel={tr('界面语言')}
          value={app.language}
          onChange={(next) => void app.saveLanguage(next)}
          options={APP_LANGUAGES.map((item) => ({
            value: item.value,
            label: item.label === 'English' ? 'English' : tr('中文')
          }))}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Activity className="size-3.5" />
          {tr('系统监控')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('状态栏左侧的服务器性能监控。关闭后服务端停止采样，状态栏也不再显示。默认开启。')}
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="system-monitor-enabled"
            checked={systemMonitor.enabled}
            disabled={monitorSaving}
            onCheckedChange={(next) => void saveMonitor({ enabled: next })}
          />
          <label htmlFor="system-monitor-enabled" className="text-xs text-muted-foreground">
            {systemMonitor.enabled ? tr('已开启') : tr('已关闭（后台不再采集性能数据）')}
          </label>
        </div>
      </section>

      {/*
        桌面端语音输入暂时不可用（Composer 的麦克风按钮、快捷键都已按平台收掉）：整节不渲染，
        免得给一个调了不动的设置项。web 端正常展示。
      */}
      {!isDesktopHost && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Mic className="size-3.5" />
            {tr('语音输入静音超时')}
          </div>
          <p className="text-xs leading-4 text-muted-foreground">
            {tr('连续静音多久后停止语音输入。0 = 不自动停止。')}
          </p>
          <div className="flex items-center gap-2">
            <NumberField
              value={silenceSec}
              min={0}
              max={3600}
              onValueChange={(next) => setVoiceSilenceTimeout(next ?? 60)}
              invalidHint={tr('需为 0–3600 的整数秒，离开输入框会夹到最近的边界')}
              aria-label={tr('语音输入静音超时')}
              className="w-28 font-mono"
            />
            <span className="text-xs text-muted-foreground">
              {tr('秒')}{silenceSec === 0 ? tr('（不自动停）') : ''}
            </span>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Bell className="size-3.5" />
          {tr('结束通知')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('任务结束、出错、被中断或对话回复完成时提醒一次；后台走系统通知，前台走应用内提示。')}
          {nativeShell && tr(' 安卓端为本地通知，App 被系统清理后收不到。')}
        </p>
        {supported ? (
          <>
            <div className="flex items-center gap-3">
              <Switch
                id="notify-enabled"
                checked={notifyEnabled}
                onCheckedChange={onToggle}
              />
              {/* 开关 = 总偏好。授权只决定**后台**那条系统通知能不能发：前台的应用内
                  toast 不需要任何授权，所以「未授权」不等于「已关闭」，别再拿 permission
                  —— 只看权限的话，「授权了但把开关关了」会与偏好自相矛盾 */}
              <label htmlFor="notify-enabled" className="text-xs text-muted-foreground">
                {!notifyEnabled
                  ? tr('已关闭')
                  : permission === 'granted'
                    ? tr('已开启')
                    : tr('已开启（前台为应用内提示）')}
              </label>
            </div>
            {permission === 'denied' && (
              <p className="text-xs leading-4 text-muted-foreground">
                {nativeShell
                  ? tr('系统通知权限已被关闭，页面无法再次申请。请到 系统设置 → 应用 → Fizz → 通知 里允许，回到 App 后这里会自动更新。在此之前：前台的右上角提示仍然会用，只有切到后台（含锁屏）时的系统提醒发不出去。')
                  : tr('通知权限已被浏览器拒绝，且无法由页面再次申请。请在地址栏的站点设置里把「通知」改为允许，刷新本页后即可开启。在此之前：前台的右上角提示仍然会用，只有切到后台时的系统提醒发不出去。')}
              </p>
            )}
            {(permission === 'default' || permission === 'stuck') && (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="outline" onClick={() => void onToggle(true)}>
                  {permission === 'stuck'
                    ? tr('再试一次')
                    : nativeShell
                      ? tr('开启系统通知')
                      : tr('授权浏览器通知')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {permission === 'stuck'
                    ? tr('授权弹窗一直没弹出来 —— 多半被浏览器的「安静模式」拦截了（以前关过几次弹窗的站点会这样）。点地址栏左侧的小图标，或到 浏览器设置 → 网站设置 → 通知 里把本站改为「允许」，刷新后再试。')
                    : nativeShell
                      ? tr('未开启系统通知，点此授权；后台提醒需要它，前台提示不需要。')
                      : tr('未授权通知，点此在浏览器中允许；后台提醒需要它。')}
                </span>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs leading-4 text-muted-foreground">
            {tr('当前浏览器不支持系统通知（部分环境在非 HTTPS 下也会禁用）：切到后台时发不出提醒，但前台的右上角提示仍然会用。')}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sun className="size-3.5" />
          {tr('屏幕常亮')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('有任务运行时保持屏幕常亮；跑完自动释放，切到后台也会释放，回来后按需重新获取。')}
        </p>
        {wakeSupported ? (
          <>
            <Segmented
              ariaLabel={tr('屏幕常亮')}
              value={wakeMode}
              onChange={saveWakeLockMode}
              options={WAKE_LOCK_OPTIONS.map((o) => ({ ...o, label: tr(String(o.label)), title: o.title ? tr(o.title) : undefined }))}
            />
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">{tr(wakeStatus)}</span>
              {wakeDesired && lockState === 'error' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void retryWakeLock()}
                >
                  {tr('再试一次')}
                </Button>
              )}
            </div>
            {wakeDesired && lockState === 'error' && (
              <p className="text-xs leading-4 text-muted-foreground">
                {tr('浏览器没把锁给下来（系统省电策略、或页面刚从后台回来还没拿到前台权限时会这样）。点「再试一次」；仍不行就手动锁一次屏再解锁。')}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs leading-4 text-muted-foreground">
            {tr('当前浏览器不支持屏幕唤醒锁（iOS Safari 与部分桌面浏览器尚未实现），页面里没有这个开关能开的替代方案 —— 需要的话改用系统的「屏幕常亮」设置。')}
          </p>
        )}
      </section>

      <RemoteAccessSection app={app} />

      {/* 软件更新（desktop 打包版专属）：宿主没实现 appUpdate 时自己整块不渲染 */}
      <AppUpdateSection />
    </div>
  )
}

/**
 * 远程访问（desktop 专属）：把进程内后端暴露到一个真实端口，浏览器里的 web 端直连。
 *
 * 能力探测：`AgentHost.loadRemoteAccess` 只有 desktop 实现 —— web 宿主没有「本机端口」
 * 这个概念（它是被托管的那一方），这一块就不渲染。
 *
 * ⚠️ hooks 全部无条件调用，「没实现就不渲染」放在 hooks **之后** return，
 * 不然条件 return 会让 hooks 顺序在两次渲染之间漂（React 直接报错）。
 */
function RemoteAccessSection({ app }: { app: AgentApp }) {
  const tr = useT()
  const host = getAgentHost()
  const save = host.saveRemoteAccess?.bind(host) ?? null
  const initial = host.loadRemoteAccess?.() ?? null
  const [state, setState] = useState<RemoteAccessState | null>(initial)
  /** 端口是**草稿**：改完点应用（或拨开关）才落到主进程。`null` 只会在清空时短暂出现 */
  const [portDraft, setPortDraft] = useState<number | null>(() => initial?.port ?? 7801)
  const [busy, setBusy] = useState(false)
  /** 修改密码弹窗：旧密码 + 新密码 + 确认；只保存新密码的哈希 */
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [currentDraft, setCurrentDraft] = useState('')
  const [newDraft, setNewDraft] = useState('')
  const [confirmDraft, setConfirmDraft] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  /** 图标按钮：把一段文本复制到剪贴板（`label` 同时用于提示与无障碍名） */
  const copyButton = (text: string, label: string): ReactNode => (
    <IconTip label={tr('复制{label}', { label })}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={tr('复制{label}', { label })}
        disabled={!text}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => toast.success(tr('已复制{label}', { label })),
            () => toast.error(tr('复制失败，请手动选中'))
          )
        }}
      >
        <Copy />
      </Button>
    </IconTip>
  )

  if (!save) return null

  /**
   * 要列出来的地址。`urls` 是主进程按网卡现算的；`state.url` 那条兜底只为**热更新时
   * 遇到旧 preload**（它不知道 `urls` 这个字段）不至于让整块面板崩掉。
   */
  const urls = state?.urls ?? (state?.url ? [state.url] : [])

  /**
   * 一条地址：地址 + 复制 + 在系统浏览器里打开。
   *
   * 每一条都挂「打开」—— 服务端绑的是 `0.0.0.0`，**本机对上面每个地址都能打开**，
   * 所以这个按钮不存在「主进程替你挑」的问题；反倒是逐条点开、哪个能加载就是哪个
   * 网卡有效，比看 IP 猜快得多。
   */
  const addressRow = (u: string, muted = false): ReactNode => (
    <div
      key={u}
      className={
        muted ? 'flex items-center gap-2 text-muted-foreground' : 'flex items-center gap-2'
      }
    >
      {muted && <span className="shrink-0">{tr('本机')}</span>}
      <code className="min-w-0 flex-1 truncate">{u}</code>
      {copyButton(u, tr('访问地址'))}
      <IconTip label={tr('在系统浏览器里打开')}>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={tr('在系统浏览器里打开')}
          onClick={() => void host.openExternal?.(u)}
        >
          <ExternalLink />
        </Button>
      </IconTip>
    </div>
  )

  /** 改密码：校验旧密码后由服务端写入新哈希，不用重启监听（登录接口每次请求现读） */
  const submitPassword = async (): Promise<void> => {
    const api = app.api
    if (!api) {
      toast.error(tr('服务端未连接'))
      return
    }
    if (!newDraft) {
      toast.error(tr('新密码不能为空'))
      return
    }
    if (newDraft !== confirmDraft) {
      toast.error(tr('两次输入的新密码不一致'))
      return
    }
    setPasswordBusy(true)
    try {
      await api.changePassword({ currentPassword: currentDraft, newPassword: newDraft })
      toast.success(tr('密码已更新'))
      setPasswordOpen(false)
      setCurrentDraft('')
      setNewDraft('')
      setConfirmDraft('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tr('修改密码失败'))
    } finally {
      setPasswordBusy(false)
    }
  }

  /**
   * 把主进程带回来的原始错误翻成人话。
   *
   * `startRemoteAccess` 失败时 `state.error` 里是 Node 的原文（`listen EADDRINUSE:
   * address already in use 0.0.0.0:7801`），直接甩给用户等于没说 —— 端口占用是这一块
   * 最常见、也最容易自己解决的失败，单独认出来。
   */
  const describeError = (error: string | undefined, port: number): string => {
    if (!error) return tr('未知原因')
    if (/EADDRINUSE/i.test(error)) {
      return tr('端口 {port} 已被占用：换一个端口，或先关掉占用它的程序', { port })
    }
    if (/EACCES/i.test(error)) {
      return tr('没有权限监听端口 {port}（1024 以下是特权端口）', { port })
    }
    return error
  }

  /** 落一次改动。主进程会**重启监听**才生效（服务端只在启动时读 `FIZZ_AUTH_*`） */
  const apply = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      // 端口以输入框为准（输入框已经保证是 1–65535 的整数；清空时回落到当前配置）
      const port = portDraft ?? state?.port ?? 7801
      const next = await save({ enabled, port })
      setState(next)
      setPortDraft(next.port)
      /**
       * ⚠️ 失败**不会抛**：主进程（agent-host 的 `startRemoteAccess`）把 listen 的错误收进
       * `info.error` 之后照常返回，所以 `await save()` 永远是成功。只看返回值的话，表现就是
       * 「开关自己弹回去、界面一个字都没有」。这里必须自己判结果并吭一声。
       */
      if (enabled && !next.enabled) {
        toast.error(tr('远程访问没能开启'), { description: describeError(next.error, next.port) })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tr('远程访问设置失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Globe className="size-3.5" />
        {tr('远程访问（局域网）')}
      </div>
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('把这台机器的 Agent 后端开放到局域网，其他设备用浏览器即可访问完整工作台。')}
      </p>
      <div className="flex items-center gap-3">
        <Switch
          checked={state?.enabled === true}
          onCheckedChange={(v) => void apply(v)}
          disabled={busy}
          aria-label={tr('开启端口监听')}
        />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {tr('端口')}
          <NumberField
            value={portDraft}
            min={1}
            max={65535}
            onValueChange={(next) => setPortDraft(next ?? state?.port ?? 7801)}
            invalidHint={tr('端口需为 1–65535 的整数，离开输入框会夹到最近的边界')}
            className="h-7 w-24 tabular-nums"
            disabled={busy}
            aria-label={tr('监听端口')}
          />
        </div>
        {busy && <span className="text-xs text-muted-foreground">{tr('应用中…')}</span>}
      </div>

      {/*
        失败原因**不放在 `state.enabled` 里**：失败时 `running` 恒为 false、这一块整段不渲染，
        于是「端口被占用」这种最该看到的信息恰好被藏掉了（toast 会消失，这里留一条常驻的）。
      */}
      {state?.error && (
        <div className="text-xs leading-4 text-destructive">{describeError(state.error, state.port)}</div>
      )}

      {state?.enabled && (
        <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
          <div className="space-y-1">
            <span className="text-muted-foreground">{tr('访问地址')}</span>
            {urls.map((u) => addressRow(u))}
            {urls.length === 0 && (
              <div className="text-muted-foreground">{tr('没找到对外网卡，只能在本机用')}</div>
            )}
            {/*
              回环固定列一条：别的设备用不上，但「同机的隧道 / 反向代理」要填的就是它
              （公网访问最常见的接法就是把 7801 转出去），所以不能只写在「没网卡」的兜底里。
            */}
            {addressRow(`http://127.0.0.1:${state.port}`, true)}
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-muted-foreground">
              {tr('首次用浏览器打开登录页时设置密码（只保存哈希），之后用这个密码登录。')}
            </span>
            <Button size="xs" variant="outline" onClick={() => setPasswordOpen(true)}>
              {tr('修改密码')}
            </Button>
          </div>
          {!state.webServed && (
            <div className="text-muted-foreground">
              {tr('没找到 web 产物')}（<code>apps/web/dist</code>）：{tr('浏览器打开只有接口、没有界面。先在仓库根跑一次')} <code>npm run build:web</code> {tr('再开关一次这里。')}
            </div>
          )}
        </div>
      )}

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tr('修改远程访问密码')}</DialogTitle>
            <DialogDescription>{tr('先输入当前密码，再设置新密码。新密码只保存哈希。')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="current-password" className="text-sm font-medium">
                {tr('当前密码')}
              </label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentDraft}
                onChange={(e) => setCurrentDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="new-password" className="text-sm font-medium">
                {tr('新密码')}
              </label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newDraft}
                onChange={(e) => setNewDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm-password" className="text-sm font-medium">
                {tr('确认新密码')}
              </label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmDraft}
                onChange={(e) => setConfirmDraft(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)} disabled={passwordBusy}>
              {tr('取消')}
            </Button>
            <Button onClick={() => void submitPassword()} disabled={passwordBusy}>
              {passwordBusy ? tr('保存中…') : tr('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
