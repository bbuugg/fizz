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
 * 元素一移动，每帧都要重算它背后那一整块（压在终端画布上尤其贵）。关的**只是磨砂**，
 * 玻璃色 / 斜向高光 / 描边 / 投影全留着 —— 别整层换成灰底。
 */
export function LiquidGlassButton({
  pressed,
  selected = false,
  frosted = true,
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
}) {
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

  const lensStyle = {
    padding: "1.5px",
    background:
      "radial-gradient(56px circle at var(--lens-x, 50%) var(--lens-y, 50%), rgba(255,255,255,0.95), rgba(255,255,255,0.7) 20%, rgba(255,255,255,0.1) 46%, rgba(255,255,255,0) 62%)",
    WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    maskComposite: "exclude",
    opacity: "var(--lens-opacity, 0)",
    mixBlendMode: "screen",
  } as React.CSSProperties

  return (
    <button
      type={type}
      className={cn(
        "group relative isolate rounded-full text-foreground/90 outline-none",
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
          // 1px 亮边 + 顶部镜面高光 + 柔和景深投影（ainav 的 --glass-rim / --glass-inner / --glass-shadow）
          "border border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_44px_-16px_rgba(15,23,42,0.24),0_2px_8px_rgba(15,23,42,0.06)]",
          "dark:border-white/20 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_20px_50px_-16px_rgba(0,0,0,0.62),0_2px_10px_rgba(0,0,0,0.3)]",
          "transition-transform duration-150 ease-out",
          pressed === undefined
            ? "group-active:scale-90"
            : pressed
              ? "scale-90"
              : "scale-100"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "-z-10 absolute inset-0 overflow-hidden rounded-[inherit]",
            // 斜向 140° 的玻璃色：亮色是有实感的奶白，暗色只留一层极淡的白洗
            "bg-[linear-gradient(140deg,rgba(255,255,255,0.74),rgba(255,255,255,0.44))]",
            "dark:bg-[linear-gradient(140deg,rgba(255,255,255,0.12),rgba(255,255,255,0.045))]",
            frosted && "backdrop-blur-[22px] backdrop-saturate-[180%]"
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
