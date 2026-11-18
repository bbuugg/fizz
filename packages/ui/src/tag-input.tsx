/**
 * 多值输入（chips）：回车 / 逗号 提交一个值，粘贴「多行或逗号分隔」一次拆成多个，
 * 输入框空着时按退格删最后一个，chip 上的 × 删它自己。
 *
 * 用在「模型 id」这种「一份配置挂多个值」的字段上（见设置 → 模型）。
 * 受控组件：值都在调用方（`value` + `onChange`）。
 */
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from "cn"

/** 逗号（中英文）、分号、空白、换行都算分隔符 —— 粘贴一整列时最省事 */
const SPLIT = /[,，;；\s\r\n]+/

export function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
  className
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState('')

  /** 把一段文本按分隔符拆开、去重后合并进已有值 */
  const commit = (raw: string): void => {
    const parts = raw
      .split(SPLIT)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length) {
      const next = [...value]
      for (const part of parts) if (!next.includes(part)) next.push(part)
      onChange(next)
    }
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commit(draft)
      return
    }
    // 空输入时退格 = 删最后一个 chip（跟常见 tag 输入一致）
    if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text')
    if (!text || !SPLIT.test(text)) return // 单个值：交给默认粘贴行为
    e.preventDefault()
    commit(text)
  }

  return (
    <div
      className={cn(
        'flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm',
        disabled && 'opacity-50',
        className
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="flex max-w-full items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            disabled={disabled}
            aria-label={`移除 ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
        placeholder={value.length ? '' : placeholder}
        className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
