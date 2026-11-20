import * as React from 'react'

/** 取消固定在动作末尾；不按文案或按钮样式猜语义，也不改写事件、ref 与其他属性。 */
export function orderDialogActions(
  children: React.ReactNode,
  cancelTypes: readonly React.ElementType[] = [],
): React.ReactNode[] {
  const flattened = flattenFragments(children)
  const actions: React.ReactNode[] = []
  const dismiss: React.ReactNode[] = []
  for (const child of flattened) {
    const cancel = React.isValidElement<{ 'data-dialog-dismiss'?: unknown }>(child) && (
      child.props['data-dialog-dismiss'] !== undefined ||
      cancelTypes.includes(child.type as React.ElementType)
    )
    if (cancel) dismiss.push(child)
    else actions.push(child)
  }
  return [...actions, ...dismiss]
}

function flattenFragments(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child) || child.type !== React.Fragment)
      return [child]
    // Fragment 不生成 DOM；展开它才可把其中的取消移动到整个 footer 的末尾。
    // 保留片段 key 的命名空间，避免不同片段内相同 key 的按钮冲突。
    return flattenFragments(child.props.children).map((nested) =>
      React.isValidElement(nested)
        ? React.cloneElement(nested, { key: `${child.key}/${nested.key}` })
        : nested,
    )
  })
}
