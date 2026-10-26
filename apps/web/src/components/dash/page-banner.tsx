import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { edgeClass, tileClass, tintClass, type Tint } from './kit-style'

/*
 * Page header: the title of every screen opened from the sidebar, a band on the feature's
 * light tint with a 3 px coloured left edge. The feature's icon (the sidebar's) sits in a
 * coloured chip before a 24 px semibold title; one grey sentence under it says what the page is for; the page's own
 * buttons sit on the right.
 */
export function PageBanner({
  icon: IconC,
  tint,
  title,
  lead,
  meta,
  children,
}: {
  icon: LucideIcon
  tint: Tint
  title: string
  /** One sentence: what this page is for. */
  lead?: ReactNode
  /** Chips after the title (counts, status). */
  meta?: ReactNode
  /** Actions on the right (buttons, links). */
  children?: ReactNode
}) {
  return (
    <section
      className={cn(
        'flex flex-none flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-l-[3px] py-3 pr-4 pl-4',
        tileClass[tint],
        edgeClass[tint],
      )}
    >
      <span
        className={cn(
          'inline-flex size-10 flex-none items-center justify-center rounded-md',
          tintClass[tint],
        )}
      >
        <IconC size={20} strokeWidth={2} aria-hidden="true" />
      </span>

      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="text-ink m-0 text-[24px] leading-8 font-semibold">{title}</h1>
          {meta}
        </div>
        {lead && <p className="text-ink-2 m-0 max-w-[720px] text-[14px] leading-snug">{lead}</p>}
      </div>

      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </section>
  )
}

/** Small tag for the header's meta row ("12 patients", "3 waiting"). */
export function BannerChip({ icon: IconC, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="border-border text-ink-2 bg-card inline-flex min-h-6 items-center gap-1 rounded border px-2 py-0.5 text-[12px] leading-tight font-medium tabular-nums">
      {IconC && <IconC size={12} aria-hidden="true" className="text-ink-3" />}
      {children}
    </span>
  )
}
