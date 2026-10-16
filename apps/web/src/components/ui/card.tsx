import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Flat card: border, radius 8, no shadow (elevation is for sheets and dialogs only). */
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('border-border bg-card flex min-w-0 flex-col rounded-lg border', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-border flex items-center justify-between gap-2 border-b px-4 py-3 text-sm font-semibold',
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
        'border-border flex min-h-[52px] items-center gap-3 border-b px-4 py-2.5 last:border-b-0',
        className,
      )}
      {...props}
    />
  )
}
