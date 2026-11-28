import {
  ResizablePanel,
  ResizablePanelGroup
} from '@fizz/ui/resizable'
import type { ComponentProps, CSSProperties, ReactNode, RefCallback } from 'react'

export function SplitFrame({
  split,
  containerRef,
  onKeyDownCapture,
  onLayoutChanged,
  children
}: {
  split: boolean
  containerRef: RefCallback<HTMLDivElement>
  onKeyDownCapture?: ComponentProps<'div'>['onKeyDownCapture']
  onLayoutChanged: NonNullable<ComponentProps<typeof ResizablePanelGroup>['onLayoutChanged']>
  children: ReactNode
}) {
  return (
    <div ref={containerRef} onKeyDownCapture={onKeyDownCapture} className="flex h-full min-h-0 w-full bg-background">
      {split ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0" onLayoutChanged={onLayoutChanged}>
          {children}
        </ResizablePanelGroup>
      ) : (
        children
      )}
    </div>
  )
}

export function PaneShell({
  split,
  panel,
  className,
  style,
  children
}: {
  split: boolean
  /** 两栏布局中必须注册为 ResizablePanel，Group 才能管理拖拽尺寸。 */
  panel?: Omit<ComponentProps<typeof ResizablePanel>, 'className' | 'style' | 'children'>
  className: string
  style?: CSSProperties
  children: ReactNode
}) {
  if (!split) return <div className={className} style={style}>{children}</div>
  return <ResizablePanel {...panel} className={className} style={style}>{children}</ResizablePanel>
}
