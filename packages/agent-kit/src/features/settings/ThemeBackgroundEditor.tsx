/**
 * 主题背景（图片 / 视频）编辑器 —— 内置主题的「背景」弹窗与主题编辑器**共用同一份**。
 *
 * 只做「选素材 + 摆法」：怎么存（图片压成 data URL 进 localStorage、视频原样进
 * IndexedDB）是内部实现，不该让用户先做「我要传图还是视频」的选择题。
 *
 * `onChange` 返回 false = 没写进去（多半是 localStorage 配额满），这里直接给提示；
 * 调用方只需要把 patch 落到「目标主题」上（`setBackground(themeId, patch)`）。
 */
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Upload, X } from 'lucide-react'
import {
  getBackgroundVideo,
  type BackgroundVideoRef
} from '@fizz/agent-kit/shared/lib/background-video'
import {
  BACKGROUND_FITS,
  prepareThemeImage,
  prepareThemeVideo,
  type ThemeBackground
} from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { Button } from '@fizz/ui/button'
import { Slider } from '@fizz/ui/slider'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export interface ThemeBackgroundEditorProps {
  background: ThemeBackground
  /** 返回 false = 没存下（配额满） */
  onChange: (patch: Partial<ThemeBackground>) => boolean
  /** 文案里点名「只作用于这套主题」 */
  themeLabel: string
}

export function ThemeBackgroundEditor({
  background,
  onChange,
  themeLabel
}: ThemeBackgroundEditorProps) {
  const tr = useT()
  /** 视频要读元数据 + 写 IndexedDB，给个进行中状态，别让用户以为点了没反应 */
  const [videoBusy, setVideoBusy] = useState(false)
  /** 图 / 视频共用一条错误提示（同一时刻只有一个在生效） */
  const [error, setError] = useState<string | null>(null)
  /** 图片与视频**共用一个**选择框：类型不同、落地方式不同，但对用户是同一件事 */
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 选图 → 压成 data URL 再存（原图 base64 直接撑爆 localStorage 的 5MB 配额） */
  const handleImage = async (file: File): Promise<void> => {
    setError(null)
    try {
      const image = await prepareThemeImage(file)
      if (!onChange({ image })) setError(tr('存不下：本地存储已满，换张小一点的图。'))
    } catch {
      setError(tr('这张图读不了，换一张试试。'))
    }
  }

  /**
   * 选视频 → 探一次元数据 → 写进 IndexedDB，localStorage 里只留引用。
   *
   * 视频没法压缩（没有 canvas 那条路），所以只在 `prepareThemeVideo` 里卡体积上限 +
   * 确认浏览器解得了。解不了的格式（`.mkv` / 部分 HEVC）在这一步就报错，
   * 而不是存下去之后得到一块黑底。
   */
  const handleVideo = async (file: File): Promise<void> => {
    setError(null)
    setVideoBusy(true)
    try {
      const video = await prepareThemeVideo(file)
      if (!onChange({ video })) setError(tr('存不下：本地存储已满，换一段小一点的视频。'))
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('这段视频读不了，换一段试试。'))
    } finally {
      setVideoBusy(false)
    }
  }

  /**
   * 一个入口按**文件类型**分流。`accept` 只是给文件选择器的过滤提示，用户仍可以切到
   * 「所有文件」硬塞一个 `.txt`，所以这里必须自己按 MIME 判一次并给出明确提示
   * （不然会静默什么都不发生）。
   */
  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    if (file.type.startsWith('video/')) {
      await handleVideo(file)
      return
    }
    if (file.type.startsWith('image/')) {
      await handleImage(file)
      return
    }
    setError(tr('只支持图片或视频文件。'))
  }

  const hasMedia = Boolean(background.image || background.video)

  return (
    <div className="space-y-3">
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('只作用于「{name}」，新素材会替换旧素材；视频建议短小，持续解码较费电。', { name: themeLabel })}
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(event) => {
          void handleFile(event.target.files?.[0])
          // 清空 value：不然连着选同一个文件不会再触发 change
          event.target.value = ''
        }}
      />
      {hasMedia ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {background.video ? (
              <VideoThumb video={background.video} />
            ) : (
              background.image && (
                <img
                  src={background.image}
                  alt={tr('当前主题的背景图')}
                  className="h-16 w-24 rounded-md border border-border/60 object-cover"
                />
              )
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span
                className="max-w-56 truncate text-[0.6875rem] text-muted-foreground"
                title={background.video?.name}
              >
                {background.video ? background.video.name : tr('图片')}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={videoBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-3.5" />
                  {tr('更换')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ image: null, video: null })}
                >
                  <X className="size-3.5" />
                  {tr('移除')}
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="w-14 shrink-0">{tr('显示')}</span>
            <Segmented
              ariaLabel={tr('背景显示方式')}
              value={background.fit}
              onChange={(fit) => onChange({ fit })}
              options={BACKGROUND_FITS}
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="w-14 shrink-0">{tr('遮罩')}</span>
            <Slider
              className="max-w-64"
              min={0.3}
              max={0.95}
              step={0.01}
              value={[background.mask]}
              onValueChange={([next]) => onChange({ mask: next ?? background.mask })}
            />
            <span className="w-9 font-mono">{Math.round(background.mask * 100)}%</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="w-14 shrink-0">{tr('模糊')}</span>
            <Slider
              className="max-w-64"
              min={0}
              max={24}
              step={1}
              value={[background.blur]}
              onValueChange={([next]) => onChange({ blur: next ?? background.blur })}
            />
            <span className="w-9 font-mono">{background.blur}px</span>
          </div>
          <p className="text-[0.6875rem] leading-4 text-muted-foreground">
            {tr('「铺满」裁掉多出来的部分；「完整显示」整幅都看得见，留出的边用主题底色填。遮罩越高，背景越淡、文字越清楚；拉到最高基本就看不见背景了。')}
          </p>
        </div>
      ) : (
        /* 虚线框选图片或视频：怎么存是内部实现，不该让用户先做选择题 */
        <button
          type="button"
          disabled={videoBusy}
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 py-6 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
        >
          <ImagePlus className="size-4" />
          {videoBusy ? tr('正在读取视频…') : tr('选择图片或视频（都存在本机）')}
        </button>
      )}
      {videoBusy && hasMedia && <p className="text-xs text-muted-foreground">{tr('正在读取视频…')}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * 视频缩略图：localStorage 里只有引用（`{ key }`），本体按 key 从 IndexedDB 取，
 * 取到后转成 object URL 才能给 `<video>` 用（取不到 = 换过 profile / 清过站点数据）。
 */
function VideoThumb({ video }: { video: BackgroundVideoRef }) {
  const tr = useT()
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setMissing(false)
    void getBackgroundVideo(video.key).then((blob) => {
      if (!alive) return
      if (!blob) {
        setMissing(true)
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [video.key])

  if (missing) {
    return (
      <div className="flex h-16 w-24 items-center justify-center rounded-md border border-dashed border-border/60 text-[0.625rem] text-muted-foreground">
        {tr('读不到视频')}
      </div>
    )
  }
  if (!url) {
    return <div className="h-16 w-24 animate-pulse rounded-md border border-border/60 bg-muted" />
  }
  return (
    <video
      src={url}
      muted
      loop
      autoPlay
      playsInline
      aria-label={tr('当前主题的背景视频')}
      className="h-16 w-24 rounded-md border border-border/60 object-cover"
    />
  )
}
