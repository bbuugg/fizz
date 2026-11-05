/**
 * 应用内更新提示（desktop 打包版专属，对齐 dogi 的 `UpdateNotifier`）。
 *
 * 只在两个**需要用户拍板**的档位弹一条常驻提示（`duration: Infinity`，带「稍后」可关掉）：
 *
 * - `available`：发现新版本 —— 顺带把「不会自动下载」写清楚，主按钮才是「下载」；
 * - `downloaded`：下好了 —— 主按钮「重启并安装」。
 *
 * 其余档位一律不弹：
 * - `downloading`：进度在状态栏指示条与设置页里看，不该再占一条右上角的常驻提示
 *   （而且它没有「用户要拍板的事」，弹了只会变成噪音）；
 * - `checking` / `up-to-date`：无事发生，弹提示 = 打扰。
 *
 * 整条还受设置里的「有更新时提醒我」管（`useUpdateNotifyEnabled`）：关掉就一条都不弹，
 * 连已经弹出来的也立刻 dismiss。设置页那一节永远显示，不受这个开关影响。
 *
 * ⚠️ `id` 固定成同一个：同一个版本的提示反复触发时**更新**那一条而不是堆一串
 * （状态抖动 / 两个窗口都可能触发）。与 `use-error-toast.ts` 同一套路。
 *
 * ## 为什么在共享包里，而不是 `apps/desktop`
 *
 * 1. **挂载点在共享外壳**：它渲染在 `shell/app-shell.tsx` 里，和 `StatusBar`（以及挂在它上面的
 *    后台任务 / 传输徽标）同一层「外壳常驻 chrome」。而 desktop 的 renderer 只剩 `ClientRoot`
 *    薄包装 + 窗口级 UI
 *    （`TitleBar` / `SettingsWindow`），外壳内部没有它的挂载点。
 * 2. **「只有 desktop 会弹」是靠宿主能力探测表达的，不是靠文件位置**：能力定义在
 *    `@fizz/agent-client/host` 的可选 `appUpdate` 上。desktop 的宿主实现了它（`renderer/host.ts`
 *    转给主进程），web 的宿主没有；mobile 用的是 `apps/mobile/src/app/app-shell.tsx` 那份
 *    自己的外壳，压根不挂这个组件。所以 web 下 `useAppUpdateStatus()` 恒为 `null` →
 *    恒走最后那句 `toast.dismiss()`，连一次 IPC 都不会发（`app-update.ts` 的 `bind()` 直接 return）。
 * 3. **同一份状态有三个消费点，全在共享包**：`shell/layout/AppUpdateBadge`（状态栏徽章）、
 *    设置页的 `AppUpdateSection`、以及这条 toast，判据都是 `appUpdateAvailable()` /
 *    `useAppUpdateStatus()`。只把这条 toast 搬去 desktop，会把一份订阅拆成两处，
 *    下次改文案 / 加档位就得记得改两个包。
 *
 * 代价是 web 产物里多一段永远不生效的代码（几百字节，且 sonner 本来就已引入）。
 * 真要严格按「谁用谁有」搬，就把上面三处**一起**搬 —— 别只搬这一个。
 */
import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  downloadAppUpdate,
  installAppUpdate,
  useAppUpdateStatus,
  useUpdateNotifyEnabled
} from '@fizz/agent-kit/shared/lib/app-update'

const TOAST_ID = 'app-update'

export function AppUpdateNotifier() {
  const status = useAppUpdateStatus()
  const notifyEnabled = useUpdateNotifyEnabled()
  const state = status?.state ?? 'idle'
  const latest = status?.latest ?? ''

  useEffect(() => {
    /**
     * 用户在设置里关掉了「有更新时提醒我」：**连已经弹出来的那条也要收掉** ——
     * 否则开关一关、右上角那条常驻提示还杵在那儿（`duration: Infinity`，不主动 dismiss
     * 就不会自己走）。
     *
     * 关掉不等于关掉更新：设置页的「软件更新」分区照常显示状态与下载 / 安装按钮。
     */
    if (!notifyEnabled) {
      toast.dismiss(TOAST_ID)
      return
    }

    if (state === 'available') {
      toast(`发现新版本 v${latest}`, {
        id: TOAST_ID,
        // 常驻：等用户决定「下载」还是「稍后」，别自己消失
        duration: Infinity,
        description: '不会自动下载，点「下载」才开始',
        action: { label: '下载', onClick: () => void downloadAppUpdate() },
        cancel: { label: '稍后', onClick: () => toast.dismiss(TOAST_ID) }
      })
      return
    }

    if (state === 'downloaded') {
      toast(`新版本 v${latest} 已就绪`, {
        id: TOAST_ID,
        duration: Infinity,
        description: '重启应用后生效',
        action: { label: '重启并安装', onClick: () => void installAppUpdate() },
        cancel: { label: '稍后', onClick: () => toast.dismiss(TOAST_ID) }
      })
      return
    }

    toast.dismiss(TOAST_ID)
  }, [state, latest, notifyEnabled])

  return null
}
