import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Small neutral tag (insurer, language, working days): 24 px, 4 px corners, 1 px border. One line
 *  while there is room; in a box narrower than its words it wraps and grows (see Badge). */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'mmc-tag border-border text-ink-2 inline-flex min-h-6 max-w-full shrink-[0.001] items-center rounded border px-2 py-[3px] text-[12px] leading-[1.25] font-medium',
        className,
      )}
      {...props}
    />
  )
}
