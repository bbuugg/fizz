/**
 * 窗口级顶栏里的「搜索」框 —— **web 顶栏（`WebTitleBar`）与 desktop 自绘标题栏共用这一颗**。
 *
 * ## 为什么是「假输入框」
 *
 * 它不是 `<input>`：真正的输入、过滤、翻页全在 `CommandPalette` 里。这里只需要一个
 * **看得见、点得到**的入口 —— 真做输入框就得处理「点了要先聚焦、面板弹出后焦点归谁」，
 * 而面板自己已有自己的输入框，两个焦点源只会打架。所以它是一个 `<button>`，外观照着
 * 输入框做，点一下直接把面板整块弹出来（用户敲的字进面板里那份输入框）。
 *
 * ## 为什么从状态栏搬过来
 *
 * 原来唯一的常驻鼠标入口是底部状态栏最右那颗 ⌘ 图标（`CommandPaletteButton`，已删除）。
 * 图标按钮的问题是**看不出它是搜索**：它和旁边的日志 / 文件管理 / 系统监控排成一排，
 * 纯鼠标用户只能挨个悬停看 tooltip。顶栏是窗口身份的落点，一条横贯的搜索框在那儿
 * 既符合「找东西去顶部」的普遍预期，也不用猜。
 *
 * ## 两个宿主怎么共用
 *
 * 与 `MobileSidebarToggle` 同一套路：desktop 那棵 React 树自己渲染一份，靠
 * **模块级单例** `requestCommandPalette()` 打通 —— 外壳在渲染期把 `openPalette` 登记进去
 * （见 `command-palette.ts`），这里只管调，不接任何 prop，也不碰 `paletteOpen` 的 state。
 *
 * ## 窄屏隐藏
 *
 * `hidden md:flex` 由使用方传：`<768px` 是手机形态，那边顶栏（`MobileAppBar`）已有
 * 自己的搜索入口，窗口级顶栏里的这一条挤不下也没必要重复。
 */
import { Search } from 'lucide-react'
import { requestCommandPalette } from '@fizz/agent-kit/shared/lib/command-palette'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 渲染端没有 process.platform：从 UA 判（与 desktop 标题栏同一套判法） */
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

/**
 * 快捷键提示用**默认**加速键（`shortcuts.ts` 的 `CommandOrControl+Shift+P`）。
 *
 * 不读用户改过的配置：这里只是个「有快捷键」的提示，读 `useShortcuts()` 会把整条
 * 顶栏挂进快捷键状态的订阅里，为一个角标不值得。用户改成了别的键也不会被这块误导 ——
 * 键盘照旧生效，只是提示显示的是出厂值（设置页里能看到真实值）。
 */
const SHORTCUT_HINT = IS_MAC ? '⌘⇧P' : 'Ctrl+Shift+P'

export function TitleBarSearch({ className }: { className?: string }) {
  const t = useT()

  return (
    <button
      type="button"
      aria-label={t('搜索')}
      title={t('搜索')}
      onClick={() => requestCommandPalette()}
      className={cn(
        // 外观即输入框：`--secondary` 在深色 / 亮色两套主题下都比 `--sidebar` 更"凹/凸"，
        // 用它半透明叠一层就有输入框的观感（`--background` 在部分主题里与侧栏同色，会看不见）
        // 窄屏 `w-7`（28px）时去掉左右内边距，否则图标 + padding 撑出边框
        'flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary/50 text-xs text-muted-foreground transition-colors',
        // 窄屏 `w-7`（28px）时不留左右内边距，否则图标 + padding 会撑出边框
        'px-0 md:px-2',
        'hover:border-ring/60 hover:bg-secondary hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        // 宽屏左对齐（图标 + 文字 + 快捷键），窄屏只剩图标时居中
        'md:justify-start',
        className
      )}
    >
      <Search className="size-3.5 shrink-0" />
      {/* 窄屏只留图标：文字与快捷键提示藏起来（外层宽度也由使用方收到 `w-7`），
          入口本身不消失 —— 否则窗口一拉窄就只剩快捷键，纯鼠标用户又没有入口了 */}
      <span className="hidden truncate md:inline">{t('搜索')}</span>
      <kbd className="ml-auto hidden shrink-0 rounded border border-border px-1 text-xs text-muted-foreground md:inline">
        {SHORTCUT_HINT}
      </kbd>
    </button>
  )
}
