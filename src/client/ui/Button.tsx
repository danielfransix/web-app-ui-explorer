import { Button as BaseButton } from "@base-ui/react/button"
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"

type ButtonVariant =
  | "unstyled"
  | "default"
  | "outline"
  | "ghost"
  | "ghost-slim"
  | "link-danger"
type ButtonSize = "default" | "sm" | "icon"

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  size?: ButtonSize
  variant?: ButtonVariant
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className = "",
    icon,
    leftIcon,
    rightIcon,
    size = "default",
    type = "button",
    variant = "unstyled",
    disabled,
    ...props
  },
  ref,
) {
  const classes =
    variant === "unstyled"
      ? className
      : [`ds-button ds-button--variant-${variant} ds-button--size-${size}`, className]
          .filter(Boolean)
          .join(" ")
  return (
    <BaseButton {...props} ref={ref} nativeButton type={type} className={classes} disabled={disabled}>
      {variant === "unstyled" ? (
        children
      ) : size === "icon" ? (
        (icon ?? leftIcon ?? children)
      ) : (
        <>
          {leftIcon && <span className="ds-button__icon">{leftIcon}</span>}
          {children && <span className="ds-button__label">{children}</span>}
          {rightIcon && <span className="ds-button__icon">{rightIcon}</span>}
        </>
      )}
    </BaseButton>
  )
})

export default Button
