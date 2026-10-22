import type { ComponentProps, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Card (Figma: Manager Dashboard v2): 16 px radius, soft card shadow on the gradient
 * workspace, lifts 2 px on hover. Elevation for sheets and dialogs stays separate.
 */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'card-lift bg-card shadow-card border-border/60 flex min-w-0 scroll-mt-4 flex-col rounded-[16px] border',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-border bg-primary-tint/70 text-navy-ink flex items-center justify-between gap-2 rounded-t-[16px] border-b px-4 py-3 text-[15px] font-bold',
        className,
      )}
      {...props}
    />
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-1 flex-col gap-2 px-4 py-3', className)} {...props} />
}

/** Row inside a card list: 52 px min, divider below except on the last row. */
export function Row({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-grid hover:bg-hover/60 flex min-h-[52px] items-center gap-3 border-b px-4 py-2.5 transition-colors duration-150 last:border-b-0',
        className,
      )}
      {...props}
    />
  )
}
