import { createElement, type HTMLAttributes, type ReactNode } from "react"

export { default as Button } from "./Button"
export { default as Input } from "./Input"
export { default as Select } from "./Select"
export { default as Tooltip } from "./Tooltip"
export { default as Modal } from "./Modal"
export { default as Checkbox } from "./Checkbox"
export { default as ContextPanel } from "./ContextPanel"
export { Disclosure, DisclosureTrigger, DisclosurePanel } from "./Disclosure"

export function Heading({
  children,
  className = "",
  level = 1,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { children: ReactNode; level?: 1 | 2 }) {
  return createElement(level === 1 ? "h1" : "h2", { className, ...props }, children)
}
