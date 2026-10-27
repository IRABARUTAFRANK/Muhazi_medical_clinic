import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { heroBand, type BandHue } from '@/components/dash/kit-style'

/*
 * The identity band of a person's screens (the visit page, the patient file, the sign-in card):
 * the hero of the first design on the console structure. A strong gradient in the hue with a
 * faint dot grid (heroBand of kit-style), white text, a large icon at 10 % on the right, the
 * tags as glass pills. Actions never sit on the band: they go on the white row under it.
 */
export function HeroHead({
  icon: IconC,
  hue,
  className,
  children,
}: {
  /** The large watermark icon on the right (the role or subject of the band). */
  icon: LucideIcon
  /** A subject's hue; left out, the clinic's navy → teal identity gradient. */
  hue?: BandHue
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        hue ? heroBand(hue) : 'hero hero-clinic',
        'relative overflow-hidden px-4 py-3 text-white',
        className,
      )}
    >
      <IconC
        size={128}
        strokeWidth={1.5}
        aria-hidden="true"
        className="pointer-events-none absolute -right-4 -bottom-7 opacity-10"
      />
      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-2">{children}</div>
    </div>
  )
}

/** A tag on the band: white glass at 20 %, white text. */
export function GlassPill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center gap-1 rounded-full border border-white/30 bg-white/20 px-2.5 text-[12px] leading-tight font-medium whitespace-nowrap text-white tabular-nums',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Round avatar on the band: initials on white glass. */
export function GlassAvatar({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-11 flex-none items-center justify-center rounded-full border border-white/30 bg-white/20 text-[15px] font-semibold text-white">
      {children}
    </span>
  )
}
