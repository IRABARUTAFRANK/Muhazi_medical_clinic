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

/** PC left rail: at most five items per role, date and time at the bottom. */
export function Rail({ nav, activeId, clock }: RailProps) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="border-border bg-card pc:flex hidden w-[200px] flex-none flex-col gap-1 border-r p-3"
    >
      {nav.map((n) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'text-ink-2 hover:bg-hover hover:text-ink flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium no-underline',
              active &&
                'bg-primary-tint text-primary hover:bg-primary-tint hover:text-primary font-semibold',
            )}
          >
            <Icon name={n.icon} size={20} />
            {t(n.labelKey)}
          </StaffLink>
        )
      })}
      <div className="flex-1" />
      <div className="text-ink-3 px-3 text-xs tabular-nums">{clock}</div>
    </nav>
  )
}
