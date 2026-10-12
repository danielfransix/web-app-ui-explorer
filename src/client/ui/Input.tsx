import { Input as BaseInput } from "@base-ui/react/input"
import { forwardRef, type InputHTMLAttributes } from "react"

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", type, ...props },
  ref,
) {
  return <BaseInput {...props} ref={ref} type={type} className={className} />
})

export default Input
