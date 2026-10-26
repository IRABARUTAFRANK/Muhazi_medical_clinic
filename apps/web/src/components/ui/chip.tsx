import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Small neutral tag (insurer, language, working days): 24 px, 4 px corners, 1 px border. */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'border-border text-ink-2 inline-flex h-6 items-center rounded border px-2 text-[12px] leading-none font-medium whitespace-nowrap',
        className,
      )}
      {...props}
    />
  )
}
