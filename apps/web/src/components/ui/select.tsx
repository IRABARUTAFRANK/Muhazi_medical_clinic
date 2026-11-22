import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { controlClass, labelClass } from './field'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode
  wrapperClassName?: string
}

/** Labelled native select, 38 px, same border and focus ring as Field. A chosen line longer than
 *  the field ends with "…" (a native select cannot wrap): the whole line becomes its title when
 *  the pointer comes over it or it takes the focus, so it can always be read in full. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, className, wrapperClassName, children, onPointerEnter, onFocus, ...props }, ref) => {
    const say = (el: HTMLSelectElement) => {
      if (!props.title) el.title = el.selectedOptions[0]?.textContent?.trim() ?? ''
    }
    return (
      <label className={cn(labelClass, wrapperClassName)}>
        {label}
        <select
          ref={ref}
          className={cn(controlClass, className)}
          onPointerEnter={(e) => {
            say(e.currentTarget)
            onPointerEnter?.(e)
          }}
          onFocus={(e) => {
            say(e.currentTarget)
            onFocus?.(e)
          }}
          {...props}
        >
          {children}
        </select>
      </label>
    )
  },
)
Select.displayName = 'Select'
