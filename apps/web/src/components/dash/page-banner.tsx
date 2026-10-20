import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { roleLabel } from '@/lib/roles'
import { cn } from '@/lib/utils'
import {
  initials,
  lookFor,
  stripeClass,
  tintClass,
  tintText,
  tintWash,
  type Tint,
} from './kit-style'

/*
 * Page banner: the title of every screen opened from the sidebar, in the identity banner's
 * design (colour stripe, large icon tile, big title, faint watermark icon). The feature's
 * icon matches its sidebar entry; a small chip keeps whose session it is in view, and the
 * page's own buttons sit on the right.
 */
export function PageBanner({
  icon: IconC,
  tint,
  title,
  lead,
  user,
  meta,
  children,
}: {
  icon: LucideIcon
  tint: Tint
  title: string
  lead?: ReactNode
  user: StaffUser
  /** Extra chips after the person chip (counts, status). */
  meta?: ReactNode
  /** Actions on the right (buttons, links). */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const look = lookFor(user.role)
  const RoleIcon = look.icon
  return (
    <section
      className="anim-enter bg-card shadow-card relative flex flex-none flex-wrap items-center gap-x-5 gap-y-3 overflow-hidden rounded-[18px] py-3.5 pr-5 pl-6"
      style={{
        backgroundImage: `linear-gradient(100deg, ${tintWash[tint]} 0%, var(--mmc-card) 58%)`,
      }}
    >
      <span
        className={cn('absolute inset-y-0 left-0 w-1.5', stripeClass[tint])}
        aria-hidden="true"
      />
      <IconC
        size={104}
        strokeWidth={1.2}
        aria-hidden="true"
        className="text-ink pointer-events-none absolute -right-3 -bottom-6 opacity-[0.045]"
      />

      <span
        className={cn(
          'relative inline-flex size-[52px] flex-none items-center justify-center rounded-2xl',
          tintClass[tint],
        )}
      >
        <IconC size={26} strokeWidth={2} aria-hidden="true" />
      </span>

      <div className="relative min-w-[220px] flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1
            className={cn(
              'm-0 text-[24px] leading-[1.15] font-extrabold tracking-[-0.02em]',
              tintText[tint],
            )}
          >
            {title}
          </h1>
          <span className="border-border bg-surface text-ink-2 inline-flex items-center gap-2 rounded-full border py-0.5 pr-3 pl-0.5 text-[13px] font-semibold">
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-full text-[10px] font-extrabold',
                tintClass[look.tint],
              )}
            >
              {initials(user.name)}
            </span>
            {user.name}
            <span className="text-ink-3 inline-flex items-center gap-1 font-medium">
              <RoleIcon size={13} aria-hidden="true" />
              {roleLabel(user, t)}
            </span>
          </span>
          {meta}
        </div>
        {lead && <p className="text-ink-2 m-0 mt-1 max-w-[820px] text-[14px]">{lead}</p>}
      </div>

      {children && <div className="relative flex flex-wrap items-center gap-2.5">{children}</div>}
    </section>
  )
}

/** Small chip for the banner's meta row ("12 patients", "3 waiting"). */
export function BannerChip({ icon: IconC, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="border-border text-ink-2 bg-surface inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-semibold tabular-nums">
      {IconC && <IconC size={14} aria-hidden="true" className="text-ink-3" />}
      {children}
    </span>
  )
}
