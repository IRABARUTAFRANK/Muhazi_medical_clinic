import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Small neutral tag (insurer, language, working days). */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'border-border text-ink-2 inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium whitespace-nowrap',
        className,
      )}
      {...props}
    />
  )
}
