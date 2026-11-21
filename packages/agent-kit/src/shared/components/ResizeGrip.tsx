"use client";

/**
 * 拖拽条中间那颗「药丸」抓手：只做存在感，不参与拖拽计算，拖动时也**不做任何形变**。
 *
 * 桌面悬停淡入、拖动中固定不透明；触摸设备没有 hover，靠 `[@media(hover:none)]` 常显，
 * 否则完全看不出「这里能拖」。
 *
 * ⚠️ 形变试过两轮，都撤了，别再原处加回来：
 * 1. 随速度拉伸 + 越界滞后 —— 每帧写 DOM、得靠 rAF 自循环收敛，松手丢事件就留下僵尸循环；
 * 2. 按拖动方向弯曲 —— 小到看不见、大到抢戏，两次调小（11px → 6px → 3px）仍嫌多。
 *
 * 现在就是一根固定的 2 × 44 圆头短棒，只有显隐和淡主色跟着状态走。
 */
import { cn } from "@fizz/agent-kit/shared/lib/utils";

/** 静止时的长度（就是原来那条 SVG 线的可视长度） */
const GRIP_LEN = 44;

/**
 * 抓手本体。`axis` 决定朝向：`x` = 竖直分隔线（左右分栏 / 面板宽度），
 * `y` = 水平分隔线（上下分栏）。拖动中固定不透明 —— 指针早被捕获到热区外了，
 * 只靠 hover 会在拖动途中凭空消失。
 */
export function ResizeGrip({
  axis,
  dragging,
  className
}: {
  axis: "x" | "y";
  dragging: boolean;
  className?: string;
}) {
  const horizontal = axis === "x";

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current",
        // 底色走 `currentColor`，所以 color 和 background-color 都得过渡，否则淡入时闪一下
        "text-primary/40 transition-[color,background-color,opacity] duration-100 ease-out",
        "opacity-0 group-hover/resize:opacity-100",
        // 触摸设备没有 hover：热区上已经不画指示线了，抓手必须常显，否则完全看不出能拖
        "[@media(hover:none)]:opacity-100",
        dragging && "text-primary/70 opacity-100",
        // 尺寸恒定，只有朝向随轴换：竖线 2 宽 × 44 高，横线 44 宽 × 2 高
        // 粗细压到 2px：3px 在 1px 分隔线旁边显得像一条独立的条，2px 才是「提示这里有分隔线」
        horizontal ? "h-11 w-[2px]" : "w-11 h-[2px]",
        className
      )}
    />
  );
}
