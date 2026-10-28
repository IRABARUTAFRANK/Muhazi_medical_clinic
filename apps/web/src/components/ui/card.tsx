import type { ComponentProps, HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { headerBand, tintClass, type BandHue } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'

/**
 * Card of the console: white, 10 px corners, a 1 px border at 8 % navy and a soft shadow (the
 * first design's). It fades in and rises 8 px when it appears (anim-enter; give it `--i` for a
 * 40 ms stagger). The header is a 40 px band, a light gradient from the hue's tint to white
 * (teal by default; `hue` for a card about one subject) with a 1 px rule under it, an icon chip
 * and the title (16 px semibold) on the left and the actions on the right.
 */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'bg-card border-card-border shadow-card anim-enter rounded-lg2 flex min-w-0 scroll-mt-4 flex-col overflow-hidden border',
        className,
      )}
      {...props}
    />
  )
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Icon before the title, in a small chip in the hue. */
  icon?: LucideIcon
  /** The subject's hue for the band and the chip (teal when left out). */
  hue?: BandHue
}

export function CardHeader({
  icon: IconC,
  hue = 'teal',
  className,
  children,
  ...props
}: CardHeaderProps) {
  const h = hue === 'lavender' ? 'violet' : hue === 'blue' ? 'navy' : hue
  return (
    <div
      className={cn(
        'border-border text-ink flex min-h-10 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-4 py-2 text-[16px] font-semibold',
        headerBand(hue),
        className,
      )}
      {...props}
    >
      {/* icon and title stay together on the left; a trailing element is pushed right (on a
          narrow screen it wraps under the title instead of squeezing it) */}
      {IconC ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'inline-flex size-7 flex-none items-center justify-center rounded',
              h === 'grey' ? 'bg-hover text-ink-2' : tintClass[h],
            )}
          >
            <IconC size={16} aria-hidden="true" />
          </span>
          {children}
        </span>
      ) : (
        children
      )}
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
