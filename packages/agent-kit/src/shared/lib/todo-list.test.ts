/** Keep todowrite status and priority data visible in task-list messages. */
import { describe, expect, it } from 'vitest'
import { todoItemsOf, todoProgress } from './todo-list'

describe('todo list message rendering data', () => {
  it('keeps ordering, status, priority and cancelled state from the tool output', () => {
    const items = todoItemsOf(undefined, [
      { content: 'first', priority: 'high', status: 'completed' },
      { content: 'second', priority: 'medium', status: 'in_progress' },
      { content: 'third', priority: 'low', status: 'cancelled' }
    ])
    expect(items).toEqual([
      { content: 'first', priority: 'high', status: 'completed' },
      { content: 'second', priority: 'medium', status: 'in_progress' },
      { content: 'third', priority: 'low', status: 'cancelled' }
    ])
    expect(todoProgress(items)).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 0, cancelled: 1 })
  })

  it('uses current input while the tool output is pending', () => {
    expect(todoItemsOf({ todos: [{ content: 'pending task', status: 'pending' }] }, undefined))
      .toEqual([{ content: 'pending task', status: 'pending' }])
  })
})
