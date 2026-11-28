/**
 * 「展开 / 折叠箭头」的统一外观：**平时隐形，鼠标悬停这一行本身才浮出来**；触屏常显。
 *
 * 三处共用 —— 工具卡（`ToolHeader`）、思考行（`ReasoningTrigger`）、过程折叠条
 * （`TurnStepGroup`）：各写一份迟早分叉，而这里有两条不看就会写错的前提：
 *
 * ⚠️ **必须用命名 group（`group/row`）**。消息气泡（`MessageContent`）自己就带了一个
 * 裸 `group`，而 `group-hover:` 生成的 `.group:hover .target` 匹配**任意祖先**的 `.group:hover` ——
 * 用裸 `group-hover:` 的结果是「鼠标停在消息任意位置，这一轮里所有箭头一起亮」，
 * 而不是「悬停哪一行亮哪一行」。所以变体统一写成 `group-hover/row:`，触发行也必须
 * 同时带 `group/row`（可以再叠一个裸 `group` 给 `group-data-panel-open` 那类旋转用）。
 *
 * ⚠️ **Tailwind v4 把 `hover:` / `group-hover:` 整个包进 `@media (hover: hover)`。**
 * 所以「基座 `opacity-0` + `group-hover/row:opacity-100`」在没有 hover 能力的设备上等于
 * **永远隐形** —— 手机 / 平板上完全看不出这一行能点开。必须补一条
 * `[@media(hover:none)]:opacity-100` 把它常显出来（`PanelTab` 的关闭钮踩过同一个坑）。
 *
 * ⚠️ 判据是**能力**（`hover: none`）不是视口宽度：大屏平板没有鼠标、窄窗口的触屏笔记本
 * 有鼠标，`max-md` / `useIsMobile()` 两头都会判错。
 *
 * ⚠️ 过渡写成 `transition-[transform,opacity]` 一个属性：箭头同时要「淡入」和「旋转」，
 * 拆成 `transition-opacity` + `transition-transform` 两条会被后者覆盖（同属
 * `transition-property`，tailwind-merge 只留最后一条）。
 *
 * 用法：`className={cn(REVEAL_ON_HOVER_ARROW, 'size-4 shrink-0 ...')}`。
 * **外层触发行必须带 `group/row`**，否则箭头永远不出现。
 *
 * 用 opacity 而不是条件渲染：保留占位，鼠标进出时整行宽度不跳。
 */
export const REVEAL_ON_HOVER_ARROW =
  'transition-[transform,opacity] opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 [@media(hover:none)]:opacity-100'

