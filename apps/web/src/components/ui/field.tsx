import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Label above a control: 13 px medium, secondary grey. */
export const labelClass = 'text-ink-2 flex flex-col gap-1 text-[13px] font-medium'
/** The control itself: 38 px, 1 px border, 6 px corners, 14 px text; focus = teal border + 2 px teal/20 ring.
 *  Disabled: the grey fill with the value in secondary ink (not faded: value and placeholder stay
 *  readable). */
export const controlClass =
  'border-border bg-card text-ink focus:border-primary focus:ring-primary/20 h-[38px] rounded-md border px-3 text-[14px] font-normal outline-none focus:ring-2 disabled:bg-hover disabled:text-ink-2 disabled:cursor-not-allowed'

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode
  /** Extra classes for the wrapping label. */
  wrapperClassName?: string
}

/** Labelled 38 px input with the teal focus ring. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(
  ({ label, className, wrapperClassName, ...props }, ref) => (
    <label className={cn(labelClass, wrapperClassName)}>
      {label}
      <input ref={ref} className={cn(controlClass, className)} {...props} />
    </label>
  ),
)
Field.displayName = 'Field'
