/**
 * 手机版「设置」页：整屏铺满的独立页面，取代 `SettingsDialog` 那层弹窗。
 *
 * 为什么手机上不用弹窗：
 * - 弹窗得给自己编一个高度（`88dvh`），而键盘一弹、地址栏一缩，这个高度就跟可视区对不上，
 *   里面的表单要么被盖住、要么在底部留一截空白；整页铺满则直接吃外壳那条高度链
 *   （`html/body { height: 100% }`，键盘由原生缩布局视口让位），这里不用再算。
 * - 弹窗的关闭只有一个右上角的 ×（还有一层遮罩），在手机上既难点、也不符合「返回上一层」
 *   的直觉；设置现在是独立整页，标题栏右上角给一颗 ×（安卓返回键也接管成
 *   「先退二级页、再关页面」，见 `android-back.ts`）。
 * - 设置是**独占**的：进去就是配置，不需要边看对话边配。
 *
 * ## 数据 / 退出 = 真正的设置入口（不走旁路）
 *
 * 桌面 / web 的「导入 / 导出」在设置外面（左下角菜单的子菜单），共享的分组清单里
 * 本来没有对应分组；手机版没有那个菜单，它们必须进设置页 —— 走的是手机壳的**宿主扩展点**
 * （`SettingsShell` 的 `extraGroups`）：渲染成与内置分组完全同款的导航项（菜单 / 详情
 * 两级导航、返回行、同一滚动容器），内容也用各 Tab 同款的分节样式（`space-y-6` 根 + `space-y-2`
 * 分节 + 胶囊按钮）。第一版曾把它们做成页面顶部的自绘快捷区块，UI 与设置页其它项
 * 明显不一致 —— 就是没有扩展点时旁路造的杈，已废。
 *
 * 本工程恒用这一页（没有「宽屏换回 `SettingsDialog`」的分支）：从外壳到页面都按
 * 手机形态写死，平板横屏 / 桌面浏览器调试时也是同一套整页设置。
 *
 * ## 关闭入口
 *
 * 手机版没有底部导航（设置入口在抽屉头右上角，见 `layout/Sidebar.tsx`）。这一层是
 * `fixed inset-0`，跳出了外壳的安全区内边距，所以根节点自己补 `padding-bottom`；
 * 关闭键就是标题栏右上角那颗 ×。
 *
 * ## 进出场 = 左侧平移（iOS「从右边推进来」那套）
 *
 * 不淡入淡出、不从下往上弹：设置是「上一层里推进来的一屏」，所以整页从**右缘滑入**、
 * 收起时滑回右缘（`useEntered` / `useSlideOut`）。理由：
 * - 平移不改透明度，壁纸 / 背景照常透出来，不会先闪一层底色；
 * - 与抽屉（`activity-sidebar` 的 `translate-x`）是同一套界面语汇，都靠 CSS 的
 *   `translate` 属性 + `transition-transform`（Tailwind v4 展开含 `translate`，
 *   见 `styles.css` 那段注释 —— 写成 `transition-[transform]` 会变成瞬移）。
 *
 * 退场必须**先播动画、再卸载**：`app-shell` 一 `false` 就把这一层从树上摘了，
 * 光靠 CSS 没有退场可言。所以关闭动作先落 `closing`，`transitionend`（带兜底定时器，
 * 防「过渡被跳过就永远不结束」）之后才调真正的 `onClose` —— 外面那个开关 / 安卓返回栈
 * 看到的仍是「开着」，退场途中按返回键等于再关一次，不会把下面的页面退走。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type TransitionEvent
} from 'react'
import { ChevronLeft, Database, FileDown, FileUp, LogOut, X } from 'lucide-react'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { AgentShortcutConfig } from '@fizz/agent-kit/shared/lib/shortcuts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { DataTransferDialog, type TransferMode } from '@fizz/agent-kit/features/transfer/DataTransferDialog'
import { useAndroidBackHandler } from '@/app/android-back'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useIsWide, WIDE_QUERY } from '@/app/use-is-wide'
import {
  SettingsShell,
  type SettingsShellDetail
} from '@fizz/agent-kit/features/settings/SettingsShell'
import type { SettingsExtraGroup } from '@fizz/agent-kit/features/settings/types'
import { getAgentHost } from '@fizz/agent-client/host'

/** 与 GeneralTab 等内置 Tab 同款的「胶囊选择钮」样式（选中态 border-primary/60 bg-secondary） */
const CHIP_BASE =
  'rounded-md border px-3 py-1.5 text-xs transition-colors'
const CHIP_IDLE = 'border-border/60 text-muted-foreground hover:text-foreground'

/**
 * 横移用的时长 / 缓动。**时长必须与 `SLIDE_MS` 一致** —— 后者是退场兜底定时器的值，
 * 两者漂开就是「动画还没播完就被卸载」或「播完了还空等一截」。
 */
const SLIDE_EASE = 'duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]'

/**
 * 一个横移动画帧（0 = 右侧屏外，1 = 归位）。
 *
 * 两个类都**显式**写 `transition-transform` + 时长缓动：Tailwind 的 `duration-*` /
 * `ease-*` 只是给 `--default-transition-*` 赋值，没有过渡属性来消费它们就是一对死类名
 * （首帧没有 `transition-transform` 时那一拍就不动）。不依赖调用方记得带上。
 */
function slideFrame(on: boolean): string {
  return cn(on ? 'translate-x-0' : 'translate-x-full', `transition-transform ${SLIDE_EASE}`)
}

/** 与 `SLIDE_EASE` 里的 `duration-250` 同一个数：`transitionend` 听不到时的兜底，留一点余量 */
const SLIDE_MS = 250

/**
 * 进场的「第二帧」开关：先按屏外渲染一帧，下一帧再翻成归位，过渡才会真的播
 * （首帧就写终态 = 浏览器直接画完，看不到动画）。宽屏不做动画，恒为 true。
 *
 * ⚠️ 只在**挂载时**判断一次：`animate` 是宽度派生的，用户中途把窗口拖宽时不该
 * 突然给一个已经在场的页面补播进场（更不该把它滑出屏幕 —— 置位是单向的）。
 */
function useEntered(): boolean {
  // 惰性初值：不播动画时首帧直接归位，省掉一次多余渲染
  const [entered, setEntered] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    if (entered) return
    // 放在 effect 里而不是渲染期改 state：本帧先真的以屏外那一帧上屏，下一帧（effect 之后）
    // 才翻成归位 —— 渲染期改会让两帧被合并成一次绘制，动画整段消失。
    setEntered(true)
  }, [entered])
  return entered
}

/**
 * 退场：`close()` 先把画面滑回右侧，`onSlideEnd`（容器自己的 `transitionend`，
 * 与兜底定时器谁先来算谁）之后才调 `onDone`（真正的卸载）。宽屏直接同步 `onDone`。
 */
function useSlideOut(
  animate: boolean,
  onDone: () => void
): {
  leaving: boolean
  close: () => void
  onSlideEnd: (e: TransitionEvent<HTMLDivElement>) => void
} {
  const [leaving, setLeaving] = useState(false)
  const closing = useRef(false)
  const done = useRef(onDone)
  done.current = onDone

  const finish = useCallback((): void => {
    if (!closing.current) return
    closing.current = false
    done.current()
  }, [])

  const close = useCallback((): void => {
    if (!animate) {
      closing.current = true
      finish()
      return
    }
    if (closing.current) return
    closing.current = true
    setLeaving(true)
    // ⚠️ 兜底定时器不能省：动画被跳过（过渡被打断 / 元素不可见）时 `transitionend` 不会来，
    // 只靠它监听就会永远不卸载 —— 页面停在屏外，却还盖着整屏。
    window.setTimeout(finish, SLIDE_MS + 80)
  }, [animate, finish])

  /** 只认容器自己那条横移结束（里面的 `slide-swap` 等子元素也会冒泡上来，不算） */
  const onSlideEnd = useCallback(
    (e: TransitionEvent<HTMLDivElement>): void => {
      if (e.target !== e.currentTarget || e.propertyName !== 'translate') return
      finish()
    },
    [finish]
  )

  return { leaving, close, onSlideEnd }
}

/**
 * 设置页的进出场类名。不做动画（宽屏调试）时 `entered` 恒为 true、`leaving` 永远到不了
 * true（`useSlideOut` 那时直接调 `onClose`），于是恒为归位态 —— 与改动前逐像素相同。
 *
 * 底色是 `bg-surface-1`（**不是** `bg-background`）：这一层要跟 `SettingsShell`
 * 的二级页逐像素同色 —— 菜单左移那 20% 空出来的一条由这里补，二级页自己也铺同一档
 * 实底（见那个文件头「二级页必须自带实底」）。用 `bg-background` 的话，一旦配了背景
 * 图 / 视频，面板那块会比它周围的页面更实，切二级页时能看出一个色块边界。
 * 没有背景媒体时两者完全相同，等于改动前。
 */
function wrapperClass(entered: boolean, leaving: boolean): string {
  return cn(
    'fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface-1 text-foreground',
    slideFrame(entered && !leaving)
  )
}

export function SettingsPage({
  app,
  shortcuts,
  onSaveShortcuts,
  onShortcutRecordingChange,
  initialTab,
  onClose
}: {
  app: AgentApp
  /** 快捷键配置：宿主持有与分发，这里只读写（与弹窗那份逐字相同） */
  shortcuts: AgentShortcutConfig[]
  onSaveShortcuts: (shortcuts: AgentShortcutConfig[]) => void
  onShortcutRecordingChange: (recording: boolean) => void
  /** 打开时落在哪个分组（模型选择下拉的设置入口用）；不给 = 通用 */
  initialTab?: 'models' | 'acp'
  onClose: () => void
}) {
  /** 导入 / 导出对话框的模式（null = 关闭） */
  const [transfer, setTransfer] = useState<TransferMode>(null)
  /** 二级菜单的标题 / 返回动作：由 SettingsShell 上报，标题栏因此能跟着一起变 */
  const [mobileDetail, setMobileDetail] = useState<SettingsShellDetail | null>(null)
  /** 「退出」是「连接型宿主」（web / 手机）才有的概念（宿主能力叫 `canDisconnect`）：desktop 内置后端恒在 */
  const canDisconnect = getAgentHost().canDisconnect
  /**
   * 横滑转场只在**手机宽度**下做（见 `use-is-wide.ts`）：平板横屏 / 桌面浏览器调试时
   * 屏幕够宽，整页滑一遍只是拖慢操作，退回原来的直接显示 / 隐藏。
   */
  const animate = !useIsWide()
  const entered = useEntered()
  const { leaving, close, onSlideEnd } = useSlideOut(animate, onClose)

  /**
   * 安卓返回：先退二级页（与标题栏那颗 ← 同义），再关设置页。
   *
   * 走 `android-back.ts` 的处理器栈而不是自己 `addListener`：原生监听是**广播**，
   * 两个监听器会同时收到 —— 自己再挂一个的话，退设置页的同一拍外壳也可能把 App
   * 挪到后台。那边按「后注册的先问」把这条排在侧栏（外壳注册的）之上，正好是
   * 想要的层级。web 调试时那边不装原生监听，注册在这里也只是空转。
   */
  useAndroidBackHandler(() => {
    /*
     * ⚠️ `back()` 返回的是 `void`（它只是 `setMenuOpen(true)`）：**不能**写成
     * `if (mobileDetail?.back())` —— 返回值恒为 undefined，条件永远不成立，于是二级页
     * 按返回会直接 `close()` 关掉整个设置页。先判对象，再执行。
     */
    if (mobileDetail) {
      mobileDetail.back()
      return true
    }
    // 关整页走 `close()`（先播退场、动画完才真卸载），不是直接 `onClose`
    close()
    return true
  })

  /** 退出：先收掉设置页，再走宿主的断开（ConnectGate 会接管登录） */
  const handleExit = (): void => {
    close()
    app.disconnect()
  }

  /**
   * 宿主扩展入口：追加在内置分组之后（导航列表底端）—— 只有手机壳有这一层。
   * 设置项（数据）进二级页、与内置项同一款式；一次性动作（退出）就是列表最后
   * 单独一行，点一下直接执行。
   *
   * ⚠️ 「外观」**不在这里**了：配色主题 / 明暗 / 强调色已经升格成内置分组
   * （`sections.ts` 里的 `appearance`，三端同一份），再留一份会变成两个「外观」。
   */
  const tr = useT()
  const extraGroups: SettingsExtraGroup[] = [
    {
      title: tr('数据'),
      items: [
        {
          id: 'data',
          label: tr('数据'),
          icon: Database,
          content: (
            <div className="space-y-6">
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <FileUp className="size-3.5" />
                  {tr('导入 / 导出')}
                </div>
                <p className="text-xs leading-4 text-muted-foreground">
                  {tr('把三类数据（接口请求 / 主机 / 脚本）打包导出成文件带走，或在别的设备上导回。导入会按名称合并同名项，不会先清空现有数据。')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTransfer('export')}
                    className={cn(CHIP_BASE, CHIP_IDLE)}
                  >
                    {tr('导出数据')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTransfer('import')}
                    className={cn(CHIP_BASE, CHIP_IDLE)}
                  >
                    {tr('导入数据')}
                  </button>
                </div>
              </section>
            </div>
          )
        }
      ]
    },
    // 「退出」是一个动作、不是一组设置：不画分组标题，导航列表底部就是一行「退出」，
    // 点一下直接退出（不进二级页 —— 那个页面里本来也只有一个按钮）
    ...(canDisconnect
      ? [
          {
            items: [
              {
                id: 'exit',
                label: tr('退出'),
                icon: LogOut,
                tone: 'destructive',
                action: handleExit
              }
            ]
          } satisfies SettingsExtraGroup
        ]
      : [])
  ]

  return (
    /*
      `fixed inset-0`：盖住整块外壳（含顶栏与底部状态栏），这才是「一个页面」而不是
      「工作区里换了块内容」。外壳的 `--safe-area-inset-*` 内边距在**父容器**上，
      fixed 层跳出那个盒子，所以这里要自己再让一次，否则标题栏会顶到状态栏底下
      （底部安全区由根节点的 `padding-bottom` 让出，见下面的 style）。

      **不要**再标 `data-fizz-opaque`：那个属性会把整页换成不透明的主题底色
      （亮色主题下就是一块纯白），配了背景图 / 视频时跟别的页面完全割裂
      （用户报过「设置页背景依旧是白色」）。不过底色也从 `bg-background` 换成了
      **`bg-surface-1`**（见 `wrapperClass`）：它跟画布同源、只实一档（0.72 → 0.86，
      图仍然透得出来），但手机版这块页面**内部要有两层叠着滑** —— 二级页盖在菜单上、
      菜单左移还会空出 20% 的边 —— 一层画布遮罩兜不住，二级页的字底会透出下层的字
      （用户报「二级菜单背景是纯透明的」，就是那两块都没铺底）。

      `wrapperClass` 负责进出场（屏外 → 归位 / 归位 → 屏外，见文件头）；注意它是
      `fixed` + `translate-x`，**不改宽度**，所以里面那几层 flex 的比例不受影响。
    */
    <div
      className={wrapperClass(entered, leaving)}
      onTransitionEnd={onSlideEnd}
      style={{
        paddingTop: 'var(--safe-area-inset-top, 0px)',
        paddingBottom: 'var(--safe-area-inset-bottom, 0px)'
      }}
    >
      {/*
        标题栏：标题在左，二级页给一个返回键；关闭在右上角（没有底部导航了）。
        标题与返回键**一起**滑（`slide-swap`）：标题是整条换的（「设置」↔「模型」），
        淡出淡入比横向飞字干净；返回键则跟着二级页一起从右边顶进来 —— 不再「凭空出现」，
        免得标题栏在切层级那一拍跳一下。
      */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {mobileDetail && (
            <button
              type="button"
              aria-label={tr('返回设置')}
              title={tr('返回设置')}
              onClick={mobileDetail.back}
              className="-ml-1 slide-swap rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}
          <h1 key={mobileDetail?.title ?? tr('设置')} className="slide-swap truncate text-base font-medium">
            {mobileDetail?.title ?? tr('设置')}
          </h1>
        </div>
        <button
          type="button"
          aria-label={tr('关闭设置')}
          title={tr('关闭设置')}
          onClick={close}
          className="-mr-1 ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <X className="size-5" />
        </button>
      </header>

      {/*
        面板自己带滚动容器（每个分组一个，见 MobileSettingsPanel 的 `key={tab}` —— 由
        `SettingsShell` 转交），
        这里只把剩余高度交给它；横向留白与标题栏对齐。数据 / 退出
        经 `extraGroups` 注入 —— 与内置分组同一套两级导航，不再是旁边的自绘区块。
      */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-3">
        <SettingsShell
          platform="mobile"
          // 手机壳恒两级；宽屏（平板横屏 / 桌面调试）不播转场，退回并排两栏
          form="two-level"
          app={app}
          shortcuts={shortcuts}
          onSaveShortcuts={onSaveShortcuts}
          onShortcutRecordingChange={onShortcutRecordingChange}
          extraGroups={extraGroups}
          className="flex-1"
          initialTab={initialTab}
          animate={animate}
          onDetailChange={setMobileDetail}
        />
      </div>

      {/*
        导入 / 导出对话框。modal，放在页面层（z-50 同级、DOM 在后 = 盖在设置页上）。
      */}
      <DataTransferDialog app={app} mode={transfer} onClose={() => setTransfer(null)} />
    </div>
  )
}
