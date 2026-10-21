import { useTranslation } from 'react-i18next'
import type { NavItem } from '@mmc/shared'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'
import { NavIcon } from './nav-icon'

interface RailProps {
  nav: NavItem[]
  activeId?: string
  /** "Thu 15/10/2026 · 12:45" */
  clock: string
}

/**
 * PC left rail (Figma: Manager Dashboard v2): navy gradient, icon above a short label, the
 * active item on a translucent pill, at most five items per role, date and time at the bottom.
 */
export function Rail({ nav, activeId, clock }: RailProps) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="pc:flex hidden w-[136px] flex-none flex-col items-center gap-1.5 overflow-y-auto bg-[linear-gradient(180deg,var(--mmc-navy),var(--mmc-navy-2))] px-2.5 py-4 text-white"
    >
      {nav.map((n, i) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'anim-enter flex min-h-[60px] w-[116px] flex-none flex-col items-center justify-center gap-1 rounded-[14px] px-1 py-1.5 text-[12px] leading-tight font-semibold text-white/70 no-underline transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white focus-visible:ring-[3px] focus-visible:ring-white/40 focus-visible:outline-none active:scale-[0.97]',
              active && 'bg-white/15 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]',
            )}
            style={{ '--i': i } as React.CSSProperties}
          >
            <NavIcon id={n.id} name={n.icon} />
            <span className="max-w-full text-center break-words">{t(n.labelKey)}</span>
          </StaffLink>
        )
      })}
      <div className="flex-1" />
      <div className="px-1 pt-2 text-center text-[11px] leading-tight text-white/60 tabular-nums">
        {clock}
      </div>
    </nav>
  )
}
