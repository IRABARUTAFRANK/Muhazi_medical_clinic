import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { heroBand, type Hue } from './kit-style'

/*
 * Page header: the title of every screen opened from the sidebar, the first design's hero in
 * the feature's hue (a gradient to its deep end, white text, a faint dot grid) with the
 * feature's icon large and faint at the right. The icon (the sidebar's) also sits in a white
 * glass chip before a 24 px semibold title; one sentence under it says what the page is for;
 * the page's own buttons sit on the right. 10 px corners, the card shadow.
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
  tint: Hue
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
        'anim-enter shadow-card rounded-lg2 relative flex flex-none flex-wrap items-center gap-x-3 gap-y-2 overflow-hidden py-3 pr-4 pl-4',
        heroBand(tint),
      )}
    >
      {/* the feature's icon, large and faint, at the right edge */}
      <IconC
        size={120}
        strokeWidth={1.5}
        aria-hidden="true"
        className="pointer-events-none absolute -top-5 right-3 text-white/10"
      />
      <span className="inline-flex size-10 flex-none items-center justify-center rounded-md bg-white/20 text-white">
        <IconC size={20} strokeWidth={2} aria-hidden="true" />
      </span>

      <div className="relative min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="m-0 text-[24px] leading-8 font-semibold text-white">{title}</h1>
          {meta}
        </div>
        {lead && <p className="m-0 max-w-[720px] text-[14px] leading-snug text-white/85">{lead}</p>}
      </div>

      {children && <div className="relative flex flex-wrap items-center gap-2">{children}</div>}
    </section>
  )
}

/**
 * The page's action row, right under the banner: the period control, Excel / PDF / Print in
 * their grey tint, then the primary action, with 8 px gaps. `end` pushes what follows it to
 * the right on a wide screen.
 */
export function ActionRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn('flex flex-none flex-wrap items-center gap-2 print:hidden', className)}
      role="toolbar"
    >
      {children}
    </div>
  )
}

/** Spacer inside an ActionRow: everything after it sits at the right edge. */
export function ActionRowEnd() {
  return <span className="hidden flex-1 sm:block" aria-hidden="true" />
}

/** Small glass tag on the hero's meta row ("12 patients", "3 waiting"): white at 20 %. */
export function BannerChip({ icon: IconC, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex min-h-6 items-center gap-1 rounded border border-white/25 bg-white/20 px-2 py-0.5 text-[12px] leading-tight font-medium text-white tabular-nums">
      {IconC && <IconC size={12} aria-hidden="true" className="text-white/80" />}
      {children}
    </span>
  )
}
