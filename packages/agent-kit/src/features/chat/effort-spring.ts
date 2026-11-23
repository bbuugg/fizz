/**
 * 思考强度滑块的收尾曲线：**临界阻尼**弹簧（gsap 的 ease 接口）。
 *
 * 果冻形变（横向拉伸 / 倾斜）只在拖动时跟着手指走；松手或中途停住之后，形变
 * 必须一眼看出「停住了」——单调回正，不能自己来回晃。
 *
 * 旧版用的是欠阻尼弹簧（阻尼比 0.575），实测松手后 0.6s 内过冲两次
 * （`--effort-jelly-x` 1.14 → 0.984 → 1.00、`--effort-jelly-skew` +1.7° → −0.19° → 0）。
 * 临界阻尼（ratio = 1）的解析解是 `1 − e^(−ωt)(1 + ωt)`：单调、不过冲，ω 只决定快慢。
 */
export function criticallyDampedEase(
  stiffness: number,
  duration: number,
): (progress: number) => number {
  const omega = Math.sqrt(stiffness)
  return (progress: number): number => {
    if (progress <= 0) return 0
    if (progress >= 1) return 1
    const time = progress * duration
    return 1 - Math.exp(-omega * time) * (1 + omega * time)
  }
}