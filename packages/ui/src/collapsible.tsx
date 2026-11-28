"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { asChildSlot } from "./polymorphic"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  asChild,
  children,
  ...props
}: CollapsiblePrimitive.Trigger.Props & { asChild?: boolean }) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      {...asChildSlot(asChild, children)}
      {...props}
    />
  )
}

/** Base UI 里叫 `Panel`（Radix 的 `Content`），导出名保持不变，调用方不用改。 */
function CollapsibleContent({
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
