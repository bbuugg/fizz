/**
 * 外观：**明暗** + **配色主题**（内置 + 自定义，三端同一份）。
 *
 * - 配色主题：`<html data-theme="…">` 换整套中性面（背景 / 卡片 / 侧栏 / 边框 / 文字 / 圆角）。
 *   内置那几套的色值在 `@fizz/ui-tokens` 的 `themes.css`；**自定义**那几套存在 localStorage，
 *   由 `useColorTheme` 生成 `<style>` 注入（`[data-theme="custom-x"]`）。预览小卡**就地**带
 *   `data-theme` 渲染 —— 显示的就是真的那套变量，不是另抄一份色块（抄一份必然会跟 CSS 漂）。
 * - 自定义主题：新建 = 以当前主题为种子，然后逐项改色（`ThemeEditor`）。CRUD 全在这个 Tab。
 * - 背景（图片 / 视频）**属于主题**，本 Tab 不再有独立入口：自定义主题在编辑器「背景」
 *   页签里改，内置主题点卡片右上角的「背景」（内置主题的改动整体存在 `overrides` 覆盖层）。
 *   图片 / 视频互斥，靠把 `--background` 换成半透明来透出 —— 不这么做的话应用根节点那层
 *   `bg-background` 会把它们盖得死死的。图片是压过的 data URL、画在 `body::before`；
 *   视频放不进 `background-image`，由 `useColorTheme` 往 body 里塞 `#fizz-bg-video`，
 *   本体存在 IndexedDB（见 `shared/lib/background-video.ts`）。素材与窗口比例对不上时，
 *   `background.fit` 决定**铺满（裁）/ 完整显示（留边）**，两层共读同一个 `--fizz-bg-fit`。
 *   派生主题会连背景一起继承（视频只复制引用）。
 * - 明暗：与左下角菜单 / 手机设置页原来那三档同源（`useTheme`，跨窗口跟随）。**放在最上面**
 *   —— 它影响整个窗口的观感，不属于某一套配色。
 * - 强调色：属于主题（`themes.css` 每套一个招牌色，自定义主题在颜色页签里改），
 *   本 Tab 不再单独提供全局强调色 —— 否则「换主题色不变」会与「主题是一套完整预设」打架。
 *
 * 为什么集中到这个 Tab：原来这几件事分散在「左下角菜单 → 主题」和手机设置页的宿主扩展组里，
 * web / desktop 没有设置页入口、手机没有菜单 —— 同一个功能两套入口。现在三端都从
 * 设置 → 外观 进（手机那套扩展组已删）。
 */
import { useState, type ReactNode } from 'react'
import { Check, ImagePlus, Monitor, Moon, Palette, Pencil, Plus, Sun, Trash2 } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'
import {
  COLOR_THEMES,
  useColorTheme,
  type CustomColorTheme
} from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { ThemeEditor } from '@fizz/agent-kit/features/settings/ThemeEditor'
import { ThemeBackgroundEditor } from '@fizz/agent-kit/features/settings/ThemeBackgroundEditor'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import { ToggleGroup, ToggleGroupItem } from '@fizz/ui/toggle-group'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@fizz/ui/alert-dialog'

/** 明暗三档（「浅色 / 深色 / 跟随系统」），与菜单里那个子菜单同构 */
const THEME_MODES = [
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor }
] as const

/**
 * 主题预览卡（`ToggleGroupItem`）的样式：卡片是「块」不是按钮，要把 Toggle 默认的
 * 居中 / 定高 / 内边距全部压掉；选中态走 `data-[state=on]`，不再按值拼两套类名。
 */
const THEME_CARD_ITEM = [
  'relative block h-auto w-full min-w-0 overflow-hidden rounded-lg border-border/60 p-0 text-left font-normal whitespace-normal transition-all',
  'hover:border-border data-[state=off]:hover:bg-transparent',
  'data-[state=on]:border-primary data-[state=on]:bg-primary/5 data-[state=on]:hover:border-primary data-[state=on]:hover:bg-primary/5'
].join(' ')

/**
 * 卡片右上角的动作区（背景 / 微调 / 编辑 / 删除）。
 *
 * ⚠️ **`z-20` 不能省**：`ToggleGroupItem` 自带 `focus:z-10` / `focus-visible:z-10`
 * （shadcn 为分段控件准备的，让焦点环压住相邻段）。点选一张主题卡后它**带着焦点**，
 * 整张卡被抬到 `z-index: 10`，而这里只是 `z-auto` —— 动作区会被卡片自己的
 * **不透明预览图**盖住：`opacity` 明明已经过渡到 1，却既看不见也点不到。
 * 症状就是「选中某个主题后，hover 它自己的卡片，右上角的微调 / 背景不出现」，
 * 而没被选中的卡片一切正常（它们没有焦点，仍是 `z-auto`，与动作区同级、按 DOM 顺序后者在上）。
 *
 * `opacity-0` 时必须同时 `pointer-events-none`：否则触屏上会点中一块看不见的按钮。
 * `pointer-coarse` 让触屏（没有 hover）始终显示，`focus-within` 让键盘 Tab 进来也能看见。
 */
const THEME_CARD_ACTIONS = [
  'absolute right-1 top-1 z-20 flex gap-1 opacity-0 pointer-events-none transition-opacity',
  'focus-within:pointer-events-auto focus-within:opacity-100',
  'group-hover:pointer-events-auto group-hover:opacity-100',
  'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100'
].join(' ')

/**
 * 选中卡片的整圈描边：画成卡片内部的覆盖层。
 *
 * 不能把 ring 挂在 `ToggleGroupItem` 上：`ring` 在元素外侧，父级的
 * `overflow-hidden` / 滚动容器会把左右边缘裁掉；`ring-inset` 又会被
 * `ThemePreview` 的不透明背景盖住，只剩名字那一行看得见。覆盖层在最后绘制，
 * 且 `inset-0` + 圆角与卡片一致，四周都能看见。
 */
function ActiveThemeOutline() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-lg border-2 border-primary/35"
    />
  )
}

/** 正在使用的主题徽标：只靠一圈边框在密集卡片里不够显眼 */
function ActiveThemeBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-medium text-primary-foreground">
      <Check className="size-2.5" />
      {t('使用中')}
    </span>
  )
}

export function AppearanceTab() {
  const tr = useT()
  const { mode, theme: resolved, setMode } = useTheme()
  const {
    theme,
    setTheme,
    custom,
    backgroundOf,
    setBackground,
    createCustom,
    updateCustom,
    deleteCustom
  } = useColorTheme()

  /** 正在编辑 / 正在确认删除的自定义主题（null = 关闭） */
  const [editing, setEditing] = useState<CustomColorTheme | null>(null)
  const [deleting, setDeleting] = useState<CustomColorTheme | null>(null)
  /** 正在设背景的内置主题（null = 关闭） */
  const [backdrop, setBackdrop] = useState<{ id: string; label: string } | null>(null)
  /** 派生失败（配额满）时给条提示 —— 继承背景后整套主题更大，更容易写不进去 */
  const [createError, setCreateError] = useState<string | null>(null)

  /** 新建：以当前主题为种子（内置主题的色值从 CSS 读，不在 TS 里再抄一份） */
  const handleCreate = (): void => {
    const created = createCustom()
    if (created) {
      setCreateError(null)
      setEditing(created)
    } else {
      setCreateError(tr('存不下：本地存储已满，试试删掉几套自定义主题或换张小一点的背景图。'))
    }
  }

  /**
   * 以**任意内置主题**为种子新建一套自定义主题（卡片右上角的「微调」）。
   *
   * 不先 `setTheme(seedId)`：那会当场换掉整个界面，用户只是想「以它为基础改几项」。
   */
  const handleDerive = (seedId: string): void => {
    const created = createCustom(seedId)
    if (created) {
      setCreateError(null)
      setEditing(created)
    } else {
      setCreateError(tr('存不下：本地存储已满，试试删掉几套自定义主题或换张小一点的背景图。'))
    }
  }

  return (
    <div className="space-y-6">
      {/* 明暗放最上面：它影响整个窗口的观感，不属于某一套配色 */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sun className="size-3.5" />
          {tr('明暗')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('跟随系统时会自动切换明暗；每套配色都包含亮暗两份。')}
        </p>
        <Segmented
          ariaLabel={tr('明暗')}
          value={mode}
          onChange={setMode}
          options={THEME_MODES.map(({ mode: value, label, icon: Icon }) => ({
            value,
            label: (
              <>
                <Icon className="size-3.5" />
                {tr(label)}
              </>
            )
          }))}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Palette className="size-3.5" />
          {tr('配色主题')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('同时更换配色、字体、圆角与背景；明暗独立。可在卡片右上角「微调」或「背景」。')}
        </p>
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(next) => {
            // 再点一次选中的那项时 Radix 会回调空串：主题必须始终有一套，忽略即可
            if (next) setTheme(next)
          }}
          aria-label={tr('配色主题')}
          className="grid w-full gap-2 sm:grid-cols-2"
        >
          {COLOR_THEMES.map((option) => {
            const active = theme === option.id
            return (
              <div key={option.id} className="group relative">
                <ToggleGroupItem value={option.id} className={THEME_CARD_ITEM}>
                  {active && <ActiveThemeOutline />}
                  <ThemePreview id={option.id} dark={resolved === 'dark'} />
                  <div className="flex items-center gap-1.5 px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {tr(option.label)}
                    </span>
                    {active ? (
                      <ActiveThemeBadge />
                    ) : (
                      <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                        {tr(option.hint)}
                      </span>
                    )}
                  </div>
                </ToggleGroupItem>
                {/* 动作区必须压在卡片之上，见 THEME_CARD_ACTIONS 的说明 */}
                <div className={THEME_CARD_ACTIONS}>
                  <MiniButton
                    label={tr('背景')}
                    onClick={() => setBackdrop({ id: option.id, label: option.label })}
                  >
                    <ImagePlus className="size-3" />
                  </MiniButton>
                  <MiniButton label={tr('微调')} onClick={() => handleDerive(option.id)}>
                    <Pencil className="size-3" />
                  </MiniButton>
                </div>
              </div>
            )
          })}

          {custom.map((item) => {
            const active = theme === item.id
            return (
              <div key={item.id} className="group relative">
                <ToggleGroupItem value={item.id} className={THEME_CARD_ITEM}>
                  {active && <ActiveThemeOutline />}
                  <ThemePreview id={item.id} dark={resolved === 'dark'} />
                  <div className="flex items-center gap-1.5 px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {item.name}
                    </span>
                    {active ? (
                      <ActiveThemeBadge />
                    ) : (
                      <span className="shrink-0 text-[0.625rem] text-muted-foreground">{tr('自定义')}</span>
                    )}
                  </div>
                </ToggleGroupItem>
                {/* 自定义主题卡同样要压在卡片之上，见 THEME_CARD_ACTIONS 的说明 */}
                <div className={THEME_CARD_ACTIONS}>
                  <MiniButton label={tr('编辑')} onClick={() => setEditing(item)}>
                    <Pencil className="size-3" />
                  </MiniButton>
                  <MiniButton label={tr('删除')} onClick={() => setDeleting(item)}>
                    <Trash2 className="size-3" />
                  </MiniButton>
                </div>
              </div>
            )
          })}

          <button
            type="button"
            onClick={handleCreate}
            className="flex min-h-[6.25rem] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <Plus className="size-4" />
            {tr('新建自定义主题')}
          </button>
        </ToggleGroup>
        {createError && <p className="text-xs text-destructive">{createError}</p>}
      </section>

      {/*
        内置主题的「背景」弹窗：只改背景，不碰配色 —— 想改配色点「微调」派生一套。
        改动写进 `overrides[id]`，清空后整条覆盖会被删掉（= 恢复出厂）。
      */}
      {backdrop && (
        <Dialog open onOpenChange={(open) => !open && setBackdrop(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{tr('「{name}」的背景', { name: tr(backdrop.label) })}</DialogTitle>
              <DialogDescription>
                {tr('背景属于这套主题：换到别的主题就看不到它，切回来还在。图片与视频都只存在本机。')}
              </DialogDescription>
            </DialogHeader>
            <ThemeBackgroundEditor
              background={backgroundOf(backdrop.id)}
              onChange={(patch) => setBackground(backdrop.id, patch)}
              themeLabel={backdrop.label}
            />
            <DialogFooter>
              <Button size="sm" onClick={() => setBackdrop(null)}>
                {tr('完成')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editing && (
        <ThemeEditor
          theme={editing}
          background={backgroundOf(editing.id)}
          onClose={() => setEditing(null)}
          onSave={(patch) => updateCustom(editing.id, patch)}
          onBackgroundChange={(patch) => setBackground(editing.id, patch)}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('删除「{name}」？', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr('这套自定义配色和它自己的背景（图片 / 视频）会从本机移除，不可撤销。内置主题不受影响。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) deleteCustom(deleting.id)
                setDeleting(null)
              }}
            >
              {tr('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 预览卡右上角那两颗小按钮（悬停才出现，避免和「选中主题」的主点击抢注意力） */
function MiniButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-xs backdrop-blur transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}

/**
 * 主题预览小卡：一个缩小的窗口（侧栏 + 内容区）。
 *
 * ⚠️ 它靠**自带 `data-theme`** 拿到那套变量 —— 卡片自己声明的值压过从 `<html>` 继承来的值，
 * 所以不管当前选的是哪套，每张卡都显示自己那套真配色。深色模式下再补一个 `.dark` 类，
 * 命中 `themes.css` 里的 `.dark[data-theme='…']`。**不要**在这里写死颜色：那等于把
 * `themes.css` 的色值抄了第二份，迟早跟 CSS 对不上。
 */
function ThemePreview({ id, dark }: { id: string; dark: boolean }) {
  return (
    <div
      data-theme={id}
      className={cn('flex h-16 border-b border-border/60', dark && 'dark')}
      aria-hidden
    >
      <div className="flex w-10 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-1.5">
        <span className="h-1.5 w-full rounded-full bg-sidebar-accent" />
        <span className="h-1.5 w-2/3 rounded-full bg-sidebar-accent" />
      </div>
      <div
        className="flex flex-1 flex-col justify-center gap-1 bg-background px-2"
        style={{
          backgroundImage: 'var(--fizz-theme-texture, none)',
          backgroundSize: 'var(--fizz-texture-size, auto)'
        }}
      >
        <span className="h-1.5 w-3/4 rounded-full bg-muted-foreground/40" />
        <span className="h-1.5 w-1/2 rounded-full bg-muted-foreground/25" />
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="h-2.5 w-8 rounded-sm bg-primary" />
          <span className="font-heading text-[10px] leading-none text-foreground">Aa</span>
          <span
            className="font-mono text-[9px] leading-none"
            style={{ color: 'var(--syntax-keyword)' }}
          >
            {'{}'}
          </span>
        </div>
      </div>
    </div>
  )
}
