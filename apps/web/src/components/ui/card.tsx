import type { ComponentProps, HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Card of the console: white, a 1 px border, 6 px corners, no shadow (shadows are for menus,
 * sheets and dialogs only). It fades in and rises 8 px when it appears (anim-enter; give it
 * `--i` for a 40 ms stagger). The header is a 40 px row on a light teal tint with a 1 px rule
 * under it, an icon and the title (16 px semibold) on the left and the actions on the right.
 */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'bg-card border-border anim-enter flex min-w-0 scroll-mt-4 flex-col overflow-hidden rounded-md border',
        className,
      )}
      {...props}
    />
  )
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Icon before the title, in a small teal chip. */
  icon?: LucideIcon
}

export function CardHeader({ icon: IconC, className, children, ...props }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'border-border bg-primary-tint/60 text-ink flex min-h-10 items-center justify-between gap-2 border-b px-4 py-2 text-[16px] font-semibold',
        className,
      )}
      {...props}
    >
      {IconC && (
        <span className="bg-primary-tint text-primary inline-flex size-7 flex-none items-center justify-center rounded">
          <IconC size={16} aria-hidden="true" />
        </span>
      )}
      {children}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-1 flex-col gap-2 p-4', className)} {...props} />
}

/** Row inside a card list: 40 px min, a 1 px divider below except on the last row. */
export function Row({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-grid hover:bg-hover flex min-h-10 items-center gap-3 border-b px-4 py-2 text-[14px] transition-colors duration-120 last:border-b-0',
        className,
      )}
      {...props}
    />
  )
}
