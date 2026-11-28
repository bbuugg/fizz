/**
 * 配色主题（换肤）+ **自定义主题** + 主题自带的背景（图片 / 视频）。
 *
 * ## 结构与归属
 *
 * 1. **内置主题**：色值在 `@fizz/ui-tokens` 的 `themes.css`（`[data-theme='ocean']`），
 *    这里只登记 id / 名字（`COLOR_THEMES`）。用户给内置主题改的东西（**包括背景**）
 *    存在 `overrides[id]` 覆盖层里 —— 删键即恢复出厂，不复制整份变量表。
 * 2. **自定义主题**：用户在设置里逐项改色 / 换背景，存 localStorage。它们不可能预先写进
 *    CSS，所以由 `buildStyle()` 生成一段 `<style>` 注入 `<head>`，选择器形状与内置的一致
 *    （`[data-theme="custom-x"]` / `.dark[data-theme="custom-x"]`）——预览小卡自带
 *    `data-theme` 就能渲染真配色，明暗切换也交给 CSS，不用 JS 参与。
 * 3. **背景（图片 / 视频）是主题的一部分**，不再是与主题并列的一张表：自定义主题存在
 *    `custom[].background`，内置主题存在 `overrides[id].background`，读入口统一是
 *    `backgroundOf(store, id)`。图片把 `--fizz-bg-image` 挂在 `<html>` 上，由 `themes.css`
 *    的 `body::before` 画；视频没法用 `background-image`，由 `applyBackgroundVideo()`
 *    往 `<body>` 里塞一个 `#fizz-bg-video`（样式同样在 `themes.css`）。两者都靠把
 *    `--background` / `--sidebar` 换成半透明同色（遮罩）来透出。
 *
 *    ⚠️ 图片与视频**互斥**（同一套主题只留一个）：`setBackground()` 会把另一个清掉。
 *    存储也分两处 —— 图片是压过的 data URL（进 localStorage），视频本体进 IndexedDB
 *    （`shared/lib/background-video.ts`），localStorage 里只留引用。派生主题**只复制引用**，
 *    所以同一个 key 可能被多套主题共用：删 blob 前必须过 `videoStillUsed()`。
 *
 *    ⚠️ **首帧门禁**：媒体要等应用挂载（`#root` 有第一个子节点）才画，见
 *    `backgroundRevealed` —— 图片是同步的 data URL，不挡的话它会先于界面闪满一整窗。
 *
 * ## 老数据
 *
 * 更早的版本把背景存在与 `custom` 并列的 `backgrounds` 表里。`normalizeStore` 读到就当场
 * 迁移：自定义主题搬进 `custom[].background`，内置主题搬进 `overrides[id]`，读完那个键就丢。
 *
 * ## 为什么自定义主题的变量全是 `#rrggbb`
 *
 * 内置主题用 `oklch()`，但编辑器要 `<input type="color">` / ColorPicker（只认 hex），
 * 所以**读出来就换算成 hex 再存**：`toHex()` 用 canvas 让浏览器自己做色彩管理（比手写
 * oklch→sRGB 靠谱，也不用维护第二套色值表）。半透明色（暗色 `oklch(1 0 0 / 10%)` 的边框）
 * 按「叠在哪个底色上」合成成不透明 hex —— 有背景图时，不透明描边本来也更清楚。
 *
 * ## 持久化
 *
 * `fizz.web.colorThemes`（见 AGENTS.md 的 `fizz.web.*` 约定）；旧的 `fizz.web.colorTheme`
 * （只存一个 id 的字符串）读取时自动迁移。跨窗口：`storage` + 同窗口 `CustomEvent`。
 *
 * ⚠️ 老版本写进 localStorage 的 `backgrounds` 表**不再写回**：下一次 `commit()` 落盘的就是
 * 迁移后的新形状（`custom[].background` + `overrides`）。
 */
import { useEffect, useState } from 'react'
import { useTheme } from '@fizz/agent-kit/shared/hooks/useTheme'
import {
  deleteBackgroundVideo,
  getBackgroundVideo,
  putBackgroundVideo,
  type BackgroundVideoRef
} from '@fizz/agent-kit/shared/lib/background-video'

const STORE_KEY = 'fizz.web.colorThemes'
const STYLE_ID = 'fizz-color-themes'
const CHANGED_EVENT = 'fizz:color-theme-changed'

export interface ColorThemeOption {
  /** 写到 `<html data-theme>` 上的值，必须与 `themes.css` 里的选择器同名 */
  id: string
  label: string
  /** 一句话说明（卡片标题下面那行小字） */
  hint: string
}

/**
 * 内置主题清单 —— `themes.css` 里加了一套新配色，不在这里补一行的话设置里选不到它
 * （反过来只有这一行、没有 CSS，选中后什么都不变）。
 */
export const COLOR_THEMES: ColorThemeOption[] = [
  { id: 'default', label: '默认', hint: '中性灰 · 标准密度' },
  { id: 'ocean', label: '海雾', hint: '冷蓝灰 · 紧凑' },
  { id: 'forest', label: '森野', hint: '微绿 · 衬线标题' },
  { id: 'sand', label: '暖砂', hint: '米黄 · 纸纹 · 宽松' },
  { id: 'plum', label: '暮紫', hint: '紫灰 · 悬浮 · 星点' },
  { id: 'terminal', label: '终端', hint: '方角 · 等宽 · 扫描线' },
  { id: 'contrast', label: '高对比', hint: '纯黑白 · 无阴影' }
]

/** 没存过 / 存坏了（手改 localStorage、旧版本残留）时落回默认主题 */
export const DEFAULT_COLOR_THEME = 'default'

export type ThemeVarKind = 'color' | 'font' | 'number'

/** 编辑器页签：变量组按它分组渲染；`background` 不走变量表（见 `ThemeBackground`） */
export type ThemeEditorTab = 'color' | 'font' | 'scale' | 'texture' | 'code' | 'background'

export interface ThemeVarSpec {
  name: string
  label: string
  /** 默认 'color'；决定编辑器控件与写入前的校验 */
  kind?: ThemeVarKind
  /**
   * 半透明色要合成到哪个变量上（读主题做种子时用）。不写 = 直接取原值。
   * 值必须是**本组或前面组**已经算出来的变量名。
   */
  over?: string
  /**
   * 这一项允许半透明：编辑器给出 alpha 滑块，存 `#rrggbbaa`。
   *
   * ⚠️ 只能给**不走 `hsl(var(--x))` 通道**的变量（`--sidebar` / `--background` 这类直接
   * 当颜色用的）。基础色（`--foreground` / `--card` …）被 `hsl(var(--x))` 消费，8 位 hex
   * 会让整条 `color` 声明失效，所以在那里强行开 alpha 只会得到一个「坏掉的颜色」。
   */
  alpha?: boolean
  /** kind === 'number' 的取值范围（必填，越界会 clamp） */
  min?: number
  max?: number
  step?: number
  /** 仅用于界面展示（'×' / 'rem'） */
  unit?: string
}

export interface ThemeVarGroup {
  id: string
  label: string
  tab: ThemeEditorTab
  vars: ThemeVarSpec[]
}

/**
 * 可自定义的变量 —— 顺序即合成顺序（`over` 只能引用前面算过的）。
 *
 * 强调色（`--primary`）是**主题的一部分**：每套主题在 `themes.css` 里声明自己的招牌色，
 * `--primary-soft/subtle/line/strong` 四个派生值由它现算，所以这里只暴露 `--primary`
 * 与压在它上面的文字色 —— 五个派生入口会让「改哪个才生效」变成哑谜。
 * 不含 `--destructive` / `--chart-*`：语义色跟着主题漂没有意义。
 */
export const THEME_VAR_GROUPS: ThemeVarGroup[] = [
  {
    id: 'base',
    label: '基础',
    tab: 'color',
    vars: [
      // 背景与侧栏底：外壳 / 内容区直接 `bg-background` / `bg-sidebar`，可安全吃 8 位 hex
      // （`buildStyle()` 拼背景遮罩时还会把它们换成 `rgb()`，见 `veil()`），所以这两项配
      // alpha 滑块是真正生效的地方 —— 想做「玻璃感」/「露出壁纸」就是调这两个。
      { name: '--background', label: '背景', alpha: true },
      { name: '--foreground', label: '正文' }
    ]
  },
  {
    id: 'primary',
    label: '强调色',
    tab: 'color',
    vars: [
      // 按钮 / 选中态 / 焦点环的主色。换它 = 换这套主题的性格色
      { name: '--primary', label: '强调色' },
      // 压在强调色上的文字：深底强调色选白字，荧光色（终端绿 / 高对比黄）要选黑字
      { name: '--primary-foreground', label: '强调色文字' }
    ]
  },
  {
    id: 'surface',
    label: '卡片与弹层',
    tab: 'color',
    vars: [
      { name: '--card', label: '卡片底', over: '--background' },
      { name: '--card-foreground', label: '卡片文字' },
      { name: '--popover', label: '弹层底', over: '--background' },
      { name: '--popover-foreground', label: '弹层文字' }
    ]
  },
  {
    id: 'secondary',
    label: '次级与悬停',
    tab: 'color',
    vars: [
      { name: '--secondary', label: '次级底', over: '--background' },
      { name: '--secondary-foreground', label: '次级文字' },
      { name: '--muted', label: '弱化底', over: '--background' },
      { name: '--muted-foreground', label: '弱化文字' },
      { name: '--accent', label: '悬停底', over: '--background' },
      { name: '--accent-foreground', label: '悬停文字' }
    ]
  },
  {
    id: 'border',
    label: '边框',
    tab: 'color',
    vars: [
      { name: '--border', label: '边框', over: '--background' },
      { name: '--input', label: '输入框描边', over: '--background' }
    ]
  },
  {
    id: 'sidebar',
    label: '侧栏',
    tab: 'color',
    vars: [
      { name: '--sidebar', label: '侧栏底', over: '--background', alpha: true },
      { name: '--sidebar-foreground', label: '侧栏文字' },
      { name: '--sidebar-accent', label: '侧栏悬停', over: '--sidebar' },
      { name: '--sidebar-accent-foreground', label: '侧栏悬停文字' },
      { name: '--sidebar-border', label: '侧栏分隔', over: '--sidebar' }
    ]
  },
  {
    id: 'typography',
    label: '字体',
    tab: 'font',
    vars: [
      { name: '--fizz-font-sans', label: '正文字体', kind: 'font' },
      { name: '--fizz-font-heading', label: '标题字体', kind: 'font' },
      { name: '--fizz-font-mono', label: '等宽字体', kind: 'font' }
    ]
  },
  {
    id: 'scale',
    label: '字号与密度',
    tab: 'scale',
    vars: [
      { name: '--fizz-text-scale', label: '字号倍率', kind: 'number', min: 0.9, max: 1.1, step: 0.01, unit: '×' },
      { name: '--fizz-density', label: '界面密度', kind: 'number', min: 0.92, max: 1.08, step: 0.01, unit: '×' }
    ]
  },
  {
    id: 'texture',
    label: '质感',
    tab: 'texture',
    vars: [
      { name: '--fizz-shadow-alpha', label: '阴影强度', kind: 'number', min: 0, max: 1.6, step: 0.05, unit: '×' }
    ]
  },
  {
    id: 'code',
    label: '代码配色',
    tab: 'code',
    vars: [
      { name: '--syntax-keyword', label: '关键字' },
      { name: '--syntax-string', label: '字符串' },
      { name: '--syntax-number', label: '数字与常量' },
      { name: '--syntax-comment', label: '注释' },
      { name: '--syntax-function', label: '函数' },
      { name: '--syntax-type', label: '类型' },
      { name: '--syntax-variable', label: '变量' },
      { name: '--syntax-punctuation', label: '标点' }
    ]
  }
]

/** 拍平后的变量名（顺序与 `THEME_VAR_GROUPS` 一致，就是合成顺序） */
export const THEME_VAR_NAMES: string[] = THEME_VAR_GROUPS.flatMap((group) =>
  group.vars.map((spec) => spec.name)
)

/** 变量名 → 声明（校验 / 控件类型 / clamp 范围都从这里查） */
const VAR_SPECS = new Map<string, ThemeVarSpec>(
  THEME_VAR_GROUPS.flatMap((group) => group.vars.map((spec) => [spec.name, spec] as const))
)

// ---------------------------------------------------------------- 纹理

/** 主题背景纹理（纯 CSS 渐变，不依赖图片素材） */
export type ThemeTexture = 'none' | 'paper' | 'dots' | 'scanline'

export const THEME_TEXTURES: ReadonlyArray<{ value: ThemeTexture; label: string; hint: string }> = [
  { value: 'none', label: '纯色', hint: '最干净的底色' },
  { value: 'paper', label: '纸纹', hint: '细横纹，像打印纸' },
  { value: 'dots', label: '点阵', hint: '16px 网格上的小点' },
  { value: 'scanline', label: '扫描线', hint: '终端屏幕的横向条纹' }
]

/**
 * 纹理的实际 CSS 值。
 *
 * ⚠️ 内置主题（`themes.css`）里写的值必须与这里**逐字一致** —— 读回主题做种子时靠
 * 字符串匹配认纹理（`textureFromCss()` 已经做了颜色语法的容差）。
 */
export const TEXTURE_CSS: Record<ThemeTexture, string> = {
  none: 'none',
  paper: 'repeating-linear-gradient(0deg, rgb(128 96 48 / 0.05) 0 1px, transparent 1px 4px)',
  dots: 'radial-gradient(circle, rgb(128 128 128 / 0.10) 1px, transparent 1px)',
  scanline: 'repeating-linear-gradient(0deg, rgb(0 120 80 / 0.045) 0 1px, transparent 1px 3px)'
}

/** 纹理的平铺尺寸：点阵要网格，线性渐变用 auto（自己铺满整块） */
export const TEXTURE_SIZE: Record<ThemeTexture, string> = {
  none: 'auto',
  paper: 'auto',
  dots: '16px 16px',
  scanline: 'auto'
}

/** 纯纹理（没有用户背景图）时背景 / 侧栏底的遮罩强度：留一点底色让纹理透出来 */
const TEXTURE_MASK = 0.94

/**
 * 用户自己给 `--background` 带了 alpha（8 位 hex，做玻璃感）时，surface 面板再实几成。
 *
 * **加法**（`alpha + 0.14`，封顶 1），不是乘：乘会把「不透明底」算成 0.14，整块面板
 * 变成 86% 透明。与 `buildStyle()` 的 `surface()`、`decls()` 的 `surfaceOf()` 同源
 * （都是 `+ USER_SURFACE_MASK`），别在两处写不同的数。
 */
const USER_SURFACE_MASK = 0.14

function isThemeTexture(value: unknown): value is ThemeTexture {
  return typeof value === 'string' && value in TEXTURE_CSS
}

/**
 * 从 CSS 里的 `--fizz-theme-texture` 认出是哪一种纹理。
 *
 * 不能直接与 `TEXTURE_CSS` 比字符串：`getComputedStyle()` 会把颜色归一化
 * （`rgb(128 128 128 / 0.10)` → `rgba(128, 128, 128, 0.1)`，空格与小数位都变）。
 * 所以只看「形状 + 色相」：径向渐变只有点阵，线性里再用 RGB 通道区分纸纹与扫描线。
 */
function textureFromCss(value: string): ThemeTexture {
  const css = value.toLowerCase()
  if (!css || css === 'none') return 'none'
  if (css.includes('radial-gradient')) return 'dots'
  if (css.includes('0, 120, 80') || css.includes('0 120 80')) return 'scanline'
  if (css.includes('128, 96, 48') || css.includes('128 96 48')) return 'paper'
  return 'none'
}

/** 一套主题在某个明暗模式下的变量表（键是 `--background` 这种） */
export type ThemeVars = Record<string, string>

export type ThemeModeKey = 'light' | 'dark'

export interface CustomColorTheme {
  /** `custom-<base36 时间戳>`，同时是 `<html data-theme>` 的取值 */
  id: string
  name: string
  /** 圆角基数（rem） */
  radius: number
  /** 背景纹理；老数据缺失时归 'none' */
  texture: ThemeTexture
  vars: Record<ThemeModeKey, ThemeVars>
  /** 这套主题自己的背景（图片 / 视频）—— 派生时整份复制 */
  background: ThemeBackground
}

/**
 * 素材与窗口比例对不上时怎么摆 —— 直接对应 CSS 的 `object-fit` / `background-size`：
 *
 * - `cover`：铺满整个窗口，多出来的部分裁掉（默认，改动前唯一的做法）；
 * - `contain`：完整显示，露出来的部分留空（**留空处是纯色底，不是透明** —— 见 `themes.css`
 *   里 `#fizz-bg-video` 的 `background-color` 那段注释）。
 *
 * 竖屏手机拍的视频、带黑边的素材，`cover` 会裁掉大半，这时就该 `contain`。
 */
export type BackgroundFit = 'cover' | 'contain'

export const BACKGROUND_FITS: ReadonlyArray<{ value: BackgroundFit; label: string; hint: string }> = [
  { value: 'cover', label: '铺满', hint: '裁掉多出来的部分，不留边' },
  { value: 'contain', label: '完整显示', hint: '整幅都看得见，留出边' }
]

export interface ThemeBackground {
  /** 背景图：压过的 data URL；null = 没有。与 `video` 互斥 */
  image: string | null
  /**
   * 背景视频：**只有引用**，本体在 IndexedDB（`shared/lib/background-video.ts`）。
   * 与 `image` 互斥 —— 同时有值时以视频为准（见 `normalizeBackground`）。
   */
  video: BackgroundVideoRef | null
  /** 素材怎么摆（铺满 / 完整显示） */
  fit: BackgroundFit
  /** 遮罩强度 0..1：越高越看不清图（= 背景色的不透明度） */
  mask: number
  /** 模糊半径（px） */
  blur: number
}

export const DEFAULT_THEME_BACKGROUND: ThemeBackground = {
  image: null,
  video: null,
  fit: 'cover',
  mask: 0.72,
  blur: 0
}

/**
 * 内置主题的**覆盖层**：只存用户改过的东西，删掉这个键 = 恢复 `themes.css` 原值。
 *
 * - `vars` / `radius` / `texture` 缺失 = 还没编辑过变量（老数据只给主题换了背景时
 *   就是这种形状，注入层不会给它生成任何规则）
 * - `background` 一定有：即使只是选了张图，也得有个地方落脚
 */
export interface ThemeOverride {
  vars?: Record<ThemeModeKey, ThemeVars>
  radius?: number
  texture?: ThemeTexture
  background: ThemeBackground
}

/**
 * 删 / 替换某段视频前，看还有没有别的主题引用同一个 key。
 *
 * 派生主题会连背景一起继承，而视频**只复制引用**（本体几十 MB 仍在 IndexedDB）。
 * 同一个 key 被多套主题共用时，不查就删会把别套主题的背景一起弄坏 —— 界面上一块黑底，
 * 且不可恢复（blob 已经没了）。
 */
export function videoStillUsed(
  store: Pick<ColorThemeStore, 'custom' | 'overrides'>,
  key: string
): boolean {
  return (
    store.custom.some((theme) => theme.background.video?.key === key) ||
    Object.values(store.overrides).some((override) => override.background.video?.key === key)
  )
}

/** 视频体积上限：超过就劝退（IndexedDB 放得下，但每次启动都要读一遍，太大纯属拖累） */
export const MAX_BACKGROUND_VIDEO_BYTES = 128 * 1024 * 1024

export interface ColorThemeStore {
  active: string
  /** 派生出来的独立主题（有自己的完整变量表） */
  custom: CustomColorTheme[]
  /** 内置主题的用户改动，按主题 id 索引；删键 = 恢复默认 */
  overrides: Record<string, ThemeOverride>
}

const EMPTY_STORE: ColorThemeStore = { active: DEFAULT_COLOR_THEME, custom: [], overrides: {} }

function isBuiltinThemeId(id: string): boolean {
  return COLOR_THEMES.some((theme) => theme.id === id)
}

/** 任意主题当前的背景：自定义主题存自己身上，内置主题存覆盖层 */
export function backgroundOf(store: ColorThemeStore, id: string): ThemeBackground {
  const custom = store.custom.find((theme) => theme.id === id)
  if (custom) return custom.background
  return store.overrides[id]?.background ?? DEFAULT_THEME_BACKGROUND
}

/**
 * 把一份新背景写到 `id` 这套主题上：自定义主题改自身，内置主题写覆盖层。
 *
 * 清空背景（无图无视频）且覆盖层里没有别的东西时**整条删掉** —— 留一个「全默认」的背景
 * 等于给内置主题多挂一条空配置，`backgroundOf()` 读出来一样，但「恢复出厂」就失效了。
 *
 * 不认识的 id 原样返回：主题可能已在另一个窗口被删，别写出永远清不掉的野配置。
 */
export function withThemeBackground(
  store: ColorThemeStore,
  id: string,
  background: ThemeBackground
): ColorThemeStore {
  const custom = store.custom.find((theme) => theme.id === id)
  if (custom) {
    return {
      ...store,
      custom: store.custom.map((theme) =>
        theme.id === id ? { ...theme, background } : theme
      )
    }
  }
  if (!isBuiltinThemeId(id)) return store
  const overrides = { ...store.overrides }
  const existing = overrides[id]
  const empty = !background.image && !background.video
  if (empty && !existing?.vars && existing?.radius === undefined && !existing?.texture) {
    delete overrides[id]
  } else {
    overrides[id] = { ...existing, background }
  }
  return { ...store, overrides }
}

export function isThemeId(id: string, custom: CustomColorTheme[]): boolean {
  return COLOR_THEMES.some((theme) => theme.id === id) || custom.some((theme) => theme.id === id)
}

function normalizeVars(value: unknown): ThemeVars {
  const out: ThemeVars = {}
  if (value && typeof value === 'object') {
    for (const name of THEME_VAR_NAMES) {
      const item = (value as ThemeVars)[name]
      if (typeof item !== 'string' || !item) continue
      const spec = VAR_SPECS.get(name)
      if (!spec) continue
      const safe = sanitizeValue(spec, item)
      if (safe) out[name] = safe
    }
  }
  return out
}

/** 只接受十六进制颜色（内置主题的 `oklch()` 只走读路径，不走用户输入路径） */
const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 字体栈写入 `<style>` 前的消毒：剥掉能打断规则 / 引入外部资源的字符与函数。
 *
 * 自定义主题的字体是用户直接输入的字符串，而它会被拼进 `decls()` 生成的 `<style>`。
 * `;` / `{}` / `<>` / 控制字符能当场把后面的规则打断，`url(` 能让浏览器去拉外部资源。
 * 结果为空 = 不输出该键（继承 `:root` 默认），别输出一个空字体栈把字体弄没。
 */
export function sanitizeFontStack(value: string): string {
  return value
    .replace(/[\u0000-\u001f;{}<>\\]/g, '')
    .replace(/url\(/gi, '')
    .replace(/expression\(/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** 数字变量的唯一入口：非数字落回 fallback，越界夹到声明范围，最多 3 位小数 */
export function clampThemeNumber(
  value: string | number,
  min: number,
  max: number,
  fallback: number
): string {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  const base = Number.isFinite(parsed) ? parsed : fallback
  const clamped = Math.min(max, Math.max(min, base))
  return String(Number(clamped.toFixed(3)))
}

/** 按声明的 kind 校验一个值；返回空串 = 丢弃该键 */
function sanitizeValue(spec: ThemeVarSpec, value: string): string {
  if (spec.kind === 'font') return sanitizeFontStack(value)
  if (spec.kind === 'number') {
    const parsed = Number.parseFloat(value)
    if (!Number.isFinite(parsed)) return ''
    return clampThemeNumber(parsed, spec.min ?? 0, spec.max ?? 1, parsed)
  }
  return HEX_COLOR.test(value) ? value : ''
}

function normalizeTheme(value: unknown): CustomColorTheme | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<CustomColorTheme>
  if (typeof raw.id !== 'string' || !raw.id) return null
  const vars = (raw.vars ?? {}) as Partial<Record<ThemeModeKey, ThemeVars>>
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : '自定义主题',
    radius: typeof raw.radius === 'number' && Number.isFinite(raw.radius) ? raw.radius : 0.875,
    texture: isThemeTexture(raw.texture) ? raw.texture : 'none',
    vars: { light: normalizeVars(vars.light), dark: normalizeVars(vars.dark) },
    background: normalizeBackground(raw.background) ?? { ...DEFAULT_THEME_BACKGROUND }
  }
}

/** 视频引用要逐字段验：缺 `key` 的旧数据 / 手改过的 JSON 只能当没有 */
function normalizeVideoRef(value: unknown): BackgroundVideoRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<BackgroundVideoRef>
  if (typeof raw.key !== 'string' || !raw.key) return null
  return {
    key: raw.key,
    mime: typeof raw.mime === 'string' && raw.mime ? raw.mime : 'video/mp4',
    name: typeof raw.name === 'string' && raw.name ? raw.name : '背景视频'
  }
}

function normalizeBackground(value: unknown): ThemeBackground | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ThemeBackground>
  const video = normalizeVideoRef(raw.video)
  const image = typeof raw.image === 'string' && raw.image ? raw.image : null
  return {
    // 两者互斥：同时存在时视频优先（渲染层只有一层，留两个等于要它猜）
    image: video ? null : image,
    video,
    // 老数据没有这个字段：按 `cover` 走，与改动前完全一致
    fit: raw.fit === 'contain' ? 'contain' : 'cover',
    mask: typeof raw.mask === 'number' && Number.isFinite(raw.mask) ? raw.mask : DEFAULT_THEME_BACKGROUND.mask,
    blur: typeof raw.blur === 'number' && Number.isFinite(raw.blur) ? raw.blur : DEFAULT_THEME_BACKGROUND.blur
  }
}

function normalizeOverride(value: unknown): ThemeOverride | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ThemeOverride>
  const background = normalizeBackground(raw.background)
  // 没有背景就不算一层覆盖：变量 / 圆角 / 纹理都由编辑器保存时整份写入
  if (!background) return null
  const override: ThemeOverride = { background }
  if (raw.vars && typeof raw.vars === 'object') {
    const vars = raw.vars as Partial<Record<ThemeModeKey, ThemeVars>>
    override.vars = { light: normalizeVars(vars.light), dark: normalizeVars(vars.dark) }
  }
  if (typeof raw.radius === 'number' && Number.isFinite(raw.radius)) override.radius = raw.radius
  if (isThemeTexture(raw.texture)) override.texture = raw.texture
  return override
}

export function normalizeStore(value: unknown): ColorThemeStore {
  if (!value || typeof value !== 'object') return { ...EMPTY_STORE }
  const raw = value as Partial<ColorThemeStore> & { backgrounds?: unknown }

  const custom = Array.isArray(raw.custom)
    ? raw.custom
        .map(normalizeTheme)
        .filter((theme): theme is CustomColorTheme => theme !== null)
    : []

  const overrides: Record<string, ThemeOverride> = {}
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [id, entry] of Object.entries(raw.overrides)) {
      // 只允许内置主题进覆盖层：脏 id 会变成一条永远清不掉的野规则
      if (!isBuiltinThemeId(id)) continue
      const override = normalizeOverride(entry)
      if (override) overrides[id] = override
    }
  }
  const active = typeof raw.active === 'string' ? raw.active : DEFAULT_COLOR_THEME
  return {
    active: isThemeId(active, custom) ? active : DEFAULT_COLOR_THEME,
    custom,
    overrides
  }
}

export function loadStore(): ColorThemeStore {
  try {
    const stored = localStorage.getItem(STORE_KEY)
    if (stored) return normalizeStore(JSON.parse(stored))
  } catch {
    /* localStorage 被禁用 / 内容被手改成非 JSON —— 落回默认，不阻塞启动 */
  }
  return { ...EMPTY_STORE }
}

/** 写盘失败（图片太大撑爆 5MB 配额）返回 false，调用方要回滚 */
export function saveStore(store: ColorThemeStore): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

export function loadColorTheme(): string {
  return loadStore().active
}

// ---------------------------------------------------------------- 颜色换算

let probeCtx: CanvasRenderingContext2D | null | undefined

function probeContext(): CanvasRenderingContext2D | null {
  if (probeCtx !== undefined) return probeCtx
  if (typeof document === 'undefined') {
    probeCtx = null
    return probeCtx
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  probeCtx = canvas.getContext('2d', { willReadFrequently: true })
  return probeCtx
}

/**
 * 任意 CSS 颜色 → `#rrggbb`，半透明色叠在 `over` 上合成。
 *
 * 用 canvas 而不是自己算 oklch→sRGB：色彩管理交给浏览器，`oklch()` / `color()` /
 * `hsl()` 全都认，也不用维护第二套色值表。`CSS.supports` 先挡一次非法值 ——
 * 非法字符串赋给 `fillStyle` 是**静默忽略**，会原样返回上一个颜色。
 */
export function toHex(color: string, over = '#ffffff'): string {
  const ctx = probeContext()
  if (!ctx || !color) return over
  if (typeof CSS !== 'undefined' && !CSS.supports('color', color)) return over
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = over
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 同 `toHex()`，但**保留透明度**：叠完后 alpha 依旧 < 1 就输出 `#rrggbbaa`。
 *
 * 只给 `ThemeVarSpec.alpha` 的项用。全透明 / 非法值落回 `over`（不透明），
 * 否则主题会「整块消失」，用户看不出是自己调没了。
 */
export function toHexAlpha(color: string, over = '#ffffff'): string {
  const ctx = probeContext()
  if (!ctx || !color) return toHex(over)
  if (typeof CSS !== 'undefined' && !CSS.supports('color', color)) return toHex(over)
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = over
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  const hex = (channel: number): string => channel.toString(16).padStart(2, '0')
  const alpha = a ?? 255
  if (alpha >= 255 || alpha <= 0) return `#${hex(r)}${hex(g)}${hex(b)}`
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(alpha)}`
}

/**
 * 读一个变量的**原始值**（内置主题是 `oklch(...)` 这种）。
 *
 * 做法是塞一个 1px 的探针 div，带上 `data-theme` / `class="dark"`，让浏览器把该主题的
 * 级联算完再读 —— 比在 JS 里再抄一份色值表可靠（改 CSS 就自动跟上）。
 */
function readRawVar(themeId: string, mode: ThemeModeKey, name: string, fallback: string): string {
  if (typeof document === 'undefined' || !document.body) return fallback
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', themeId)
  if (mode === 'dark') probe.className = 'dark'
  probe.style.cssText =
    'position:absolute;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).getPropertyValue(name).trim()
  probe.remove()
  return value || fallback
}

/** 读一套主题的完整变量表并换算成 hex（新建自定义主题时的种子） */
export function readThemeVars(
  themeId: string,
  mode: ThemeModeKey
): { vars: ThemeVars; radius: number; texture: ThemeTexture } {
  if (typeof document === 'undefined' || !document.body) {
    return { vars: {}, radius: 0.875, texture: 'none' }
  }
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', themeId)
  if (mode === 'dark') probe.className = 'dark'
  probe.style.cssText =
    'position:absolute;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe)
  const raw: ThemeVars = {}
  for (const name of THEME_VAR_NAMES) raw[name] = computed.getPropertyValue(name).trim()
  const radius = Number.parseFloat(computed.getPropertyValue('--radius')) || 0.875
  const texture = textureFromCss(computed.getPropertyValue('--fizz-theme-texture').trim())
  probe.remove()

  const vars: ThemeVars = {}
  for (const group of THEME_VAR_GROUPS) {
    for (const spec of group.vars) {
      const value = raw[spec.name] ?? ''
      // 字体 / 数字不能过 toHex（会把字体栈烫成一个色值）
      if (spec.kind === 'font') {
        const font = sanitizeFontStack(value)
        if (font) vars[spec.name] = font
        continue
      }
      if (spec.kind === 'number') {
        const parsed = Number.parseFloat(value)
        if (Number.isFinite(parsed)) {
          vars[spec.name] = clampThemeNumber(parsed, spec.min ?? 0, spec.max ?? 1, parsed)
        }
        continue
      }
      const over = spec.over ? (vars[spec.over] ?? '#ffffff') : '#ffffff'
      // 允许半透明的项保留自己的 alpha：合成掉就再也调不回「透明」，
      // 种子也不再忠实于「当前看到的样子」。
      vars[spec.name] = spec.alpha
        ? toHexAlpha(value || over, over)
        : toHex(value || over, over)
    }
  }
  return { vars, radius, texture }
}

/** `#rrggbb` / `#rrggbbaa` → 通道值；不带 alpha 时第 4 位是 1 */
function parseHex(hex: string): [number, number, number, number] {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value.slice(0, 6)
  const alpha =
    value.length === 8 ? (Number.parseInt(value.slice(6, 8), 16) || 0) / 255 : 1
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
    alpha
  ]
}

/**
 * 背景色遮罩：`mask` 越高越不透明（图越淡）。
 *
 * 主题自己给的 alpha 也并进来（乘算）：这样在编辑器里把「背景 / 侧栏底」调成半透明，
 * 有背景图时能真的透出图；不透明时结果与原来完全一致（`a = 1 × mask`）。
 */
function veil(hex: string, mask: number): string {
  const [r, g, b, baseAlpha] = parseHex(hex)
  const alpha = Math.min(1, Math.max(0, baseAlpha * mask))
  return `rgb(${r} ${g} ${b} / ${alpha})`
}

/**
 * 同一个颜色的**不透明版本**：只留通道值，丢掉主题自己给的 alpha。
 *
 * 给 `[data-fizz-opaque]` 用（设置页要的是「挡住背景」，不是玻璃感）。自定义主题可以把
 * `--background` 调成 8 位 hex（想做玻璃感），那种情况下直接搬过来还是透的。
 */
function solidColor(hex: string): string {
  const [r, g, b] = parseHex(hex)
  return `rgb(${r} ${g} ${b})`
}

/**
 * 面板底（`--surface-1` / `--surface-2`）用的颜色：**与画布同色，且不比画布更透**。
 *
 * `decls()` 只负责「没有背景媒体」这条路径 —— 有图 / 视频时 `buildStyle()` 会用
 * `mask + USER_SURFACE_MASK` 在 `<html>` 上再覆盖一次。此时画布就是 `--background` 本身：
 * - 不透明底色（绝大多数情况）→ 输出不透明同色，面板与画布逐像素一致；
 * - 用户把 `--background` 调成 8 位 hex（玻璃感）→ 叠 `USER_SURFACE_MASK` 让它实一档，
 *   否则二级页 / 抽屉压在内容上时能看见下层的字。
 *
 * ⚠️ 这里必须**加** alpha，不能写成 `veil(bg, USER_SURFACE_MASK)`：`veil()` 是**乘**，
 * 会把不透明底（alpha = 1）算成 0.14 —— 整块面板 86% 透明。手机版设置页铺的正是
 * `bg-surface-1`，于是「微调出一套主题（哪怕一个字都没改）→ 设置页背景变透明」。
 */
function surfaceOf(hex: string): string {
  const [r, g, b, baseAlpha] = parseHex(hex)
  const alpha = Math.min(1, baseAlpha + USER_SURFACE_MASK)
  return `rgb(${r} ${g} ${b} / ${alpha})`
}

function decls(vars: ThemeVars, radius: number, texture: ThemeTexture): string {
  // 声明块会直接拼进 `<style>`：白名单变量 + 按 kind 再校一次（旧版本存下的、手改
  // localStorage 的值都走这里，不能信任 store 里的字符串）。
  const safe = Object.entries(vars).flatMap(([name, value]) => {
    const spec = VAR_SPECS.get(name)
    if (!spec) return []
    const checked = sanitizeValue(spec, value)
    return checked ? [`${name}:${checked}`] : []
  })
  // ⚠️ 自定义主题 / 覆盖层也是**在 `<html>` 上重写 `--background`** 的一类选择器，
  // surface 必须跟着重写（理由见 `themes.css` 开头那段）：`--surface-1` 是在**声明它的
  // 元素**上求值的，不在这里重写，预览小卡（自带 `data-theme` 的 div）拿到的会是
  // 从 `<html>` 继承下来的、属于**当前主题**的那份底色，和卡片自己这套配色分家。
  // 取值规则见 `surfaceOf()`（同色、只多不少）。
  const bg = vars['--background']
  const surface = bg ? surfaceOf(bg) : 'var(--background)'
  safe.push(`--radius:${radius}rem`)
  safe.push(`--surface-1:${surface}`)
  safe.push(`--surface-2:${surface}`)
  safe.push(`--fizz-theme-texture:${TEXTURE_CSS[texture]}`)
  safe.push(`--fizz-texture-size:${TEXTURE_SIZE[texture]}`)
  return safe.join(';')
}

/** 当前明暗（`<html class="dark">`） */
function currentMode(): ThemeModeKey {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * 当前主题的纹理（CSS 值与平铺尺寸）。
 *
 * 自定义主题直接查枚举；内置主题读 CSS 原始值 —— **不按枚举反查后重拼**，
 * 主题可以有自己的微调值（例如 plum 只有暗色有星点）。
 */
function textureOf(store: ColorThemeStore, mode: ThemeModeKey): { image: string; size: string } {
  const custom = store.custom.find((theme) => theme.id === store.active)
  if (custom) {
    return { image: TEXTURE_CSS[custom.texture], size: TEXTURE_SIZE[custom.texture] }
  }
  // 内置主题改过纹理就用改过的；没改过才去读 CSS 原值
  const override = store.overrides[store.active]?.texture
  if (override) return { image: TEXTURE_CSS[override], size: TEXTURE_SIZE[override] }
  return {
    image: readRawVar(store.active, mode, '--fizz-theme-texture', 'none'),
    size: readRawVar(store.active, mode, '--fizz-texture-size', 'auto')
  }
}

function baseVar(store: ColorThemeStore, mode: ThemeModeKey, name: string): string {
  const fallback = mode === 'dark' ? '#0a0a0a' : '#ffffff'
  const custom = store.custom.find((theme) => theme.id === store.active)
  // 自定义主题里存的已经是 hex（可能是 8 位）；**内置主题读回来的是 `oklch(...)`**，
  // 必须换一次 —— `veil()` 只认 hex，把 oklch 直接喂给 `parseHex` 会算成黑色（遮罩变黑块）。
  // 用带 alpha 的版本：背景 / 侧栏底的半透明要能透到图上。
  const raw = custom
    ? custom.vars[mode][name] || fallback
    : store.overrides[store.active]?.vars?.[mode]?.[name] ||
      readRawVar(store.active, mode, name, fallback)
  return toHexAlpha(raw, fallback)
}

export function buildStyle(store: ColorThemeStore, revealed = backgroundRevealed): string {
  const rules: string[] = []
  for (const theme of store.custom) {
    // 每条都带两个选择器：`[data-theme]` 给预览小卡（div），`html[data-theme]` 给根节点。
    // 后者特异性 (0,1,1) 是为了**压过 `:root` 的 (0,1,0)** —— 只写前者的话，dev 模式下
    // Vite 热更新把样式表重新插到 `<head>` 末尾，就会反过来盖掉自定义主题。
    rules.push(
      `[data-theme="${theme.id}"], html[data-theme="${theme.id}"]{${decls(theme.vars.light, theme.radius, theme.texture)}}`
    )
    rules.push(
      `.dark[data-theme="${theme.id}"], html.dark[data-theme="${theme.id}"]{${decls(theme.vars.dark, theme.radius, theme.texture)}}`
    )
  }

  // 内置主题的覆盖层：同名选择器、同一个 style 标签（在 themes.css 之后），所以直接压过
  // `themes.css` 的原值。缺 vars / radius / texture 的（老数据只换了背景）不生成变量规则 ——
  // 否则会把圆角 / 纹理写成一个 undefined。
  for (const [id, override] of Object.entries(store.overrides)) {
    if (!override.vars || override.radius === undefined || !override.texture) continue
    rules.push(
      `[data-theme="${id}"], html[data-theme="${id}"]{${decls(override.vars.light, override.radius, override.texture)}}`
    )
    rules.push(
      `.dark[data-theme="${id}"], html.dark[data-theme="${id}"]{${decls(override.vars.dark, override.radius, override.texture)}}`
    )
  }

  // ⚠️ 首帧门禁（见 `backgroundRevealed`）：应用还没挂载时**整段不发** —— 不只是
  // `--fizz-bg-image`，那几条半透明遮罩也一起不发。只挡图不挡遮罩的话，遮罩会先叠在
  // 一层「还没有图」的空底上，深色主题下泛白，等于换了个东西闪。
  const background = revealed ? backgroundOf(store, store.active) : undefined
  const video = background?.video ?? null
  // 图片与视频互斥（`setBackground` / `normalizeBackground` 都保证），这里再兜一次：
  // 有视频就不发 `--fizz-bg-image`，否则图会从视频后面露出来
  const image = video ? null : (background?.image ?? null)
  const hasMedia = Boolean(image || video)
  // 媒体优先：有图 / 视频时主题纹理让位（两层装饰叠在一起会发脏、也互相干扰）。
  // 首帧前一律不画纹理（与被门禁拦住的媒体同一时刻放行）。
  //
  // ⚠️ **亮暗各取一次**：内置主题可以只在一档里出纹理（plum 亮色纯色 / 暗色星点）。
  // 按当前明暗取一次再同时写进两条规则的话，暗色下任何一次 applyColorTheme() 都会把
  // 星点写进亮色规则（特异性压过主题块），而切明暗不会重跑这里 —— 亮色就留着星点。
  const noTexture = { image: 'none', size: 'auto' }
  const lightTexture = hasMedia || !revealed ? noTexture : textureOf(store, 'light')
  const darkTexture = hasMedia || !revealed ? noTexture : textureOf(store, 'dark')
  const decorated = hasMedia || lightTexture.image !== 'none' || darkTexture.image !== 'none'
  if (!decorated) return rules.join('\n')

  // 模糊只在 >0 时给值：`blur(0px)` 也会让浏览器建一层合成层，没必要的开销。
  // 视频那一层读的是同一个 `--fizz-bg-filter`（见 themes.css 的 `#fizz-bg-video`）。
  // `--fizz-bg-fit` 两层共读：图片走 `background-size`、视频走 `object-fit`（见 themes.css），
  // 所以换摆法只需要发这一个变量，不用重新挂媒体。
  const media = [
    image ? `--fizz-bg-image:url("${image}")` : '',
    background && background.blur > 0 ? `--fizz-bg-filter:blur(${background.blur}px)` : '',
    background ? `--fizz-bg-fit:${background.fit}` : ''
  ]
    .filter(Boolean)
    .join(';')
  // 遮罩强度：有媒体时听用户的；纯纹理时用固定值（留一点底色让纹理透出来）
  const mask = background && hasMedia ? background.mask : TEXTURE_MASK
  // 背景与侧栏都换成半透明：外壳根节点是 `bg-sidebar`、内容区是 `bg-background`，
  // 只放其中一个的话另一块会把图盖死（看起来像「图只出现在某个框里」）。
  //
  // `--surface-1` / `--surface-2` 是「压在画布之上、还要读字」的面板层级（右侧面板、助手、
  // 抽屉）。它们比画布更实（同一主题底色、更高 alpha），所以不会透出下层对话正文；又比
  // `data-fizz-opaque` 的不透明底色轻一点，媒体还在。**别把它们用在整页内容容器上** ——
  // 那会把背景图盖掉（那类容器该用 `bg-background`，或干脆透明让父层画一次）。
  const surface = (mode: ThemeModeKey) => {
    const background = baseVar(store, mode, '--background')
    return (
      `--background:${veil(background, mask)};` +
      `--sidebar:${veil(baseVar(store, mode, '--sidebar'), mask)};` +
      `--surface-1:${veil(background, Math.min(1, mask + USER_SURFACE_MASK))};` +
      `--surface-2:${veil(background, Math.min(1, mask + 0.24))}`
    )
  }
  // 不透明的主题底色：`data-fizz-opaque`（要读字的界面）与 `--fizz-bg-base`（媒体层那块底）共用
  const solid = (mode: ThemeModeKey) => solidColor(baseVar(store, mode, '--background'))
  // 纹理声明一定要发：有媒体时它是 `none` / `auto`，用来盖掉主题块自带的纹理
  const textureDecl = (texture: { image: string; size: string }): string =>
    `--fizz-theme-texture:${texture.image};--fizz-texture-size:${texture.size}`
  // `--fizz-bg-base`：媒体层自己那块底（`themes.css` 的 `body::before` 读它）。
  // 图**还没解码出来**的那一两帧、`contain` 两侧的留白，露的都是它 —— 没有它露的是
  // 画布白（配了背景时 body 背景已被清成 transparent），深色主题下就是一道亮边 / 一闪白。
  // 只在需要装饰时发，没配背景 / 没纹理的用户一个像素都不变；按明暗各发一份，切明暗自动跟上。
  // （视频层读的是 JS 现算的 `--fizz-bg-void`，来源同一套 `solidColor(baseVar(...))`。）
  // 亮色：html[data-theme] (0,1,1) 压过内置 / 自定义主题的亮色块 (0,1,0)
  rules.push(
    `html[data-theme="${store.active}"]{${surface('light')};${media};--fizz-bg-base:${solid('light')};${textureDecl(lightTexture)}}`
  )
  // 暗色：必须 (0,2,1) 才压得过 `.dark[data-theme="custom"]` 的 (0,2,0)
  rules.push(
    `html.dark[data-theme="${store.active}"]{${surface('dark')};${media};--fizz-bg-base:${solid('dark')};${textureDecl(darkTexture)}}`
  )
  // body 自己也有一层 bg-background，不清掉就是「遮罩叠两次」，图几乎看不见
  rules.push(`html[data-theme="${store.active}"] body{background-color:transparent}`)
  // 「要读字」的界面（桌面设置窗口 / 手机设置页）不吃这层遮罩：整块换回**不透明**的主题底色。
  // 元素自己声明 `--background` 就能盖过从 `html` 继承来的半透明值（跨元素不比特异性），
  // 但**它还得自带 `bg-background`** —— 这里只换变量，不会凭空画出一块底色。
  // 既没背景媒体也没纹理时不发这两条：那时 `--background` 本来就是不透明的。
  // ⚠️ 表面令牌也要一起换回不透明：自定义属性是**继承计算值**的，`html` 上派生的
  // `rgb(... / 0.86)` 会原样传到 `[data-fizz-opaque]` 子树里，只改 `--background` 不够。
  rules.push(
    `html[data-theme="${store.active}"] [data-fizz-opaque]{--background:${solid('light')};--surface-1:${solid('light')};--surface-2:${solid('light')}}`
  )
  rules.push(
    `html.dark[data-theme="${store.active}"] [data-fizz-opaque]{--background:${solid('dark')};--surface-1:${solid('dark')};--surface-2:${solid('dark')}}`
  )
  return rules.join('\n')
}

// ---------------------------------------------------------------- 背景视频层

const BG_VIDEO_ID = 'fizz-bg-video'

let videoLayer: HTMLVideoElement | null = null
let videoUrl: string | null = null
let videoKey: string | null = null
/** 异步加载序号：连点主题时，晚到的旧结果不许贴上去 */
let videoSeq = 0
let videoEventsHooked = false

let gestureRetryBound = false

function playVideo(element: HTMLVideoElement): void {
  // 静音自动播放一般放行；被策略拦下时（少见）就停在第一帧，别把 rejection 抛到控制台
  void element.play().catch(() => {
    // 极少数 WebView 连静音自动播放都拦：等用户第一次点屏幕再补播（一次性，别叠监听）
    if (gestureRetryBound || typeof document === 'undefined') return
    gestureRetryBound = true
    const retry = (): void => {
      document.removeEventListener('pointerdown', retry, true)
      gestureRetryBound = false
      void element.play().catch(() => undefined)
    }
    document.addEventListener('pointerdown', retry, true)
  })
}

function revokeVideoUrl(): void {
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = null
}

function ensureVideoLayer(): HTMLVideoElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (videoLayer?.isConnected) return videoLayer
  const existing = document.getElementById(BG_VIDEO_ID)
  const element = existing instanceof HTMLVideoElement ? existing : document.createElement('video')
  element.id = BG_VIDEO_ID
  // `muted` + `loop` + `playsinline` 是「无需手势自动播放」的全部前提，少一个手机端就静止。
  // 属性与 property 都写：属性给初次解析 / 序列化，property 给已经插入的实例。
  element.muted = true
  element.defaultMuted = true
  element.loop = true
  element.autoplay = true
  element.playsInline = true
  element.setAttribute('muted', '')
  element.setAttribute('playsinline', '')
  element.setAttribute('aria-hidden', 'true')
  element.tabIndex = -1
  element.disablePictureInPicture = true
  element.hidden = true
  if (!existing) document.body.appendChild(element)
  videoLayer = element
  if (!videoEventsHooked) {
    videoEventsHooked = true
    // 窗口不可见就暂停：视频是持续解码的，后台挂着纯烧电
    document.addEventListener('visibilitychange', () => {
      if (!videoLayer) return
      if (document.hidden) videoLayer.pause()
      else if (!videoLayer.hidden) playVideo(videoLayer)
    })
  }
  return element
}

/** 摘掉当前视频（移除背景 / 换成图片 / 这套主题没配视频） */
function detachBackgroundVideo(): void {
  videoSeq += 1
  videoKey = null
  revokeVideoUrl()
  if (!videoLayer) return
  videoLayer.pause()
  videoLayer.hidden = true
  videoLayer.removeAttribute('src')
  videoLayer.load()
}

/**
 * `contain` 时视频两侧露出来的底色（`themes.css` 里 `#fizz-bg-video` 的 `background-color`）。
 *
 * 为什么必须显式算一份不透明底色：视频层是 `z-index:-1`，应用根节点那层半透明的
 * `bg-background`（遮罩）**盖在它上面** —— 留 `transparent` 的话露出来的不是「图框」而是
 * 画布白（配了背景时 body 背景已经被清成透明），看着像视频被切成了一条。
 * 取值来源与遮罩同一套：当前主题**当前明暗**的 `--background`
 * 去掉透明度（`solidColor`），所以亮色下是白底、暗色下是深底，换主题也跟着变。
 *
 * 图片层那块底走的是 `buildStyle()` 里的 `--fizz-bg-base`（那条规则本来就按明暗各发一份，
 * 不用再靠这里现算）；两者取值同源，改一边要记得另一边。
 *
 * 直接读 `:root` 上现成的 `--background` 再 `solidColor` 不行 —— 配了背景时那个变量已经被
 * `buildStyle()` 换成了半透明值，读回来再洗白会偏色。所以走 `baseVar()` 取「主题原始底色」，
 * 与 `buildStyle()` 的 `solid()` 完全同源。
 */
function applyBackgroundVoid(store: ColorThemeStore): void {
  if (typeof document === 'undefined') return
  const mode: ThemeModeKey = document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light'
  document.documentElement.style.setProperty(
    '--fizz-bg-void',
    solidColor(baseVar(store, mode, '--background'))
  )
}

/** `bootstrapColorTheme()` 可能被调多次（同一窗口重进 / HMR），观察者只挂一次 */
let voidObserverBound = false

/**
 * 把当前主题的视频背景贴到 `#fizz-bg-video`（样式在 `themes.css`）。
 *
 * 为什么是异步的：视频本体在 IndexedDB 里，要读出来再 `URL.createObjectURL`。
 * `applyColorTheme` **不等**它 —— 配色必须同步落地，视频晚一拍出现不影响布局。
 */
async function applyBackgroundVideo(store: ColorThemeStore): Promise<void> {
  if (typeof document === 'undefined') return
  // 首帧前调用时 body 可能还没解析出来：等 DOM 就绪再补一次，否则视频永远不出现
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', () => void applyBackgroundVideo(store), {
      once: true
    })
    return
  }
  const ref = backgroundOf(store, store.active).video ?? null
  if (!ref) {
    detachBackgroundVideo()
    return
  }
  // `contain` 的留白色：必须在下一帧之前写好（换明暗 / 换主题时也要跟上）
  applyBackgroundVoid(store)
  const element = ensureVideoLayer()
  if (!element) return
  // 同一个视频、只是遮罩 / 模糊变了：CSS 已经改完，别重新解码一遍
  if (videoKey === ref.key && videoUrl) {
    element.hidden = false
    playVideo(element)
    return
  }
  const seq = ++videoSeq
  const blob = await getBackgroundVideo(ref.key)
  // 期间又切了主题 / 换了视频：这份结果已经过期，丢掉（否则旧视频会盖住新的）
  if (seq !== videoSeq) return
  if (!blob) {
    detachBackgroundVideo()
    return
  }
  // 先摘掉旧 src 再 revoke：媒体元素还在循环播时仍持有那个 URL，直接 revoke 会让
  // 某些实现上正在播的帧断掉（换视频时表现为闪一下黑）
  element.pause()
  element.removeAttribute('src')
  element.load()
  revokeVideoUrl()
  videoUrl = URL.createObjectURL(blob)
  videoKey = ref.key
  element.src = videoUrl
  element.hidden = false
  playVideo(element)
}

// ---------------------------------------------------------------- 主题 revision

/**
 * 主题每落一次 DOM 就 +1 —— 给「需要重新计算派生值」的消费方用
 * （目前是代码高亮：Shiki / Monaco 的主题要从 CSS 变量重新拼）。
 *
 * 不能只盯 `data-theme`：明暗切换、同一套主题换颜色、自定义主题改名保存都不会改这个属性。
 * 用 `useSyncExternalStore` 订阅，和 `useTheme` 那套保持同一种形状。
 */
let themeRevision = 0
const themeListeners = new Set<() => void>()

export function subscribeColorTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}

export function getColorThemeRevision(): number {
  return themeRevision
}

function bumpThemeRevision(): void {
  themeRevision += 1
  for (const listener of themeListeners) listener()
}

export function applyColorTheme(store: ColorThemeStore = loadStore()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = isThemeId(store.active, store.custom) ? store.active : DEFAULT_COLOR_THEME
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = buildStyle(store)
  // 明暗是挂在 `<html class="dark">` 上的，可能在本函数之外被改（`useTheme` 的
  // `applyThemeClass`），所以这里现读一次；`useColorTheme` 也把它列进那个 effect 的依赖。
  applyBackgroundVoid(store)
  // 视频层是异步的（IndexedDB），配色不等它；没有视频时这一步只做一次摘除
  void applyBackgroundVideo(store)
  bumpThemeRevision()
}

/**
 * 背景媒体（图 / 视频）什么时候才允许画出来。
 *
 * ⚠️ 图片是**同步**可用的 data URL：`buildStyle()` 一写进 `<style>`，`body::before`
 * 下一帧就能把它画满整窗。而窗口是 `ready-to-show`（= 首帧）就 show 的，React 的首次
 * 提交还排在调度器的下一个宏任务里 —— 于是用户看到的是「整窗一张背景图、没有界面」，
 * 界面随后才压上来（用户报的「闪一下背景图片，然后显示主界面」）。
 * 视频没这个症状，纯粹因为它本体在 IndexedDB 里，读出来时界面早就画好了。
 */
let backgroundRevealed = false

/**
 * 等应用**真的挂载**（`#root` 里有第一个元素）再放行背景媒体，并立刻重算一次样式。
 *
 * 为什么用 MutationObserver 而不是 rAF / setTimeout：React 18 的首次提交是调度器里的
 * 一个宏任务，和 rAF 谁先谁后不确定；而 MutationObserver 是**微任务**，紧跟在那次 DOM
 * 变更之后、下一帧绘制之前 —— 图和界面于是落在同一帧里，一次都不闪。
 *
 * 没有 `#root`（别的宿主 / 容器被换掉）时直接放行：宁可退回老行为，也别让背景永远不出来。
 */
function revealBackgroundOnMount(): void {
  if (backgroundRevealed || typeof document === 'undefined') return
  const reveal = (): void => {
    if (backgroundRevealed) return
    backgroundRevealed = true
    applyColorTheme()
  }
  const root = document.getElementById('root')
  if (!root || root.firstElementChild) {
    reveal()
    return
  }
  const observer = new MutationObserver(() => {
    if (!root.firstElementChild) return
    observer.disconnect()
    reveal()
  })
  observer.observe(root, { childList: true })
}

/**
 * 首帧前落主题（三端 `main.tsx` 调用）：设置页的 `useColorTheme` 只活在「外观」里，
 * 没有这一步的话首屏是默认配色、进设置才跳变。顺带盯 `storage`：桌面设置窗口是独立
 * BrowserWindow，那边换主题时主窗口只收得到这个事件。
 *
 * 背景媒体另有**首帧门禁**（`revealBackgroundOnMount`）：配色同步落，媒体等应用挂载。
 */
export function bootstrapColorTheme(): void {
  applyColorTheme()
  revealBackgroundOnMount()
  window.addEventListener('storage', (event) => {
    if (event.key === STORE_KEY) applyColorTheme()
  })
  /**
   * 明暗能在**没有设置面板**的路径上变（跟随系统时系统切了、`useTheme` 在别处改了），
   * 而 `--fizz-bg-void`（`contain` 时视频两侧的底色）要跟着换 —— 只改 `<html class>`
   * 不经过 store，`applyColorTheme` 不会被调。这里盯 class 就够了：`data-theme` 那条
   * 已经有 storage 与 `useColorTheme` 的 effect 兜住，再盯一遍只是白跑。
   *
   * 多窗口（Electron 每个窗口各一个 document）重进这里时别重复挂，白白多一条观察者。
   */
  if (voidObserverBound) return
  voidObserverBound = true
  new MutationObserver(() => applyBackgroundVoid(loadStore())).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['class'] }
  )
}

function nextCustomName(store: ColorThemeStore): string {
  const used = new Set(store.custom.map((theme) => theme.name))
  for (let index = 1; index < 200; index += 1) {
    const name = `自定义 ${index}`
    if (!used.has(name)) return name
  }
  return `自定义 ${Date.now().toString(36)}`
}

/**
 * 以 `seedId`（默认当前主题）为种子新建一套自定义主题（直接选中它）。
 *
 * 种子必须从 CSS 里读（`readThemeVars`）而不是在 TS 里写死一份色板：内置主题的色值
 * 只应存在于 `themes.css`，抄两份迟早对不上。
 *
 * `seedId` 给了就允许从**任意内置主题**派生 —— 外观页每张卡右上角的「微调」走这条路，
 * 用户不用先切过去再新建（切过去会当场换掉整个界面）。
 */
export function createCustomTheme(
  store: ColorThemeStore,
  seedId: string = store.active
): { store: ColorThemeStore; id: string } {
  const base = store.custom.find((theme) => theme.id === seedId)
  const seedLight = base
    ? { vars: base.vars.light, radius: base.radius, texture: base.texture }
    : readThemeVars(seedId, 'light')
  const seedDark = base
    ? { vars: base.vars.dark, radius: base.radius, texture: base.texture }
    : readThemeVars(seedId, 'dark')
  // 纹理只有一个值（不分明暗）：内置主题按当前明暗档取（ plum 暗色才有星点）
  const texture = base ? base.texture : readThemeVars(seedId, currentMode()).texture
  // 背景也是主题的一部分：派生时连图 / 视频、显示方式、遮罩、模糊一起带过去。
  // 视频只复制引用，所以同一个 key 可能被多套主题共用（删前要过 `videoStillUsed`）。
  const seedBackground = backgroundOf(store, seedId)
  const id = `custom-${Date.now().toString(36)}`
  const theme: CustomColorTheme = {
    id,
    name: nextCustomName(store),
    radius: seedLight.radius,
    texture,
    vars: { light: { ...seedLight.vars }, dark: { ...seedDark.vars } },
    background: { ...seedBackground }
  }
  return { store: { ...store, active: id, custom: [...store.custom, theme] }, id }
}

export interface UseColorTheme {
  /** 当前主题 id */
  theme: string
  setTheme: (id: string) => void
  custom: CustomColorTheme[]
  /** **当前主题**的背景配置（每套主题各存一份；内置主题存在覆盖层） */
  background: ThemeBackground
  /** 任意主题的背景配置 —— 外观页给「非当前主题」设背景时用 */
  backgroundOf: (id: string) => ThemeBackground
  /**
   * 写任意主题的背景：自定义主题改自身，内置主题写覆盖层（清空后整条覆盖删掉）。
   * 返回 false = 存不下（多半是图片太大撑爆配额），调用方要提示。
   */
  setBackground: (id: string, patch: Partial<ThemeBackground>) => boolean
  /** 建好并**立即选中**它；`seedId` = 以哪套主题为种子（默认当前主题） */
  createCustom: (seedId?: string) => CustomColorTheme | null
  updateCustom: (
    id: string,
    patch: Partial<Pick<CustomColorTheme, 'name' | 'radius' | 'texture' | 'vars'>>
  ) => boolean
  deleteCustom: (id: string) => void
}

export function useColorTheme(): UseColorTheme {
  const [store, setStore] = useState<ColorThemeStore>(() => loadStore())
  /** 实际亮暗（挂在 `<html class="dark">` 上）：`--fizz-bg-void` 要按它选底色 */
  const { theme: resolved } = useTheme()

  // 落 DOM：每次 store 变化都重建 `<style>` + `data-theme`（含预览卡要用的自定义主题规则）
  useEffect(() => {
    applyColorTheme(store)
  }, [store])

  /**
   * 明暗一变就重算 `--fizz-bg-void`（`contain` 时视频两侧的留白色，见 `applyBackgroundVoid`）。
   *
   * 明暗只改 `<html class="dark">`、不经过 `store`，所以那个 effect 不会跑；而 `applyColorTheme`
   * 里的 `applyBackgroundVoid` 是给「首帧 / 换主题 / 别的窗口改了」兜底的。
   * 这里必须**真的依赖 `resolved`**：设置页开着外观 Tab 切明暗时，不重算就还是一块旧底色。
   */
  useEffect(() => {
    applyBackgroundVoid(store)
  }, [store, resolved])

  // 别的窗口改了 → 跟（桌面设置窗口是独立 BrowserWindow；storage 不会发给改动的那个窗口）
  useEffect(() => {
    const reload = () => {
      setStore((current) => {
        const next = loadStore()
        return JSON.stringify(next) === JSON.stringify(current) ? current : next
      })
    }
    window.addEventListener('storage', reload)
    window.addEventListener(CHANGED_EVENT, reload)
    return () => {
      window.removeEventListener('storage', reload)
      window.removeEventListener(CHANGED_EVENT, reload)
    }
  }, [])

  const commit = (next: ColorThemeStore): boolean => {
    if (!saveStore(next)) return false
    setStore(next)
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT))
    return true
  }

  const setTheme = (id: string): void => {
    if (!isThemeId(id, store.custom) || id === store.active) return
    commit({ ...store, active: id })
  }

  const setBackground = (id: string, patch: Partial<ThemeBackground>): boolean => {
    const current = backgroundOf(store, id)
    const next: ThemeBackground = { ...current, ...patch }
    // 图片与视频互斥：后选的那个把另一个顶掉（渲染层只有一层，留两个等于让它猜）
    if (patch.video) next.image = null
    if (patch.image) next.video = null
    const nextStore = withThemeBackground(store, id, next)
    const ok = commit(nextStore)
    // 换掉 / 移除旧视频时把本体从 IndexedDB 删掉，不然几十 MB 的孤儿会一直占着磁盘。
    // 但派生主题会共用同一个 key，别的主题还引用着就不能删。
    if (
      ok &&
      current.video &&
      current.video.key !== next.video?.key &&
      !videoStillUsed(nextStore, current.video.key)
    ) {
      void deleteBackgroundVideo(current.video.key)
    }
    // 反过来：引用没写进去（localStorage 配额满）时，刚存进库的那段就是孤儿，一并清掉
    if (!ok && next.video && next.video.key !== current.video?.key) {
      void deleteBackgroundVideo(next.video.key)
    }
    return ok
  }

  const createCustom = (seedId?: string): CustomColorTheme | null => {
    const next = createCustomTheme(store, seedId)
    if (!commit(next.store)) return null
    return next.store.custom.find((theme) => theme.id === next.id) ?? null
  }

  const updateCustom = (
    id: string,
    patch: Partial<Pick<CustomColorTheme, 'name' | 'radius' | 'texture' | 'vars'>>
  ): boolean =>
    commit({
      ...store,
      custom: store.custom.map((theme) => (theme.id === id ? { ...theme, ...patch } : theme))
    })

  const deleteCustom = (id: string): void => {
    const removed = store.custom.find((theme) => theme.id === id)
    const nextStore: ColorThemeStore = {
      ...store,
      custom: store.custom.filter((theme) => theme.id !== id),
      active: store.active === id ? DEFAULT_COLOR_THEME : store.active
    }
    const ok = commit(nextStore)
    // 这套主题的背景视频也跟着走，否则 IndexedDB 里会留下永远读不到的几十 MB。
    // 派生主题可能共用同一个 key，还被人引用就留着。
    const video = removed?.background.video
    if (ok && video && !videoStillUsed(nextStore, video.key)) {
      void deleteBackgroundVideo(video.key)
    }
  }

  const backgroundOfTheme = (id: string): ThemeBackground => backgroundOf(store, id)

  return {
    theme: store.active,
    setTheme,
    custom: store.custom,
    background: backgroundOfTheme(store.active),
    backgroundOf: backgroundOfTheme,
    setBackground,
    createCustom,
    updateCustom,
    deleteCustom
  }
}

// ---------------------------------------------------------------- 背景图 / 视频

async function decodeImage(
  file: File
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('图片解码失败'))
      element.src = url
    })
    return { source: image, width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 把用户选的图片压成能塞进 localStorage 的 data URL。
 *
 * 不压缩的话一张手机照片（3~8MB）base64 后直接撑爆 5MB 配额，`setItem` 抛异常、
 * 整份主题配置都存不进去。这里按最长边 1920 转 JPEG，仍超 1.6MB 就逐级降。
 */
export async function prepareThemeImage(file: File): Promise<string> {
  const { source, width, height } = await decodeImage(file)
  let maxEdge = 1920
  let quality = 0.82
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scale = Math.min(1, maxEdge / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 canvas')
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', quality)
    if (url.length <= 1_600_000 || attempt === 2) return url
    maxEdge = Math.round(maxEdge * 0.7)
    quality = 0.72
  }
  throw new Error('图片压缩失败')
}

/**
 * 读一次元数据，确认浏览器真的解得了这段视频。
 *
 * `.mkv` / HEVC / AV1 这类格式在部分 WebView 里解不了：直接存下去只会得到一块黑底，
 * 用户完全看不出是哪一步错了。宁可在「选文件」时就报错。
 */
async function probeVideo(file: File): Promise<void> {
  const url = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      const element = document.createElement('video')
      element.preload = 'metadata'
      element.muted = true
      const timer = window.setTimeout(() => reject(new Error('视频读取超时')), 10_000)
      element.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      element.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('浏览器解不了这个视频格式'))
      }
      element.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 校验并存入用户选的视频，返回**引用**（本体进 IndexedDB）。
 *
 * 与 `prepareThemeImage` 的差别：视频没法压缩（没有 canvas 那条路），所以只卡体积上限，
 * 本体原样存 —— 编码参数留给用户自己的素材。
 */
export async function prepareThemeVideo(file: File): Promise<BackgroundVideoRef> {
  if (!file.type.startsWith('video/')) throw new Error('这不是视频文件')
  if (file.size > MAX_BACKGROUND_VIDEO_BYTES) {
    throw new Error(`视频超过 ${Math.round(MAX_BACKGROUND_VIDEO_BYTES / 1024 / 1024)}MB`)
  }
  await probeVideo(file)
  return putBackgroundVideo(file, file.name)
}
