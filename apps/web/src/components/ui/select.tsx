import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { controlClass, labelClass } from './field'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode
  wrapperClassName?: string
}

/** Labelled native select, 38 px, same border and focus ring as Field. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, className, wrapperClassName, children, ...props }, ref) => (
    <label className={cn(labelClass, wrapperClassName)}>
      {label}
      <select ref={ref} className={cn(controlClass, className)} {...props}>
        {children}
      </select>
    </label>
  ),
)
Select.displayName = 'Select'
