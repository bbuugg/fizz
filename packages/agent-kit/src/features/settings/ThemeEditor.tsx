"use client"

import { useState, type CSSProperties } from 'react'
import { ColorPickerField } from '@fizz/ui/color-picker-field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Input } from '@fizz/ui/input'
import { Slider } from '@fizz/ui/slider'
import { Button } from '@fizz/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import {
  DEFAULT_THEME_BACKGROUND,
  TEXTURE_CSS,
  TEXTURE_SIZE,
  THEME_TEXTURES,
  THEME_VAR_GROUPS,
  clampThemeNumber,
  readThemeVars,
  type CustomColorTheme,
  type ThemeBackground,
  type ThemeEditorTab,
  type ThemeModeKey,
  type ThemeTexture,
  type ThemeVarGroup,
  type ThemeVars
} from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { ThemeBackgroundEditor } from '@fizz/agent-kit/features/settings/ThemeBackgroundEditor'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import { useT } from '@fizz/agent-kit/shared/lib/language'

const MODES: Array<{ key: ThemeModeKey; label: string }> = [
  { key: 'light', label: '亮色' },
  { key: 'dark', label: '暗色' }
]

/** 6 个页签：变量组按 `ThemeVarGroup.tab` 分派到对应页；背景单独走 `ThemeBackground` */
const TABS: Array<{ value: ThemeEditorTab; label: string }> = [
  { value: 'color', label: '颜色' },
  { value: 'font', label: '字体' },
  { value: 'scale', label: '尺度' },
  { value: 'texture', label: '质感' },
  { value: 'code', label: '代码' },
  { value: 'background', label: '背景' }
]

const ALL_SPECS = THEME_VAR_GROUPS.flatMap((group) => group.vars)

const groupsOf = (tab: ThemeEditorTab): ThemeVarGroup[] =>
  THEME_VAR_GROUPS.filter((group) => group.tab === tab)

export interface ThemeEditorProps {
  theme: CustomColorTheme
  /** 这套主题当前的背景（与颜色变量一样，是主题的一部分） */
  background: ThemeBackground
  onClose: () => void
  /** 返回 false = 没存下（配额），编辑器留在原地并提示 */
  onSave: (patch: {
    name: string
    radius: number
    texture: ThemeTexture
    vars: Record<ThemeModeKey, ThemeVars>
  }) => boolean
  /** 背景**即时写盘**（上传时就落了盘，没法当草稿回滚）；返回 false = 配额满 */
  onBackgroundChange: (patch: Partial<ThemeBackground>) => boolean
}

/**
 * 自定义主题编辑器：**6 个页签**（颜色 / 字体 / 尺度 / 质感 / 代码 / 背景），亮暗各一份草稿。
 *
 * 编辑的是草稿（`draft`），保存才写盘 —— 否则每拖一下滑块都在 localStorage 里重写一份
 * 带 base64 背景图的配置，输入框会卡。顶部的预览条用同一份草稿内联变量渲染，所见即所得。
 *
 * 圆角 / 纹理这类**不在变量表里**的字段（`CustomColorTheme.radius` / `.texture`）在
 * 尺度 / 质感页签里编辑，保存时与 `vars` 一起交给 `updateCustom`。
 *
 * 背景是例外：选了素材就已经落盘（图片进 localStorage、视频进 IndexedDB），没法当草稿
 * 回滚，所以背景页签**即时生效**，点「取消」不会撤回。
 */
export function ThemeEditor({
  theme,
  background,
  onClose,
  onSave,
  onBackgroundChange
}: ThemeEditorProps) {
  const [mode, setMode] = useState<ThemeModeKey>('light')
  const [tab, setTab] = useState<ThemeEditorTab>('color')
  const [name, setName] = useState(theme.name)
  const [radius, setRadius] = useState(theme.radius)
  const [texture, setTexture] = useState<ThemeTexture>(theme.texture)
  const [vars, setVars] = useState<Record<ThemeModeKey, ThemeVars>>({
    light: { ...theme.vars.light },
    dark: { ...theme.vars.dark }
  })
  const tr = useT()
  const [error, setError] = useState<string | null>(null)

  const setVar = (varName: string, value: string): void => {
    setVars((current) => ({ ...current, [mode]: { ...current[mode], [varName]: value } }))
  }

  /**
   * 把当前页签涉及的变量恢复成默认主题的同名值（`readThemeVars` 从 CSS 读，
   * 不在 TS 里抄色板）。不在「默认主题」变量表里的键删掉，让 :root 兜底。
   */
  const handleResetTab = (): void => {
    if (tab === 'background') {
      if (!onBackgroundChange({ ...DEFAULT_THEME_BACKGROUND })) {
        setError(tr('存不下：本地存储已满，试试删掉几套自定义主题。'))
      }
      return
    }
    const defaults = readThemeVars('default', mode).vars
    const next: ThemeVars = { ...vars[mode] }
    for (const group of groupsOf(tab)) {
      for (const spec of group.vars) {
        const fallback = defaults[spec.name]
        if (fallback === undefined) delete next[spec.name]
        else next[spec.name] = fallback
      }
    }
    setVars((current) => ({ ...current, [mode]: next }))
    if (tab === 'scale') setRadius(0.875)
    if (tab === 'texture') setTexture('none')
  }

  const handleSave = (): void => {
    const ok = onSave({ name: name.trim() || tr('自定义主题'), radius, texture, vars })
    if (ok) onClose()
    else setError(tr('存不下：本地存储已满，试试删掉几套自定义主题或换张小一点的背景图。'))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/*
        宽度写成 `min(56rem, calc(100% - 2rem))`：`sm:max-w-4xl` 这类固定断点在 640~896px
        会顶掉基础类的 `max-w-[calc(100%-2rem)]`，弹窗直接贴屏幕两边（设置弹窗踩过）。
        用 min() 之后「最大 56rem」与「两边各留 16px」同时成立，也不用跟基础类的
        `sm:max-w-sm` 抢先后顺序。56rem 与设置弹窗同宽，套在上面不显得突兀。
      */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[min(56rem,calc(100%-2rem))]">
        <DialogHeader className="px-5 py-4">
          <DialogTitle>{tr('编辑主题')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-5">
          <div className="flex items-center gap-3">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={tr('主题名称')}
              className="h-9 max-w-56"
            />
            <Segmented
              ariaLabel={tr('明暗')}
              value={mode}
              onChange={setMode}
              options={MODES.map(({ key, label }) => ({ value: key, label }))}
            />
          </div>

          <ThemePreview vars={vars[mode]} radius={radius} texture={texture} />
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ThemeEditorTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex items-center px-5 py-2">
            <TabsList variant="line">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {tr(item.label)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* `@container`：列数按**弹窗自己的宽度**算，不按视口 —— 断点用 `sm:` 的话，
              弹窗被 `max-w` 卡在 56rem 时，再宽的屏幕也还是那几列。 */}
          <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <TabsContent value="color" className="mt-0">
              {groupsOf('color').map((group) => (
                <ColorGroup key={group.id} group={group} vars={vars[mode]} onChange={setVar} />
              ))}
            </TabsContent>

            <TabsContent value="font" className="mt-0 space-y-3">
              {groupsOf('font').map((group) => (
                <section key={group.id} className="space-y-2">
                  {group.vars.map((spec) => (
                    <div
                      key={spec.name}
                      className="rounded-md border border-border/50 px-2.5 py-2"
                    >
                      <div className="mb-1.5 flex items-baseline gap-2">
                        <span className="text-xs">{tr(spec.label)}</span>
                        <code className="font-mono text-[10px] text-muted-foreground">
                          {spec.name}
                        </code>
                      </div>
                      <Input
                        value={vars[mode][spec.name] ?? ''}
                        placeholder={tr('留空 = 跟随默认字体')}
                        onChange={(event) => setVar(spec.name, event.target.value)}
                        className="h-8 font-mono text-[11px]"
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </section>
              ))}
              {/* 预览直接吃草稿变量（只用到字体，不消费颜色），改一个字体立刻能看到 */}
              <div
                className="flex flex-wrap items-baseline gap-5 rounded-md border border-dashed border-border/60 px-3 py-2"
                style={{ ...vars[mode] } as CSSProperties}
              >
                <span className="font-sans text-sm">{tr('正文 Aa 你好')}</span>
                <span className="font-heading text-sm">{tr('标题 Aa 你好')}</span>
                <span className="font-mono text-xs">const theme = 1</span>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {tr('字体栈按 CSS 写法填（逗号分隔，可带引号）。留空回落到默认：正文系统无衬线、标题跟随正文、等宽用系统等宽字体。')}
              </p>
            </TabsContent>

            <TabsContent value="scale" className="mt-0 space-y-3">
              <NumberRow
                label={tr('字号倍率')}
                specName="--fizz-text-scale"
                value={Number(vars[mode]['--fizz-text-scale'] ?? 1)}
                onChange={setVar}
              />
              <NumberRow
                label={tr('界面密度')}
                specName="--fizz-density"
                value={Number(vars[mode]['--fizz-density'] ?? 1)}
                onChange={setVar}
              />
              <div className="rounded-md border border-border/50 px-2.5 py-3">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span>{tr('圆角')}</span>
                  <span className="font-mono text-muted-foreground">{radius.toFixed(3)} rem</span>
                </div>
                <Slider
                  min={0}
                  max={1.6}
                  step={0.125}
                  value={[radius]}
                  onValueChange={([next]) => setRadius(next ?? radius)}
                />
                <div className="mt-3 flex items-end gap-2">
                  {[0, 0.375, 0.875, 1.5].map((sample) => (
                    <span
                      key={sample}
                      aria-hidden
                      className="size-8 border border-border bg-secondary"
                      style={{ borderRadius: `${sample}rem` }}
                    />
                  ))}
                </div>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {tr('字号倍率只覆盖正文的 9 档字号（xs…5xl）；密度调的是全局间距基准。')}
              </p>
            </TabsContent>

            <TabsContent value="texture" className="mt-0 space-y-4">
              <section className="space-y-2">
                <NumberRow
                  label={tr('阴影强度')}
                  specName="--fizz-shadow-alpha"
                  value={Number(vars[mode]['--fizz-shadow-alpha'] ?? 1)}
                  onChange={setVar}
                />
                <div className="flex items-center justify-center rounded-md border border-border/50 bg-muted/40 px-3 py-6">
                  <div
                    className="grid size-24 place-items-center rounded-md border border-border bg-card text-[10px] text-muted-foreground"
                    style={{
                      boxShadow: `0 10px 15px -3px rgb(0 0 0 / ${(0.1 * Number(vars[mode]['--fizz-shadow-alpha'] ?? 1)).toFixed(3)})`
                    }}
                  >
                    {tr('阴影预览')}
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{tr('背景质感')}</h4>
                <Segmented
                  ariaLabel={tr('背景质感')}
                  value={texture}
                  onChange={setTexture}
                  options={THEME_TEXTURES}
                />
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {tr('纹理画在整个窗口的底色上，纯 CSS、不耗素材。配了背景图 / 视频的主题会以媒体为准，纹理自动让位。')}
                </p>
              </section>
            </TabsContent>

            <TabsContent value="code" className="mt-0">
              {groupsOf('code').map((group) => (
                <ColorGroup key={group.id} group={group} vars={vars[mode]} onChange={setVar} />
              ))}
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                {tr('这 8 个颜色驱动代码块（Shiki）与 Monaco 编辑器；保存后已打开的编辑器也会跟着刷新。')}
              </p>
            </TabsContent>

            <TabsContent value="background" className="mt-0">
              <ThemeBackgroundEditor
                background={background}
                onChange={onBackgroundChange}
                themeLabel={name.trim() || theme.name}
              />
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                {tr('背景改动即时生效（素材选中就要落盘，没法当草稿回滚），点「取消」不会撤回。')}
              </p>
            </TabsContent>
          </div>
        </Tabs>

        {/*
          `mx-0 mb-0` 是**必须的**：`DialogFooter` 自带的 `-mx-4 -mb-4` 是「假设
          `DialogContent` 用默认 `p-4`」的满宽出血写法；这个弹窗为了整条分隔线设了
          `p-0`，负边距就会把 footer 顶到弹窗外面 16px —— 表现就是按钮贴着下沿、
          圆角被切。把负边距归零、自己给 `px-5 py-4`，形状与 `HostDialog` 一致。
        */}
        <DialogFooter className="mx-0 mb-0 shrink-0 items-center px-5 py-4">
          <Button variant="ghost" size="sm" className="mr-auto" onClick={handleResetTab}>
            {tab === 'background' ? tr('清除背景') : tr('恢复默认')}
          </Button>
          {error && <p className="mr-auto text-xs text-destructive">{error}</p>}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {tr('保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 颜色类变量组（颜色页签与代码页签共用）：逐项取色 */
function ColorGroup({
  group,
  vars,
  onChange
}: {
  group: ThemeVarGroup
  vars: ThemeVars
  onChange: (varName: string, value: string) => void
}) {
  const tr = useT()
  return (
    <section className="mb-4 last:mb-0">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{tr(group.label)}</h4>
      <div className="grid gap-1.5 @md:grid-cols-2 @2xl:grid-cols-3">
        {group.vars.map((spec) => (
          <div
            key={spec.name}
            className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-xs">{tr(spec.label)}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {spec.name}
              </div>
            </div>
            <ColorPickerField
              value={vars[spec.name] ?? '#000000'}
              onChange={(hex) => onChange(spec.name, hex)}
              // 只有被标了 `alpha` 的项才给滑块：基础色走 `hsl(var(--x))`，
              // 8 位 hex 会让整条声明失效（见 `ThemeVarSpec.alpha` 的注释）
              allowAlpha={spec.alpha ?? false}
              swatchClassName="size-7"
            />
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * 数字变量一行（滑块 + 读数）：范围与步长从 `THEME_VAR_GROUPS` 的声明里查，
 * 写入前统一走 `clampThemeNumber`，与 `buildStyle()` 的校验同源。
 */
function NumberRow({
  label,
  specName,
  value,
  onChange
}: {
  label: string
  specName: string
  value: number
  onChange: (varName: string, value: string) => void
}) {
  const tr = useT()
  const spec = ALL_SPECS.find((item) => item.name === specName)
  const min = spec?.min ?? 0
  const max = spec?.max ?? 1
  const step = spec?.step ?? 0.01
  const current = Number.isFinite(value) ? value : 1
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/50 px-2.5 py-2">
      <span className="w-20 shrink-0 text-xs">{tr(label)}</span>
      <Slider
        className="max-w-64 flex-1"
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([next]) =>
          onChange(specName, clampThemeNumber(next ?? current, min, max, current))
        }
      />
      <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {spec?.unit === '×' ? `${current.toFixed(2)}×` : current.toFixed(2)}
      </span>
    </div>
  )
}

/** 顶部预览：直接用草稿变量 + 圆角 + 纹理内联渲染，改一项立刻能看到 */
function ThemePreview({
  vars,
  radius,
  texture
}: {
  vars: ThemeVars
  radius: number
  texture: ThemeTexture
}) {
  const tr = useT()
  return (
    <div
      className="rounded-lg border border-border p-3"
      style={
        {
          ...vars,
          '--radius': `${radius}rem`,
          backgroundColor: 'var(--background)',
          backgroundImage: 'var(--fizz-theme-texture, none)',
          backgroundSize: 'var(--fizz-texture-size, auto)',
          // 草稿里没有纹理这个「变量」，直接从枚举派生（与 buildStyle 同源）
          '--fizz-theme-texture': TEXTURE_CSS[texture],
          '--fizz-texture-size': TEXTURE_SIZE[texture]
        } as CSSProperties
      }
    >
      <div className="space-y-1.5 px-1">
        <p className="font-heading text-sm font-semibold text-foreground">{tr('标题：一套设计语法')}</p>
        <p className="font-sans text-xs text-muted-foreground">
          {tr('正文预览：字号、间距与配色都由当前草稿决定。')}
        </p>
        <p className="font-mono text-[11px]" style={{ color: 'var(--syntax-keyword)' }}>
          const theme = 'fizz'
        </p>
        <span className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-[11px] text-primary-foreground">
          {tr('主按钮')}
        </span>
      </div>
    </div>
  )
}
