import * as React from "react"
import { cn } from "cn"

/**
 * iOS 26 液态玻璃按钮：半透明材质 + 强磨砂 + 白色细描边 + 顶部高光 / 底部反光 +
 * 内侧镜面边 + 柔和外投影。
 *
 * ## 结构（改之前先读）
 *
 * - 最外层 `<button>` 只负责位置 / 尺寸 / 形状 / 事件，**不放描边与投影**。
 * - 中间那层是「整颗按钮」的缩放层（按下 `scale-90`）：描边、投影、材质、图标全在
 *   里面，按下时一起缩。描边留在外层就会变成「只有内部缩了」。
 * - 因此外层**不能 `overflow-hidden`**（投影会被裁掉）；内层用 `rounded-[inherit]`
 *   跟着外层的圆角走，换形状只改外层 `rounded-*`。
 * - 材质层用 `-z-10` + 外层 `isolate`：图标不用包 relative 也能压在材质上面。
 *
 * ## 按下态
 *
 * 不传 `pressed` 时跟随按钮自身的 `:active`（环形展开按钮这类普通点击就够了）；
 * 传了就是受控 —— 拖动中想「按住但别缩」必须传 `false`，`:active` 在整个拖动期间
 * 都是真的。
 *
 * ## `frosted`
 *
 * 拖动这类「每帧都在移动」的场景把磨砂关掉（`frosted={false}`）：`backdrop-filter`
 * 元素一移动，每帧都要重算它背后那一整块（压在终端画布上尤其贵）。关的**只是磨砂**，
 * 渐变、高光、描边、投影全留着 —— 玻璃感还在，只是透出原样的底色；别整层换成灰底，
 * 那会变成一颗灰色圆盘。
 */
export function LiquidGlassButton({
  pressed,
  selected = false,
  frosted = true,
  className,
  children,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  /** 受控按下态；不传则跟随按钮自身的 `:active` */
  pressed?: boolean
  /** 选中 / 激活：材质更亮、文字回到前景色 */
  selected?: boolean
  /** 是否启用磨砂（`backdrop-filter`）；拖动等频繁移动时传 false */
  frosted?: boolean
}) {
  return (
    <button
      type={type}
      className={cn(
        "group relative isolate rounded-full text-foreground/90 outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        selected && "text-foreground",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[inherit]",
          "border border-white/30",
          "shadow-[0_10px_28px_-10px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.55),inset_0_-1px_1px_rgba(255,255,255,0.12)]",
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
            "bg-gradient-to-b from-white/35 via-white/10 to-white/5",
            "transition-colors duration-150",
            frosted && "backdrop-blur-xl backdrop-saturate-150",
            !selected &&
              "group-hover:from-white/45 group-hover:via-white/20 group-hover:to-white/10 group-active:from-white/55",
            selected && "from-white/55 via-white/25 to-white/15"
          )}
        >
          {/* 顶部高光 / 底部反光：液态玻璃的「厚度」全在这两层（普通 filter，不吃 backdrop） */}
          <span className="absolute inset-x-[14%] top-[8%] h-[38%] rounded-full bg-gradient-to-b from-white/70 to-transparent blur-[2px]" />
          <span className="absolute inset-x-[20%] bottom-[10%] h-[20%] rounded-full bg-white/10 blur-[3px]" />
        </span>
        {children}
      </span>
    </button>
  )
}
