import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode
  /** Extra classes for the wrapping label. */
  wrapperClassName?: string
}

/** Labelled 44 px input with the primary focus ring. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(
  ({ label, className, wrapperClassName, ...props }, ref) => (
    <label
      className={cn('text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold', wrapperClassName)}
    >
      {label}
      <input
        ref={ref}
        className={cn(
          'border-border bg-card text-ink focus:border-primary focus:ring-primary-tint h-11 rounded-lg border px-3 text-[15px] font-normal outline-none focus:ring-[3px]',
          className,
        )}
        {...props}
      />
    </label>
  ),
)
Field.displayName = 'Field'
