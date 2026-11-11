/**
 * 插件界面的「块」渲染器：把服务端给的一串 `PluginBlock` 画成内置组件。
 *
 * 这是全仓库**唯一**一处把插件数据变成界面的地方（侧栏与标签页共用它），所以它刻意
 * 只认那几种 `kind`，别的**一律不画** —— 插件写坏了也只是一块内容缺席，不会出现
 * 「插件产出什么前端就照着拼 DOM」这种口子。
 */
import { useState } from 'react'
import {
  Copy,
  ExternalLink,
  Info,
  Pause,
  Pencil,
  Plug,
  Play,
  Plus,
  RotateCw,
  SquareTerminal,
  Star,
  Trash2,
  Unplug,
  type LucideIcon
} from 'lucide-react'
import { Input } from '@fizz/ui/input'
import { Textarea } from '@fizz/ui/textarea'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { PluginBlock, PluginBlockTone, PluginItemIcon } from '@fizz/contracts/agent-api'

/**
 * 图标名 → 组件的映射（**宿主这边**拥有这张表）：插件只给名字，给不了组件 ——
 * 这是「插件产出数据、宿主负责渲染」的另一半。
 */
export const ITEM_ICON: Record<PluginItemIcon, LucideIcon> = {
  pencil: Pencil,
  trash: Trash2,
  copy: Copy,
  play: Play,
  pause: Pause,
  plug: Plug,
  unplug: Unplug,
  refresh: RotateCw,
  external: ExternalLink,
  info: Info,
  terminal: SquareTerminal,
  star: Star,
  plus: Plus
}

const TONE_CLASS: Record<PluginBlockTone, string> = {
  normal: 'text-foreground',
  muted: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive'
}

const NOTE_CLASS: Record<PluginBlockTone, string> = {
  normal: 'border-border/60 bg-muted/40 text-foreground/80',
  muted: 'border-border/60 bg-muted/40 text-muted-foreground',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'border-destructive/40 bg-destructive/5 text-destructive'
}

const BADGE_CLASS: Record<PluginBlockTone, string> = {
  normal: 'bg-muted text-foreground/80',
  muted: 'bg-muted text-muted-foreground',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/10 text-destructive'
}

export function PluginBlocks({
  blocks,
  onAction,
  busy,
  className
}: {
  blocks: PluginBlock[]
  /** 有可点的项时才需要传（没有 onAction 的面传 undefined，项就不带点击态） */
  onAction?: (actionId: string, args?: Record<string, string | number | boolean>) => void
  /** 正在处理动作：按钮禁用，免得连点 */
  busy?: boolean
  className?: string
}) {
  if (blocks.length === 0) {
    return (
      <p className={cn('px-3 py-6 text-center text-xs text-muted-foreground', className)}>
        这一面现在没有内容。
      </p>
    )
  }
  return (
    <div className={cn('space-y-3', className)}>
      {blocks.map((block, index) => (
        <PluginBlockView key={index} block={block} onAction={onAction} busy={busy} />
      ))}
    </div>
  )
}

function PluginBlockView({
  block,
  onAction,
  busy
}: {
  block: PluginBlock
  onAction?: (actionId: string, args?: Record<string, string | number | boolean>) => void
  busy?: boolean
}) {
  switch (block.kind) {
    case 'text':
      return (
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-xs leading-5',
            block.mono && 'font-mono text-[0.6875rem]',
            TONE_CLASS[block.tone ?? 'normal']
          )}
        >
          {block.text}
        </p>
      )

    case 'kv':
      return (
        <div className="space-y-1">
          {block.label && (
            <div className="text-[0.6875rem] font-medium text-foreground/70">{block.label}</div>
          )}
          <dl className="divide-y divide-border/60 rounded-md border border-border/60">
            {block.rows.map((row, i) => (
              <div key={`${row.label}-${i}`} className="flex items-start gap-2 px-2 py-1.5">
                <dt className="w-24 shrink-0 truncate text-[0.6875rem] text-muted-foreground">
                  {row.label}
                </dt>
                <dd
                  className={cn(
                    'min-w-0 flex-1 break-words font-mono text-[0.6875rem]',
                    TONE_CLASS[row.tone ?? 'normal']
                  )}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )

    case 'list': {
      const clickable = Boolean(onAction)
      // 有行尾图标的列表才需要「让位」：hover 时名字给按钮腾出地方（与会话行同款）
      const withActions = block.items.some((item) => item.actions?.length)
      return (
        <div className="space-y-1">
          {block.label && (
            <div className="text-[0.6875rem] font-medium text-foreground/70">{block.label}</div>
          )}
          <ul>
            {block.items.map((item) => {
              const canClick = clickable && Boolean(item.actionId)
              const actions = item.actions ?? []
              return (
                <li key={item.id}>
                  {/* 行是 div + role=button：里面要嵌真正的图标按钮，button 套 button 不合法 */}
                  <div
                    role={canClick ? 'button' : undefined}
                    tabIndex={canClick ? 0 : undefined}
                    onClick={() => canClick && item.actionId && onAction?.(item.actionId, item.args)}
                    onKeyDown={(e) => {
                      if (canClick && e.key === 'Enter' && item.actionId) {
                        onAction?.(item.actionId, item.args)
                      }
                    }}
                    className={cn(
                      // 与**会话行**（AgentSidebar 的 renderConversationRow）逐项对齐：
                      // text-sm + px-1.5 py-1.5 + gap-1.5 + hover 整行染色。
                      // 早先是 text-xs / px-2 / gap-2 —— 同一个侧栏里两种字号与内边距，
                      // 插件的行看着就比会话行小一号、缩进也不齐。
                      'group relative flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors',
                      canClick && 'cursor-pointer hover:bg-primary-soft',
                      TONE_CLASS[item.tone ?? 'normal']
                    )}
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        withActions && 'transition-[padding] group-hover:pe-16 max-md:pe-16'
                      )}
                    >
                      {item.label}
                    </span>
                    {item.detail && (
                      /* 可缩 + 截断：detail 是 `host:port/db0` 这种长串，写死 shrink-0 的话
                         窄侧栏里被挤掉的会是**名字**（flex-1 的那个）。给它一个宽度上限，
                         两边一起让位，名字至少留得下几个字。 */
                      <span className="max-w-[45%] shrink truncate font-mono text-[0.625rem] text-muted-foreground">
                        {item.detail}
                      </span>
                    )}
                    {item.badge && (
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 text-[0.625rem]',
                          BADGE_CLASS[item.tone ?? 'muted']
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                    {actions.length > 0 && onAction && (
                      <div
                        className={cn(
                          // 绝对定位在行尾 + 渐隐底色（文字不会硬贴在按钮下面）；
                          // 触屏没有 hover，常显 —— 与会话行完全同一套。
                          // ⚠️ 底色必须是 `from-sidebar`（不是 `from-background`）：浮层贴在
                          // 侧栏里，用 `background` 会在侧栏底色上糊出一块**颜色不同的方角**，
                          // 把行的 `rounded-md` 右圆角盖掉（会话行用的就是 sidebar）。
                          // `rounded-r-md` 再兜一道：浮层自己的右角跟着行圆，即使底色有细微
                          // 色差也不会溢出到行外。
                          'absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pr-1',
                          'bg-gradient-to-l from-sidebar from-70% to-transparent',
                          'opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100',
                          'pointer-events-none group-hover:pointer-events-auto max-md:pointer-events-auto'
                        )}
                      >
                        {actions.map((action) => {
                          const Icon = ITEM_ICON[action.icon]
                          return (
                            <button
                              key={action.actionId}
                              type="button"
                              title={action.label}
                              aria-label={action.label}
                              disabled={busy}
                              onClick={(e) => {
                                // 别让行自己的点击（开面板）也跟着触发
                                e.stopPropagation()
                                onAction?.(action.actionId, action.args)
                              }}
                              className={cn(
                                'rounded p-1 transition-colors hover:bg-secondary',
                                action.danger
                                  ? 'text-destructive hover:text-destructive'
                                  : 'text-muted-foreground hover:text-foreground'
                              )}
                            >
                              <Icon className="size-3.5" />
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )
    }

    case 'buttons':
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((item) => (
            <button
              key={item.actionId}
              type="button"
              disabled={busy}
              onClick={() => onAction?.(item.actionId, item.args)}
              className="rounded-md border border-border/60 px-2 py-1 text-[0.6875rem] transition-colors hover:bg-secondary disabled:opacity-60"
            >
              {item.label}
            </button>
          ))}
        </div>
      )

    case 'note':
      return (
        <p
          className={cn(
            'rounded-md border px-2 py-1.5 text-[0.6875rem] leading-4 break-words',
            NOTE_CLASS[block.tone ?? 'muted']
          )}
        >
          {block.text}
        </p>
      )

    case 'input':
      return <PluginInputBlock block={block} onAction={onAction} busy={busy} />

    case 'form':
      return <PluginFormBlock block={block} onAction={onAction} busy={busy} />

    default:
      return null
  }
}

/**
 * 多字段表单 + 一个提交按钮：提交时**所有字段**的值一起给 `onAction`
 * （`args: { <fieldId>: 值 }`）。
 *
 * 值同样只存在本地 state（理由同 `PluginInputBlock`）：想让表单记住当前值，插件通过
 * 字段的 `value` 回传即可 —— 编辑连接时就是把已有值带出来的。
 */
function PluginFormBlock({
  block,
  onAction,
  busy
}: {
  block: Extract<PluginBlock, { kind: 'form' }>
  onAction?: (actionId: string, args?: Record<string, string | number | boolean>) => void
  busy?: boolean
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(block.fields.map((f) => [f.id, f.value ?? '']))
  )
  const submit = (): void => onAction?.(block.actionId, { ...values })

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2">
      {block.label && (
        <div className="text-[0.6875rem] font-medium text-foreground/70">{block.label}</div>
      )}
      {block.fields.map((field) => (
        <div key={field.id} className="space-y-1">
          {field.label && <div className="text-[0.625rem] text-muted-foreground">{field.label}</div>}
          {field.multiline ? (
            <Textarea
              value={values[field.id] ?? ''}
              placeholder={field.placeholder}
              disabled={busy || !onAction}
              rows={5}
              aria-label={field.label ?? field.id}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
              className="w-full font-mono text-xs"
            />
          ) : (
            <Input
              type={field.secret ? 'password' : 'text'}
              value={values[field.id] ?? ''}
              placeholder={field.placeholder}
              disabled={busy || !onAction}
              aria-label={field.label ?? field.id}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              className="h-7 w-full text-xs"
            />
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={busy || !onAction}
        onClick={submit}
        className="rounded-md border border-border/60 px-2 py-1 text-[0.6875rem] transition-colors hover:bg-secondary disabled:opacity-60"
      >
        {block.submitLabel || '提交'}
      </button>
    </div>
  )
}

/**
 * 输入框 + 提交按钮。
 *
 * 值存在**本地 state**：块每次都是服务端新算的一批，没有稳定身份给它挂受控值。
 * 想让输入框「记住」刚才填的，插件把当前值通过 `value` 字段回传即可（例如过滤器把
 * 当前 pattern 一起返回），这比在前端猜哪一块是哪个输入框可靠。
 */
function PluginInputBlock({
  block,
  onAction,
  busy
}: {
  block: Extract<PluginBlock, { kind: 'input' }>
  onAction?: (actionId: string, args?: Record<string, string | number | boolean>) => void
  busy?: boolean
}) {
  const [value, setValue] = useState(block.value ?? '')
  const submit = (): void => onAction?.(block.actionId, { [block.id]: value })

  return (
    <div className="space-y-1">
      {block.label && (
        <div className="text-[0.6875rem] font-medium text-foreground/70">{block.label}</div>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          value={value}
          placeholder={block.placeholder}
          disabled={busy || !onAction}
          aria-label={block.label ?? block.id}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <button
          type="button"
          disabled={busy || !onAction}
          onClick={submit}
          className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-[0.6875rem] transition-colors hover:bg-secondary disabled:opacity-60"
        >
          {block.submitLabel || '提交'}
        </button>
      </div>
    </div>
  )
}
