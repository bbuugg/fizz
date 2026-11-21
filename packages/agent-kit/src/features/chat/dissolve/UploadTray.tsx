/**
 * 附件瓦片行的 React 外壳（效果见 `upload-tile.ts` / `dissolve-engine.ts`）。
 *
 * 控制器是命令式的：挂载时建一次，之后的进度 / 状态变化只走 `update`，不重建 DOM。
 * 这层只管三件 React 擅长的事：文件 id 变化时换实例、把可显示缩略图地址解析好、
 * 有新附件时把行滚到最右。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { ChatAttachment } from '@fizz/agent-kit/shared/lib/attachments'
import { loadMediaObjectUrl } from '@fizz/agent-kit/shared/lib/media-url'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { prefersReducedMotion } from '@fizz/agent-kit/features/chat/dissolve/dissolve-engine'
import {
  TILE_OPEN_MS,
  createDissolveTile,
  type DissolveTileProps
} from '@fizz/agent-kit/features/chat/dissolve/upload-tile'

/** 颜色全部映射到 Fizz 的设计令牌：瓦片跟着亮 / 暗与各套主题一起变 */
const DISSOLVE_TOKENS = {
  '--dissolve-surface-2': 'var(--muted)',
  '--dissolve-foreground': 'var(--foreground)',
  '--dissolve-muted': 'var(--muted-foreground)',
  '--dissolve-border': 'var(--border)',
  '--dissolve-primary': 'var(--primary)',
  '--dissolve-primary-foreground': 'var(--primary-foreground)',
  '--dissolve-danger': 'var(--destructive)',
  '--dissolve-accent': 'var(--ring)'
} as CSSProperties

/**
 * 缩略图地址：data: / blob: / http(s) 直接可用；服务端相对地址在 desktop 下要经 IPC
 * 转成 objectURL（见 `loadMediaObjectUrl`）。首帧就能拿到的不绕异步，避免图标闪一下。
 */
function useDisplayUrl(att: ChatAttachment): string {
  // PDF / 其它文件没有缩略图：别把它们的服务端地址塞给 <img>（会白白下载一次再失败）
  const source = att.mediaType.startsWith('image/')
    ? (att.previewUrl ?? (att.uploaded ? att.url : ''))
    : ''
  const immediate = !source || /^(data:|blob:|https?:)/i.test(source) ? source : ''
  const [resolved, setResolved] = useState(immediate)
  useEffect(() => {
    if (!source) {
      setResolved('')
      return
    }
    if (immediate) return
    let alive = true
    loadMediaObjectUrl(source).then(
      (url) => {
        if (alive) setResolved(url)
      },
      () => {
        if (alive) setResolved('')
      }
    )
    return () => {
      alive = false
    }
  }, [source, immediate])
  return immediate || resolved
}

function DissolveTileView({
  att,
  onRemove,
  onCancel,
  onLeave
}: {
  att: ChatAttachment
  onRemove: () => void
  onCancel: () => void
  onLeave: () => void
}) {
  const tr = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<ReturnType<typeof createDissolveTile> | null>(null)
  const uri = useDisplayUrl(att)
  const props: DissolveTileProps = {
    file: { id: att.id, name: att.name, size: att.size, uri },
    status: att.uploaded ? 'done' : att.error ? 'failed' : 'uploading',
    progress: att.progress / 100,
    spacing: 6,
    labels: {
      remove: tr('移除 {name}', { name: att.name }),
      uploading: tr('正在上传 {name}，点击取消', { name: att.name }),
      failed: tr('{name} 上传失败', { name: att.name })
    },
    onRemove,
    onCancel,
    onLeave
  }
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const instance = createDissolveTile(hostRef.current!, propsRef.current)
    controllerRef.current = instance
    return () => {
      instance.destroy()
      controllerRef.current = null
    }
    // 一个文件一个实例；回调与状态变化走下面的 update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id])
  useEffect(() => {
    controllerRef.current?.update(propsRef.current)
  })

  return <div ref={hostRef} />
}

/**
 * 待发送附件的瓦片行：渲染在输入卡片 header 的最上方。
 *
 * 单行横向滚动（与参考实现一致）：瓦片固定 72px，多了就横滑，不换行把输入框顶高。
 * 没有 `onAdd` 那颗虚线加号 —— 本仓的添加入口是左侧回形针，再摆一颗只会出现两个入口。
 *
 * ## 最后一条消失时为什么要单独折叠高度
 *
 * 瓦片自己的退场是「宽度收 0 + 颗粒散开」，但行本身还有一整行高度。如果在条目被删掉的
 * 那一帧直接 `return null`，输入卡片会**瞬间跳高**一截（这就是「很生硬」的来源）。
 * 所以行一直挂到折叠完成为止：先从实测高度「钉住」，下一帧补间到 0，最后才卸载。
 * 最后一条**开始散开**（`onLeave`）时就同步折叠 —— 颗粒画在 fixed 覆盖层上，不会被
 * 这层 `overflow-hidden` 裁掉；等 `onRemove` 再收会晚一整段动画，中间还留一条空白。
 */
type CollapsePhase = 'idle' | 'pinned' | 'closing' | 'done'

export function DissolveAttachmentRow({
  attachments,
  onRemove,
  onCancelUpload
}: {
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
  /** 上传中点击瓦片 = 取消：先断网络，散开动画结束后再删条目 */
  onCancelUpload?: (id: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const tr = useT()
  const idsKey = attachments.map((att) => att.id).join('|')
  const hasItems = attachments.length > 0
  /** 折叠前的高度（px）：空行没有内容，必须用移除前实测的值钉住 */
  const lastHeightRef = useRef(0)
  const prevCountRef = useRef(attachments.length)
  const [phase, setPhase] = useState<CollapsePhase>(hasItems ? 'idle' : 'done')

  /**
   * 每次「完全展开」时记录整行高度（包含 py）。
   * ⚠️ 只在 `idle` 时测：折叠到一半（height 0）时测出来的是 0，下次收起就没有起点。
   */
  useLayoutEffect(() => {
    if (hasItems && phase === 'idle' && wrapRef.current) {
      lastHeightRef.current = wrapRef.current.getBoundingClientRect().height
    }
  })

  /**
   * 列表从「有」变成「空」：没有 onLeave 信号（发送成功 / 换会话清空）时也要折叠，
   * 否则同样是一帧消失。用 layout effect 是为了在浏览器绘制之前钉住旧高度，不闪。
   */
  useLayoutEffect(() => {
    const hadItems = prevCountRef.current > 0
    prevCountRef.current = attachments.length
    if (hasItems) {
      setPhase('idle')
    } else if (hadItems) {
      setPhase((cur) => (cur === 'idle' ? 'pinned' : cur))
    }
  }, [hasItems, attachments.length])

  /** 钉住一帧之后再把高度补间到 0（同一帧从 auto 改 0 不会过渡） */
  useEffect(() => {
    if (phase !== 'pinned') return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase('closing'))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [phase])

  /** 高度补间的时长（与下面 transition 同步），结束后卸载 */
  useEffect(() => {
    if (phase !== 'closing') return
    const timer = setTimeout(() => setPhase('done'), 280)
    return () => clearTimeout(timer)
  }, [phase])

  /**
   * 新瓦片长出来的那一下（OPEN + 一小段余量）之后再滚，滚太早行宽还没变完。
   */
  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const ids = idsKey ? idsKey.split('|') : []
    const isNew = ids.some((id) => !seenRef.current.has(id))
    seenRef.current = new Set(ids)
    if (!isNew) return
    const timer = setTimeout(() => {
      row.scrollTo({
        left: row.scrollWidth,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      })
    }, TILE_OPEN_MS + 60)
    return () => clearTimeout(timer)
  }, [idsKey])

  /**
   * ⚠️ 高度收完（`done`）也**不能**立刻卸载：瓦片自己的散开动画还在 fixed 覆盖层上跑，
   * 这时把行摘掉会连瓦片一起卸载（`destroy()` 会取消 burst），颗粒会半路消失。
   * 真正的卸载点是「条目也删掉了」—— 即 `onRemove` 已经回调、数组为空。
   */
  if (phase === 'done' && !hasItems) return null
  return (
    <div
      ref={wrapRef}
      aria-hidden={phase !== 'idle' || undefined}
      className="overflow-hidden"
      style={{
        height:
          phase === 'idle' ? undefined : phase === 'pinned' ? lastHeightRef.current : 0,
        // 与瓦片自己的补间同一条曲线，收起时不抢戏
        transition: 'height 260ms cubic-bezier(0.32, 0.72, 0, 1)'
      }}
    >
      <div
        ref={rowRef}
        role="list"
        aria-label={tr('附件')}
        className="flex min-w-0 items-start overflow-x-auto px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={DISSOLVE_TOKENS}
      >
        {attachments.map((att) => (
          <DissolveTileView
            key={att.id}
            att={att}
            onRemove={() => onRemove(att.id)}
            onCancel={() => onCancelUpload?.(att.id)}
            onLeave={() => {
              // 最后一条开始散开：行高度与颗粒动画同时收起
              if (attachments.length <= 1) {
                setPhase((cur) => (cur === 'idle' ? 'pinned' : cur))
              }
            }}
          />
        ))}
      </div>
    </div>
  )
}
