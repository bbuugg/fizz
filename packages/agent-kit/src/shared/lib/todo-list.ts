import type { TodoItem } from '@fizz/contracts/types'

/** Read the current tool output array, or its input while the tool is still running. */
export function todoItemsOf(input: unknown, output: unknown): TodoItem[] {
  const fromInput = (input as { todos?: unknown } | null | undefined)?.todos
  const src = Array.isArray(output) ? output : fromInput
  if (!Array.isArray(src)) return []
  return src.flatMap((raw): TodoItem[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as { content?: unknown; status?: unknown; priority?: unknown }
    if (typeof item.content !== 'string') return []
    return [{
      content: item.content,
      status: typeof item.status === 'string' ? item.status : 'pending',
      ...(typeof item.priority === 'string' ? { priority: item.priority } : {})
    }]
  })
}

export function todoProgress(items: readonly TodoItem[]) {
  return {
    total: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    inProgress: items.filter((item) => item.status === 'in_progress').length,
    pending: items.filter((item) => item.status === 'pending').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length
  }
}
