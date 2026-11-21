/**
 * Dissolve 上传瓦片：72px 圆角卡片在上传时由颗粒逐颗拼合，完成才露出右上的移除钮；
 * 取消（上传中点瓦片）/ 移除（右上叉）/ 失败（抖动 + 染红）都以颗粒散开收场。
 *
 * 效果照搬 https://leibox.pantoria.cn/docs/animations/upload-tile（dissolve-ui@0.0.6，
 * MIT，见 `dissolve-engine.ts` 头部声明）。这里只做 React 世界与 canvas 之间那层控制器：
 * React 侧建 / 更新 / 销毁，动画全在这一层，避免每次进度回调都重渲染整块输入区。
 */
import {
  CALM,
  CALM_CSS,
  GRAIN,
  PIXEL_RATIO,
  WINDOW,
  clamp,
  createMotionValue,
  createScope,
  fitText,
  formatBytes,
  grainField,
  haptic,
  playDissolve,
  prefersReducedMotion,
  roundRect,
  snapshotCanvas,
  type DissolveHandle,
  type MotionValue
} from './dissolve-engine'

export const TILE_SIZE = 72
const PAD = 6
export const TILE_OUT = TILE_SIZE + PAD * 2
const CROSS_IN = 220
const OPEN = 300

const DOC_PATH = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5'
const X_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>'

/**
 * 样式只注入一次。颜色一律走 `--dissolve-*` 主题变量（由调用方把 Fizz 的设计令牌
 * 映射进来），所以亮 / 暗 / 各套主题都跟着走，不在 canvas 里写死颜色。
 */
const CSS = `
[data-dissolve="upload-tile"] { position: relative; flex: none; }
.dissolve-upload-box { position: absolute; left: 0; top: 0; box-sizing: border-box; }
.dissolve-upload-box[role="button"] { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.dissolve-upload-box:focus-visible { outline: 2px solid var(--dissolve-accent, rgb(37 99 235)); outline-offset: -2px; border-radius: 22px; }
.dissolve-upload-spot { position: absolute; border-radius: 16px; box-shadow: inset 0 0 0 1px var(--dissolve-border, rgb(0 0 0 / 0.12)); pointer-events: none; }
.dissolve-upload-face { display: block; border-radius: 16px; background: var(--dissolve-surface-2, #e8e8ec); }
.dissolve-upload-cross:focus-visible { outline: 2px solid var(--dissolve-accent, rgb(37 99 235)); outline-offset: 2px; }
.dissolve-upload-asm { position: absolute; left: 0; top: 0; display: block; pointer-events: none; }
`

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('dissolve-upload-tile')) return
  const style = document.createElement('style')
  style.id = 'dissolve-upload-tile'
  style.textContent = CSS
  document.head.appendChild(style)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  html = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html) node.innerHTML = html
  return node
}

function token(node: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(node).getPropertyValue(`--dissolve-${name}`).trim() || fallback
}

function fontOf(node: HTMLElement): string {
  return getComputedStyle(node).fontFamily || 'system-ui, sans-serif'
}

export type DissolveTileStatus = 'uploading' | 'done' | 'failed'

export interface DissolveTileFile {
  id: string
  name: string
  /** 字节数；历史回显的附件没有这个字段（只画文件名） */
  size?: number
  /** 可直接使用的缩略图地址（data:/blob:/http(s)/已解析的服务端地址） */
  uri?: string
}

export interface DissolveTileLabels {
  remove: string
  uploading: string
  failed: string
}

export interface DissolveTileProps {
  file: DissolveTileFile
  status: DissolveTileStatus
  /** 0..1 */
  progress?: number
  /** 瓦片之间的额外间距（px）：加到宿主宽度里，由 CSS 过渡带出「长出来」的入场 */
  spacing?: number
  labels: DissolveTileLabels
  /** 散开动画结束后才回调（调用方在这里把附件从状态里删掉） */
  onRemove: () => void
  /** 上传中点击瓦片：先中断网络请求（不动状态），动画收场后再由 onRemove 删除 */
  onCancel: () => void
  /**
   * 开始退场（散开动画刚起、条目还没从列表删掉）。
   *
   * 给「最后一条」用：外层附件行可以在这时就折叠自己的高度 —— 颗粒是在 fixed 覆盖层上
   * 飞的，不会被裁掉；等 onRemove 再收就晚了一整段动画，行会先留一条空白再突然塌。
   */
  onLeave?: () => void
}

export interface DissolveTileController {
  update(next: DissolveTileProps): void
  destroy(): void
}

export function createDissolveTile(
  host: HTMLElement,
  initial: DissolveTileProps
): DissolveTileController {
  injectStyle()
  let props = initial
  const sc = createScope()
  const file = props.file
  const TILE = TILE_SIZE
  const OUT = TILE_OUT
  const reduce = (): boolean => prefersReducedMotion()
  let image: HTMLImageElement | null = null
  let bad = false
  let whole = false
  let phase: 'enter' | 'uploading' | 'done' | 'failed' | 'gone' = 'enter'
  let settling = false
  let burst: DissolveHandle | null = null
  const isGone = (): boolean => phase === 'gone'

  host.dataset.dissolve = 'upload-tile'
  host.setAttribute('role', 'listitem')
  Object.assign(host.style, { width: '0px', height: `${OUT}px` })

  const box = el('div', 'dissolve-upload-box')
  Object.assign(box.style, { width: `${OUT}px`, height: `${OUT}px`, padding: `${PAD}px` })
  box.setAttribute('aria-label', file.name)

  const spot = el('div', 'dissolve-upload-spot')
  Object.assign(spot.style, {
    left: `${PAD}px`,
    top: `${PAD}px`,
    width: `${TILE}px`,
    height: `${TILE}px`
  })

  const face = el('canvas', 'dissolve-upload-face')
  face.width = face.height = Math.round(TILE * PIXEL_RATIO)
  Object.assign(face.style, { width: `${TILE}px`, height: `${TILE}px`, opacity: '0' })
  const faceCtx = face.getContext('2d')!

  const asm = el('canvas', 'dissolve-upload-asm')
  asm.width = asm.height = Math.round(OUT * PIXEL_RATIO)
  Object.assign(asm.style, { width: `${OUT}px`, height: `${OUT}px` })
  const asmCtx = asm.getContext('2d')!

  const cross = el('button', 'dissolve-upload-cross', X_ICON)
  cross.type = 'button'
  cross.tabIndex = -1
  Object.assign(cross.style, {
    position: 'absolute',
    right: '0',
    top: '0',
    width: '20px',
    height: '20px',
    padding: '0',
    border: '0',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    opacity: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    background: 'var(--dissolve-primary, #1c1c1e)',
    color: 'var(--dissolve-primary-foreground, #fff)'
  })
  face.setAttribute('aria-hidden', 'true')
  asm.setAttribute('aria-hidden', 'true')

  box.append(spot, face, asm, cross)
  host.append(box)

  function decorate(): void {
    cross.setAttribute('aria-label', props.labels.remove)
    box.setAttribute('aria-label', phase === 'uploading' ? props.labels.uploading : file.name)
  }

  function radius(): number {
    return parseFloat(getComputedStyle(face).borderTopLeftRadius) || 0
  }

  function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number): void {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const sw = w / scale
    const sh = h / scale
    ctx.drawImage(
      img,
      (img.naturalWidth - sw) / 2,
      (img.naturalHeight - sh) / 2,
      sw,
      sh,
      0,
      0,
      w,
      h
    )
  }

  /** 预绘制整张瓦片：图片铺满；没有图片时画文件图标 + 扩展名 + 截断的文件名 + 大小 */
  function paintFace(): void {
    const ctx = faceCtx
    const T = TILE
    const font = fontOf(host)
    const color = (name: string, fallback: string): string => token(host, name, fallback)
    ctx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0)
    ctx.clearRect(0, 0, T, T)
    ctx.save()
    roundRect(ctx, 0, 0, T, T, radius())
    ctx.clip()
    if (image) {
      cover(ctx, image, T, T)
    } else {
      const bg = getComputedStyle(face).backgroundColor
      ctx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : color('surface-2', '#e8e8ec')
      ctx.fillRect(0, 0, T, T)
      const muted = color('muted', '#8e8e93')
      ctx.strokeStyle = muted
      ctx.lineWidth = 1.4
      ctx.lineJoin = 'round'
      ctx.save()
      ctx.translate(8, 8)
      ctx.scale(20 / 24, 20 / 24)
      ctx.stroke(new Path2D(DOC_PATH))
      ctx.restore()
      ctx.fillStyle = muted
      ctx.font = `700 9px ${font}`
      ctx.fillText((file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase(), 31, 21.5)
      ctx.fillStyle = color('foreground', '#1c1c1e')
      ctx.font = `600 11px ${font}`
      ctx.fillText(fitText(ctx, file.name, T - 16), 8, T - 20)
      if (file.size != null) {
        ctx.fillStyle = muted
        ctx.font = `400 10px ${font}`
        ctx.fillText(formatBytes(file.size), 8, T - 8)
      }
    }
    if (bad) {
      const danger = color('danger', '#ff3b30')
      ctx.fillStyle = danger
      ctx.globalAlpha = 0.16
      ctx.fillRect(0, 0, T, T)
      ctx.globalAlpha = 1
      ctx.strokeStyle = danger
      ctx.lineWidth = 1.5
      roundRect(ctx, 0.75, 0.75, T - 1.5, T - 1.5, Math.max(0, radius() - 0.75))
      ctx.stroke()
    }
    ctx.restore()
  }

  const field = grainField(TILE)

  /** 按进度把脸部的颗粒逐颗「落」到瓦片上；进度越高，左侧先亮、右侧随后 */
  function drawAsm(progress: number): void {
    const physical = GRAIN * PIXEL_RATIO
    const data = field.data
    const n = field.n
    asmCtx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0)
    asmCtx.clearRect(0, 0, OUT, OUT)
    for (let i = 0; i < n * n; i++) {
      const k = i * 5
      const t = clamp((progress - data[k + 2]) / WINDOW)
      if (t <= 0) continue
      const e = 1 - (1 - t) ** 3
      const w = e * GRAIN
      const cx = PAD + data[k] + data[k + 3] * (1 - e)
      const cy = PAD + data[k + 1] + data[k + 4] * (1 - e)
      asmCtx.drawImage(
        face,
        (i % n) * physical,
        ((i / n) | 0) * physical,
        physical,
        physical,
        cx - w / 2,
        cy - w / 2,
        w,
        w
      )
    }
  }

  /**
   * 拼合进度（0..1）：**带时间下限的追赶**。
   *
   * 为什么不按参考 demo 那样「每个进度事件起一段补间」：真实上传的事件粒度很粗 ——
   * 小文件往往只有 0 和 100 两个点，desktop 更是只在完成时补一次 100。按事件起补间的话
   * 一步就跳到整张，颗粒拼合根本看不见。这里维护一个目标值，画面按「整张至少 FILL_MS
   * 填完」的速度追过去：秒传也会完整播放一次拼合，慢上传则跟着真实进度走。
   */
  const FILL_MS = 900
  let shown = 0
  let target = 0
  let chaseId: number | null = null
  let lastFrame = 0
  const fillWaiters: Array<() => void> = []
  const resolveFillWaiters = (): void => {
    while (fillWaiters.length) fillWaiters.shift()!()
  }

  function paintProgress(): void {
    if (whole) return
    const plain = reduce()
    face.style.opacity = plain ? (0.15 + 0.85 * shown).toFixed(3) : '0'
    asm.style.visibility = plain ? 'hidden' : ''
    if (!plain) drawAsm(shown)
  }

  function chaseTick(now: number): void {
    chaseId = null
    if (!sc.alive || phase === 'gone') return
    const dt = Math.max(0, Math.min(100, now - lastFrame))
    lastFrame = now
    if (reduce()) {
      shown = target
    } else if (shown < target - 1e-3) {
      // 下限 = 整张 FILL_MS；上限不设，追赶项让「目标突然拉满」时前段走得快一点
      const floor = dt / FILL_MS
      const catchUp = (target - shown) * Math.min(1, dt / 220)
      shown = Math.min(target, shown + Math.max(floor, catchUp))
    }
    paintProgress()
    if (shown < target - 1e-3) {
      chaseId = sc.raf(chaseTick)
    } else {
      shown = target
      paintProgress()
      resolveFillWaiters()
    }
  }

  function kickChase(): void {
    if (chaseId != null || !sc.alive || phase === 'gone') return
    lastFrame = performance.now()
    chaseId = sc.raf(chaseTick)
  }

  /** 等到当前目标填完（`complete` 用它决定何时露出整张 / 移除钮） */
  function fillDone(): Promise<void> {
    if (shown >= target - 1e-3) return Promise.resolve()
    return new Promise<void>((resolve) => fillWaiters.push(resolve))
  }

  const crossIn: MotionValue = createMotionValue(sc, 0, () => {
    cross.style.opacity = crossIn.v.toFixed(3)
    cross.style.transform = reduce() ? '' : `scale(${(0.6 + 0.4 * crossIn.v).toFixed(3)})`
  })

  /** 把颗粒补到整张（进度 100%），并撤掉「拼合中」的描边 */
  async function complete(): Promise<void> {
    if (whole || phase === 'gone') return
    settling = true
    target = 1
    kickChase()
    await fillDone()
    if (!sc.alive || isGone()) return
    whole = true
    spot.remove()
    face.style.opacity = '1'
    asm.style.visibility = 'hidden'
  }

  async function close(wait?: Promise<unknown>): Promise<void> {
    host.style.width = '0px'
    await Promise.all([sc.wait(reduce() ? 150 : OPEN), wait])
    if (sc.alive) props.onRemove()
  }

  async function leave(
    preset: 'dust' | 'snap',
    origin?: { x: number; y: number }
  ): Promise<void> {
    if (phase === 'gone') return
    phase = 'gone'
    resolveFillWaiters()
    props.onLeave?.()
    box.removeAttribute('role')
    box.tabIndex = -1
    cross.style.pointerEvents = 'none'
    cross.tabIndex = -1
    if (reduce()) {
      box.style.visibility = 'hidden'
      return close()
    }
    const rect = box.getBoundingClientRect()
    const source = whole
      ? snapshotCanvas(OUT, OUT, (ctx) => ctx.drawImage(face, PAD, PAD, TILE, TILE))
      : snapshotCanvas(OUT, OUT, (ctx) => ctx.drawImage(asm, 0, 0, OUT, OUT))
    box.style.visibility = 'hidden'
    burst = playDissolve({
      source,
      x: rect.left,
      y: rect.top,
      w: OUT,
      h: OUT,
      preset,
      origin,
      duration: preset === 'snap' ? 900 : 1100,
      grain: 2
    })
    await close(burst.done)
  }

  async function reject(): Promise<void> {
    if (phase === 'gone' || phase === 'failed') return
    phase = 'failed'
    box.removeAttribute('role')
    box.tabIndex = -1
    await complete()
    if (!sc.alive || isGone()) return
    // 三次抖动：比弹一个红色 toast 更能说明「这一张不行」
    const shake = box.animate(
      [0, 6, -6, 0, 6, -6, 0, 6, -6, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: reduce() ? 1 : 240 }
    )
    sc.onDispose(() => shake.cancel())
    await shake.finished.catch(() => {})
    if (!sc.alive || isGone()) return
    bad = true
    paintFace()
    haptic([20, 60, 20])
    host.setAttribute('aria-label', props.labels.failed)
    await sc.wait(260)
    if (sc.alive) void leave('dust')
  }

  function markDone(): void {
    if (phase === 'done' || phase === 'gone') return
    phase = 'done'
    box.removeAttribute('role')
    box.tabIndex = -1
    box.setAttribute('aria-label', file.name)
    cross.tabIndex = 0
    cross.style.visibility = 'visible'
    cross.style.pointerEvents = 'auto'
    void crossIn.to(1, reduce() ? 150 : CROSS_IN, CALM)
    haptic([10, 40, 18])
  }

  async function settleToDone(): Promise<void> {
    await complete()
    if (!sc.alive || phase === 'gone') return
    markDone()
  }

  function setProgress(value: number): void {
    if (phase !== 'uploading' || settling) return
    const next = clamp(value)
    if (!Number.isFinite(next) || next <= target) return
    target = next
    kickChase()
  }

  function cancel(origin: { x: number; y: number }): void {
    if (phase !== 'uploading') return
    props.onCancel()
    haptic(6)
    void leave('snap', origin)
  }

  /** 缩略图是异步来的：先按占位（文件图标）上屏，图片到了再重画一遍 */
  async function loadImage(uri: string | undefined): Promise<void> {
    if (!uri) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = uri
    await Promise.race([
      img.decode().then(
        () => {
          image = img
        },
        () => {}
      ),
      sc.wait(1500)
    ])
    if (!sc.alive || image !== img) return
    paintFace()
    paintProgress()
  }

  const onBoxClick = (event: MouseEvent): void => {
    const rect = box.getBoundingClientRect()
    const scale = rect.width / OUT || 1
    cancel({
      x: clamp((event.clientX - rect.left) / scale, 0, OUT),
      y: clamp((event.clientY - rect.top) / scale, 0, OUT)
    })
  }
  const onBoxKey = (event: KeyboardEvent): void => {
    if (phase !== 'uploading' || event.target !== box) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      cancel({ x: OUT / 2, y: OUT / 2 })
    }
  }
  const onCross = (event: MouseEvent): void => {
    event.stopPropagation()
    if (phase !== 'done') return
    haptic(6)
    void leave('snap', { x: OUT - 10, y: 10 })
  }
  box.addEventListener('click', onBoxClick)
  box.addEventListener('keydown', onBoxKey)
  cross.addEventListener('click', onCross)

  async function start(): Promise<void> {
    paintFace()
    paintProgress()
    await new Promise<void>((resolve) => sc.raf(() => resolve()))
    if (!sc.alive) return
    host.style.transition = `width ${reduce() ? 150 : OPEN}ms ${CALM_CSS}`
    host.style.width = `${OUT + (props.spacing ?? 0)}px`
    void loadImage(file.uri)
    await sc.wait(260)
    if (!sc.alive || phase === 'gone') return
    if (props.status === 'failed') {
      void reject()
      return
    }
    if (props.status === 'done') {
      void settleToDone()
      return
    }
    if (phase !== 'enter') return
    phase = 'uploading'
    box.tabIndex = 0
    box.setAttribute('role', 'button')
    decorate()
    setProgress(props.progress ?? 0)
  }

  decorate()

  // 主题切换（含亮 / 暗）要重画：canvas 里的颜色是绘制那一刻取的
  const themeObserver = new MutationObserver(() => {
    paintFace()
    paintProgress()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  })
  sc.onDispose(() => themeObserver.disconnect())
  sc.onDispose(resolveFillWaiters)

  const media = matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', paintProgress)
  sc.onDispose(() => media.removeEventListener('change', paintProgress))

  void start()

  return {
    update(next) {
      const prev = props
      props = next
      if (
        (next.spacing ?? 0) !== (prev.spacing ?? 0) &&
        phase !== 'gone' &&
        host.style.width !== '0px'
      ) {
        host.style.width = `${OUT + (next.spacing ?? 0)}px`
      }
      if (next.file.uri !== prev.file.uri) {
        if (next.file.uri) void loadImage(next.file.uri)
        else {
          image = null
          paintFace()
          paintProgress()
        }
      }
      if (next.status !== prev.status) {
        if (next.status === 'failed' && (phase === 'uploading' || phase === 'enter')) {
          void reject()
        } else if (next.status === 'done' && phase === 'uploading') {
          void settleToDone()
        }
      }
      if (next.status === 'uploading' && phase === 'uploading') {
        setProgress(next.progress ?? 0)
      }
    },
    destroy() {
      sc.dispose()
      burst?.cancel()
      box.remove()
      delete host.dataset.dissolve
      host.removeAttribute('role')
      host.removeAttribute('aria-label')
      for (const key of ['width', 'height', 'transition']) host.style.removeProperty(key)
    }
  }
}

/** 供调用方判断是否需要滚动到末尾时用（与 CSS 的 `OPEN` 同步） */
export const TILE_OPEN_MS = OPEN
