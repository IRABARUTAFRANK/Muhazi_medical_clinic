import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode
  wrapperClassName?: string
}

/** Labelled native select, 44 px, same focus ring as Field. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, className, wrapperClassName, children, ...props }, ref) => (
    <label
      className={cn('text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold', wrapperClassName)}
    >
      {label}
      <select
        ref={ref}
        className={cn(
          'border-border bg-card text-ink focus:border-primary focus:ring-primary-tint h-11 rounded-lg border px-3 text-[15px] font-normal outline-none focus:ring-[3px]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </label>
  ),
)
Select.displayName = 'Select'
