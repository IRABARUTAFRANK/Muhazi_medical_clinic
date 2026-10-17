import { useTranslation } from 'react-i18next'
import type { NavItem } from '@mmc/shared'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'

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
      className="pc:flex hidden w-[92px] flex-none flex-col items-center gap-2 bg-[linear-gradient(180deg,var(--mmc-navy),var(--mmc-navy-2))] px-3 py-4 text-white"
    >
      {nav.map((n, i) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'anim-enter flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-[14px] text-[10px] font-semibold text-white/70 no-underline transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white focus-visible:ring-[3px] focus-visible:ring-white/40 focus-visible:outline-none active:scale-[0.97]',
              active && 'bg-white/15 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]',
            )}
            style={{ '--i': i } as React.CSSProperties}
          >
            <Icon name={n.icon} size={20} />
            <span className="max-w-full truncate px-1">{t(n.labelKey)}</span>
          </StaffLink>
        )
      })}
      <div className="flex-1" />
      <div className="px-1 text-center text-[10px] leading-tight text-white/60 tabular-nums">
        {clock}
      </div>
    </nav>
  )
}
