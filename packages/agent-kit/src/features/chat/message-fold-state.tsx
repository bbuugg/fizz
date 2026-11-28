/**
 * 消息折叠状态的短期记忆。
 *
 * 消息流结束时临时消息 id 会被服务端 id 替换，单个消息子树随之重挂。用会话内稳定的折叠键
 * 保留用户刚才的手动开合选择；切换会话时 Provider 会一起重置。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

interface MessageFoldStateStore {
  get: (key: string) => boolean | undefined
  set: (key: string, open: boolean) => void
}

const MessageFoldStateContext = createContext<MessageFoldStateStore | null>(null)
const MAX_REMEMBERED_FOLDS = 2_000

export function MessageFoldStateProvider({ children }: { children: ReactNode }) {
  const valuesRef = useRef(new Map<string, boolean>())
  const store = useMemo<MessageFoldStateStore>(() => ({
    get: (key) => valuesRef.current.get(key),
    set: (key, open) => {
      const values = valuesRef.current
      values.delete(key)
      values.set(key, open)
      while (values.size > MAX_REMEMBERED_FOLDS) {
        const oldest = values.keys().next().value
        if (oldest === undefined) break
        values.delete(oldest)
      }
    }
  }), [])

  return (
    <MessageFoldStateContext.Provider value={store}>
      {children}
    </MessageFoldStateContext.Provider>
  )
}

/** 默认值只在首次挂载时使用；之后的自动折叠 / 手动操作都写入会话内记忆。 */
export function useMessageFoldOpen(
  key: string | undefined,
  initialOpen: boolean
): [boolean, (open: boolean) => void] {
  const store = useContext(MessageFoldStateContext)
  const [open, setLocalOpen] = useState(() =>
    key && store ? (store.get(key) ?? initialOpen) : initialOpen
  )
  const previousKey = useRef(key)
  useEffect(() => {
    if (previousKey.current === key) return
    previousKey.current = key
    setLocalOpen(key && store ? (store.get(key) ?? initialOpen) : initialOpen)
  }, [key, initialOpen, store])
  const setOpen = useCallback((next: boolean) => {
    setLocalOpen(next)
    if (key) store?.set(key, next)
  }, [key, store])
  return [open, setOpen]
}
