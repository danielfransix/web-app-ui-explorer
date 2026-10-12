import { Collapsible } from "@base-ui/react/collapsible"
import type { ComponentProps } from "react"
import Button from "./Button"

export function Disclosure(props: Collapsible.Root.Props) {
  return <Collapsible.Root {...props} />
}

export function DisclosureTrigger({ children, ...props }: ComponentProps<typeof Button>) {
  return <Collapsible.Trigger render={<Button {...props} />}>{children}</Collapsible.Trigger>
}

export function DisclosurePanel(props: Collapsible.Panel.Props) {
  return <Collapsible.Panel keepMounted {...props} />
}
