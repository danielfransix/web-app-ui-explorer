import { useId } from "react"
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { Button } from "./ui"

export default function ComponentCreationSetting({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const id = useId()
  return <div className="design-component-option">
    <span id={`${id}-label`} className="design-component-option__title">Create components?</span>
    <RadioGroup className="design-yes-no" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} value={value ? "yes" : "no"} onValueChange={next => onChange(next === "yes")}>
      <Radio.Root value="yes" nativeButton render={<Button className="design-yes-no__option" />}>Yes</Radio.Root>
      <Radio.Root value="no" nativeButton render={<Button className="design-yes-no__option" />}>No</Radio.Root>
    </RadioGroup>
    <p id={`${id}-help`} className="design-component-option__help">{value ? "Create reusable components and instances." : "Create regular editable layers without components or instances."}</p>
  </div>
}
