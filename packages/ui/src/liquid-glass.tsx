import * as React from "react"
import { cn } from "cn"

/**
 * 液态玻璃按钮 —— 配方对齐相邻项目 `ainav/web` 首页那套（`web/src/app/globals.css`
 * 的 `--glass-*` / `.glass-pill` / `.glass-sheen` / `.liquid-lens`）。
 *
 * ## 与旧版差在哪（这正是「不太像」的原因）
 *
 * 旧版是**竖向几乎全透明**的渐变（`from-white/35 via-white/10 to-white/5`）配一条
 * `white/30` 的描边和一圈很重的黑投影 —— 读起来像一颗「带白边的灰圆盘」，
 * 没有玻璃的厚度。ainav 那套的关键是四件东西同时到位：
 *
 * 1. **斜向 140° 的实色玻璃色**（亮色 0.74→0.44、暗色 0.12→0.045），不是竖向透明渐变；
 * 2. **1px 亮边 + `inset 0 1px 0` 的顶部镜面高光**，加柔和的景深投影；
 * 3. **132° 斜向高光扫过表面**（`.glass-sheen`）；
 * 4. **跟随指针的边缘光圈**（`.liquid-lens`）：只在非触摸指针下出现，
 *    `--lens-x/y` 由 `pointermove` 直接写在按钮上，无 rAF、无拖影。
 *
 * ## 结构（改之前先读）
 *
 * - 最外层 `<button>` 只负责位置 / 尺寸 / 形状 / 事件，**不放描边与投影**。
 * - 中间那层是「整颗按钮」的缩放层（按下 `scale-90`）：描边、投影、材质、图标全在
 *   里面，按下时一起缩；外层不能 `overflow-hidden`（投影会被裁掉），内层用
 *   `rounded-[inherit]` 跟着外层圆角走。
 * - 材质层 `-z-10` + 外层 `isolate`：图标不用包 relative 也能压在材质上面。
 *
 * ## `frosted`
 *
 * 拖动这类「每帧都在移动」的场景把磨砂关掉（`frosted={false}`）：`backdrop-filter`
 * 元素一移动，每帧都要重算它背后那一整块（压在终端画布上尤其贵）。
 *
 * ⚠️ 关磨砂时必须补一层**不透明底**（见下面 `!frosted` 的 `-z-20` 底色）：原来的玻璃色
 * 是半透明渐变，靠 `backdrop-filter` 才显得「有材质」；一去掉模糊，背后的终端文字直接
 * 透出来，看起来就像拖动时背景变透明了（用户反馈）。底色垫在玻璃渐变之下，
 * 高光 / 描边 / 投影仍然保留。
 */
/** 斜向玻璃色（亮色奶白 / 暗色极淡白洗），按钮与滑条共用 */
const GLASS_TINT =
  "bg-[linear-gradient(140deg,rgba(255,255,255,0.74),rgba(255,255,255,0.44))] dark:bg-[linear-gradient(140deg,rgba(255,255,255,0.12),rgba(255,255,255,0.045))]"

/**
 * 浅色背景上的玻璃色：纯白渐变在白色 popover / 顶栏上等于隐形，
 * 掺一点石板灰才看得出「这是一块玻璃」。暗色主题仍用原来的淡白洗。
 */
const GLASS_TINT_CONTRAST =
  "bg-[linear-gradient(140deg,rgba(100,116,139,0.26),rgba(100,116,139,0.1))] dark:bg-[linear-gradient(140deg,rgba(255,255,255,0.12),rgba(255,255,255,0.045))]"

/** 主操作（发送）：主色底 + 一层白色玻璃高光，保留 CTA 的强调但不变成实心块 */
const GLASS_TINT_ACCENT =
  "bg-primary bg-[linear-gradient(140deg,rgba(255,255,255,0.3),rgba(255,255,255,0.08))]"

/** 危险操作（停止）：破坏色底 + 同样的白色玻璃高光 */
const GLASS_TINT_DANGER =
  "bg-destructive bg-[linear-gradient(140deg,rgba(255,255,255,0.3),rgba(255,255,255,0.08))]"

/** 1px 亮边 + 顶部镜面高光 + 柔和景深投影（ainav 的 --glass-rim / --glass-inner / --glass-shadow） */
const GLASS_SHADOW =
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_44px_-16px_rgba(15,23,42,0.24),0_2px_8px_rgba(15,23,42,0.06)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_20px_50px_-16px_rgba(0,0,0,0.62),0_2px_10px_rgba(0,0,0,0.3)]"

const GLASS_RIM = `border border-white/70 dark:border-white/20 ${GLASS_SHADOW}`

/** 浅色背景用的描边：白边在白底上同样会消失，改用前景色的一层淡描边 */
const GLASS_RIM_CONTRAST = `border border-foreground/15 dark:border-white/20 ${GLASS_SHADOW}`

/** 主操作色块上的描边：用主色前景的淡描边，避免白边压不出边界 */
const GLASS_RIM_ACCENT = `border border-primary-foreground/30 dark:border-primary-foreground/25 ${GLASS_SHADOW}`

/** 危险色块上的描边：白色淡描边，与红色底拉开边界 */
const GLASS_RIM_DANGER = `border border-white/35 dark:border-white/25 ${GLASS_SHADOW}`

const GLASS_BLUR = "backdrop-blur-[22px] backdrop-saturate-[180%]"

/** 跟随指针的 1.5px 描边光圈（见 `.liquid-lens::before` 的配方） */
const LIQUID_LENS_RIM_STYLE: React.CSSProperties = {
  padding: "1.5px",
  background:
    "radial-gradient(56px circle at var(--lens-x, 50%) var(--lens-y, 50%), rgba(255,255,255,0.95), rgba(255,255,255,0.7) 20%, rgba(255,255,255,0.1) 46%, rgba(255,255,255,0) 62%)",
  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
  mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  maskComposite: "exclude",
  opacity: "var(--lens-opacity, 0)",
  mixBlendMode: "screen",
}

/** 指针下方的柔和扫光（`screen` 混合，只提亮、不遮内容） */
const LIQUID_LENS_SHEEN_STYLE: React.CSSProperties = {
  background:
    "radial-gradient(120px circle at var(--lens-x, 50%) var(--lens-y, 50%), rgba(255,255,255,0.5), rgba(255,255,255,0.18) 34%, rgba(255,255,255,0) 68%)",
  opacity: "var(--lens-opacity, 0)",
  mixBlendMode: "screen",
}

export function LiquidGlassButton({
  pressed,
  selected = false,
  frosted = true,
  tone = "default",
  className,
  children,
  type = "button",
  onPointerMove,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ComponentProps<"button"> & {
  /** 受控按下态；不传则跟随按钮自身的 `:active` */
  pressed?: boolean
  /** 选中 / 激活：材质更亮、文字回到前景色 */
  selected?: boolean
  /** 是否启用磨砂（`backdrop-filter`）；拖动等频繁移动时传 false */
  frosted?: boolean
  /**
   * 底色档位：`default` 适合压在深色内容上（终端悬浮球）；
   * `contrast` 给白色 popover / 顶栏用 —— 纯白玻璃在白底上会隐形。
   */
  tone?: "default" | "contrast" | "accent" | "danger"
}) {
  const tint =
    tone === "contrast"
      ? GLASS_TINT_CONTRAST
      : tone === "accent"
        ? GLASS_TINT_ACCENT
        : tone === "danger"
          ? GLASS_TINT_DANGER
          : GLASS_TINT
  const rim =
    tone === "contrast"
      ? GLASS_RIM_CONTRAST
      : tone === "accent"
        ? GLASS_RIM_ACCENT
        : tone === "danger"
          ? GLASS_RIM_DANGER
          : GLASS_RIM
  /** 指针位置 → CSS 变量（`.liquid-lens` 的配方）；触摸设备跳过，光圈是纯装饰 */
  const trackLens = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // 拖动中（`frosted={false}`）不要每帧读 getBoundingClientRect()：那是强制回流，
    // 会跟贴边动画抢帧；光圈本来也只是装饰
    if (!frosted || event.pointerType === "touch") return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    const style = event.currentTarget.style
    style.setProperty("--lens-x", `${x.toFixed(2)}%`)
    style.setProperty("--lens-y", `${y.toFixed(2)}%`)
    style.setProperty("--lens-opacity", "1")
  }

  const lensStyle = LIQUID_LENS_RIM_STYLE

  return (
    <button
      type={type}
      className={cn(
        "group relative isolate rounded-full text-foreground/90 outline-none",
        tone === "accent" && "text-primary-foreground",
        tone === "danger" && "text-white",
        "disabled:pointer-events-none disabled:opacity-50",
        selected && "text-foreground",
        className
      )}
      onPointerMove={(event) => {
        trackLens(event)
        onPointerMove?.(event)
      }}
      onPointerEnter={(event) => {
        trackLens(event)
        onPointerEnter?.(event)
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.setProperty("--lens-opacity", "0")
        onPointerLeave?.(event)
      }}
      {...props}
    >
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[inherit]",
          // 1px 亮边 + 顶部镜面高光 + 柔和景深投影（与滑条共用同一份材质）
          rim,
          "transition-transform duration-150 ease-out",
          pressed === undefined
            ? "group-active:scale-90"
            : pressed
              ? "scale-90"
              : "scale-100"
        )}
      >
        {/* 无磨砂时垫一层不透明底：玻璃渐变是半透明的，少了 backdrop-blur 会直接透出
            背后的终端内容（拖动时看起来像背景变透明）。垫在 `-z-10` 材质层之下。 */}
        {!frosted && (
          <span
            aria-hidden
            className="-z-20 absolute inset-0 rounded-[inherit] bg-white/95 dark:bg-zinc-800/95"
          />
        )}
        <span
          aria-hidden
          className={cn(
            "-z-10 absolute inset-0 overflow-hidden rounded-[inherit]",
            tint,
            frosted && GLASS_BLUR
          )}
          // Safari / Electron 的 WebKit 前缀 Tailwind 不自动补，显式给一份
          style={{
            WebkitBackdropFilter: frosted ? "blur(22px) saturate(180%)" : "none",
          }}
        >
          {/* 132° 斜向高光：玻璃的「厚度」全靠这层（普通渐变，不吃 backdrop-filter） */}
          <span className="absolute inset-0 bg-[linear-gradient(132deg,rgba(255,255,255,0.5),rgba(255,255,255,0.14)_26%,rgba(255,255,255,0)_52%)] dark:bg-[linear-gradient(132deg,rgba(255,255,255,0.16),rgba(255,255,255,0.05)_30%,rgba(255,255,255,0)_56%)]" />
          {/* 悬停 / 选中时整体提亮一点，与 ainav 的 .glass-hover 同款 */}
          <span
            className={cn(
              "absolute inset-0 bg-white/25 transition-opacity duration-150 dark:bg-white/10",
              selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-active:opacity-100"
            )}
          />
          {/* 跟随指针的边缘光圈：mask 只留 1.5px 边框环，screen 混合不遮内容 */}
          <span className="pointer-events-none absolute -inset-px rounded-[inherit] transition-opacity duration-200" style={lensStyle} />
        </span>
        {children}
      </span>
    </button>
  )
}

/**
 * 液态玻璃表面（非 button 用）：滑条这类「整块玻璃 + 跟随指针光圈」的容器。
 *
 * 与 `LiquidGlassButton` 共用同一份材质和光圈配方（`GLASS_*` / `LIQUID_LENS_*`），
 * 差别只在外层是 `div`、按 `className` 决定圆角。内容放 `children`，
 * 两层扫光 / 光圈由本组件追加，消费方不要重复画。
 */
export function LiquidGlassSurface({
  className,
  children,
  tone = "default"
}: {
  className?: string
  children: React.ReactNode
  /** 底色档位：白色 popover / 顶栏上用 `contrast`，主操作上用 `accent` */
  tone?: "default" | "contrast" | "accent"
}) {
  const tint =
    tone === "contrast" ? GLASS_TINT_CONTRAST : tone === "accent" ? GLASS_TINT_ACCENT : GLASS_TINT
  const rim =
    tone === "contrast" ? GLASS_RIM_CONTRAST : tone === "accent" ? GLASS_RIM_ACCENT : GLASS_RIM
  return (
    <div
      className={cn(
        "relative isolate rounded-full text-foreground/90",
        tone === "accent" && "text-primary-foreground",
        tint,
        rim,
        GLASS_BLUR,
        className
      )}
      onPointerMove={(event) => {
        // 触摸设备没有「指向」，光圈是纯装饰
        if (event.pointerType === "touch") return
        const rect = event.currentTarget.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const style = event.currentTarget.style
        style.setProperty(
          "--lens-x",
          `${(((event.clientX - rect.left) / rect.width) * 100).toFixed(2)}%`
        )
        style.setProperty(
          "--lens-y",
          `${(((event.clientY - rect.top) / rect.height) * 100).toFixed(2)}%`
        )
        style.setProperty("--lens-opacity", "1")
      }}
      onPointerLeave={(event) => event.currentTarget.style.setProperty("--lens-opacity", "0")}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-200 ease-out"
        style={LIQUID_LENS_SHEEN_STYLE}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[inherit] transition-opacity duration-200 ease-out"
        style={LIQUID_LENS_RIM_STYLE}
      />
    </div>
  )
}
