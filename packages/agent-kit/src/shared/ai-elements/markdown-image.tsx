/**
 * Markdown 正文里 `<img>` 的替换渲染：**点击开全屏查看器** + 悬浮下载按钮。
 *
 * Streamdown 2.x 自带的图片控件只有「下载」，没有点击放大（见 lib/streamdown.ts），所以这里
 * 用 `components.img` 接管渲染。放大 / 缩放 / 旋转 / 平移交给共享的 `ImageViewer`（底部悬浮
 * 工具条，见 shared/ui/image-viewer）—— 与文件面板里的图片预览是同一个组件。
 *
 * 与本项目相关的几处取舍：
 * - **加载点阵**：聊天里的图大量是外链（有时几百 KB），不占位的话正文会先贴上去、
 *   图再「啪」地冒出来把下面一段话顶走。所有状态共用固定高度预览框，
 *   图片等比完整显示，`onLoad` 只切换透明度、不改变布局。顺带处理 `onError`：
 *   显示失败占位 + 原地重试（自增 nonce 强制 `<img>` 重挂，浏览器重新发一次请求）。
 * - 下载按钮放在图片外层（`absolute` 右下角），点它不会触发查看器打开（查看器由 img 自己的
 *   onClick 打开，按钮不是 img 的一部分）。
 * - 点图开查看器用的是受控 `ImageViewer`，它 portal 到 body，不受消息列表滚动容器与 z-index
 *   牵扯（原来那套包里也踩过「幽灵图」定位锚点的坑，自建后没有了）。
 */
import { useEffect, useState, type ComponentProps } from 'react'
import { Download, ImageOff, RotateCw } from 'lucide-react'
import { ImageLoadingGrid } from '@fizz/agent-kit/shared/ai-elements/image-loading-grid'
import { ImageViewer } from '@fizz/ui/image-viewer'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { saveImageLocally } from '@fizz/agent-kit/shared/lib/image-download'
import { fetchServerScreenshot, isServerScreenshotUrl } from '@fizz/agent-kit/shared/lib/media-url'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/**
 * 下载图片：blob 往返由 `saveImageLocally` 统一做（与消息附件的下载同一份实现）。
 *
 * 拉不到时退化成**打开原图**（消息里的图大量是外链，跨域限制下这条路至少还能让用户
 * 右键另存）。桌面端截图那份字节已经预取好了，不走兜底 —— 那时打开 `blob:` 也没有意义。
 */
async function downloadImage(src: string, alt: string | undefined, screenshot?: Blob): Promise<void> {
  try {
    await saveImageLocally(src, { name: alt, blob: screenshot })
  } catch {
    if (!screenshot) window.open(src, '_blank', 'noopener')
  }
}

export function MarkdownImage({ src, alt, className }: ComponentProps<'img'>) {
  const tr = useT()
  const source = typeof src === 'string' ? src : ''
  const desktopScreenshot =
    isServerScreenshotUrl(source) && getAgentHostOrNull()?.capabilities.localServer
  // 下载中去抖：blob 往返期间禁掉按钮，免得连点叠出多个下载
  const [downloading, setDownloading] = useState(false)
  /** 全屏查看器开关：点图打开 */
  const [zoomOpen, setZoomOpen] = useState(false)
  /**
   * 加载态。`src` 一起存进来：图片流式渲染时 src 会被补全/换掉（同一节点复用），
   * 按 React 官方推荐的做法在**渲染期**比对并重置，而不是写 effect 去同步状态。
   */
  const [load, setLoad] = useState<{
    src: string
    nonce: number
    status: 'loading' | 'loaded' | 'error'
  }>({ src: '', nonce: 0, status: 'loading' })
  /** 强制重新请求的钥匙（失败后点「重试」自增 → <img> 重挂，浏览器重新发一次请求） */
  const [nonce, setNonce] = useState(0)
  const [screenshot, setScreenshot] = useState<{
    src: string
    nonce: number
    url: string
    blob: Blob
  } | null>(null)

  useEffect(() => {
    setScreenshot(null)
    if (!desktopScreenshot) return
    let alive = true
    let objectUrl = ''
    void fetchServerScreenshot(source)
      .then((blob) => {
        if (!alive) return
        objectUrl = URL.createObjectURL(blob)
        setScreenshot({ src: source, nonce, url: objectUrl, blob })
      })
      .catch(() => {
        if (alive) setLoad({ src: source, nonce, status: 'error' })
      })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source, nonce, desktopScreenshot])

  // React 的 img src 是可选的；没有源就什么都不渲染（Streamdown 默认会渲染一个坏图占位）
  if (!source) return null
  if (load.src !== source || load.nonce !== nonce) {
    setLoad({ src: source, nonce, status: 'loading' })
  }
  const status = load.src === source && load.nonce === nonce ? load.status : 'loading'
  const currentScreenshot = screenshot?.src === source && screenshot.nonce === nonce ? screenshot : null
  const displayedSrc = desktopScreenshot ? currentScreenshot?.url : source
  const retry = (): void => {
    setLoad({ src: source, nonce: nonce + 1, status: 'loading' })
    setNonce((n) => n + 1)
  }
  const download = (): void => {
    if (desktopScreenshot && !currentScreenshot) return
    setDownloading(true)
    void downloadImage(source, alt, currentScreenshot?.blob).finally(() => setDownloading(false))
  }

  return (
    // 外壳：group 给下载按钮做悬浮显隐，relative 是包里「幽灵图」的定位锚点
    // （它的 top/left 取自图片的 offsetTop/offsetLeft，两者必须落在同一个定位祖先上）。
    // inline-block 让点击热区贴着图片本身 —— 早先用 block 包裹，整段文字宽度都成了可点区。
    // 固定框不随图片固有尺寸 / 加载状态变化，避免消息列表重算高度而闪动。
    <span
      data-message-image=""
      className={cn(
        'group relative my-1 inline-block h-60 w-64 max-w-full align-top'
      )}
    >
      {/* 点阵覆盖固定预览框；图片仍留在 DOM 中完成加载。 */}
      {status === 'loading' && <ImageLoadingGrid />}

      {status === 'error' && (
        // 失败不留一块空白：说清是外链挂了，给一个原地重试
         <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-4 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <ImageOff className="size-3.5" />
            {tr('图片加载失败')}
          </span>
          <span className="max-w-full truncate">{source}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              retry()
            }}
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-foreground hover:bg-foreground/5"
          >
            <RotateCw className="size-3" />
            {tr('重试')}
          </button>
        </span>
      )}

      <img
        key={nonce}
        referrerPolicy="no-referrer"
        src={displayedSrc}
        alt={alt ?? ''}
        loading="lazy"
        onClick={() => setZoomOpen(true)}
        onLoad={(e) => {
          if (e.currentTarget.getAttribute('src') === displayedSrc) {
            setLoad({ src: source, nonce, status: 'loaded' })
          }
        }}
        onError={(e) => {
          if (e.currentTarget.getAttribute('src') === displayedSrc) {
            setLoad({ src: source, nonce, status: 'error' })
          }
        }}
        className={cn(
          className,
          'absolute inset-0 block h-full max-h-full w-full max-w-full rounded-lg object-contain transition-opacity duration-200',
          // 图片始终留在固定框内，加载 / 失败时只隐藏绘制。
          status === 'loaded'
            ? 'cursor-zoom-in opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />

      {/* 下载按钮：贴着 Streamdown 自带图片控件的样式与位置（右下角 h-8 药丸），
          data 属性给 globals.css 里「触屏没有 hover → 常驻显示」那条规则做锚点。 */}
      {status !== 'error' && (
        <button
          type="button"
          data-md-img-download=""
          title={tr('下载图片')}
          aria-label={tr('下载图片')}
          disabled={downloading || (desktopScreenshot && !currentScreenshot)}
          onClick={(e) => {
            e.stopPropagation()
            download()
          }}
          className="absolute right-2 bottom-2 flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-200 hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-default"
        >
          <Download size={14} />
        </button>
      )}

      {/* 全屏查看器（portal 到 body）：图片本体只负责显示，缩放 / 旋转 / 平移全在工具条里 */}
      <ImageViewer
        src={displayedSrc ?? ''}
        alt={alt}
        open={zoomOpen}
        onOpenChange={setZoomOpen}
        onDownload={download}
      />
    </span>
  )
}
