import { Ellipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NavItem } from '@mmc/shared'
import { Icon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'

interface TabletNavProps {
  nav: NavItem[]
  activeId?: string
  onMore: () => void
}

const tab =
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg border-0 bg-transparent text-xs font-semibold text-ink-2 no-underline'

/** Tablet bottom bar: the same ≤ 5 items plus "More" (user switch, dashboard, theme). */
export function TabletNav({ nav, activeId, onMore }: TabletNavProps) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="border-border bg-card pc:hidden flex flex-none gap-1 border-t px-2 py-1.5"
    >
      {nav.map((n) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(tab, active && 'bg-primary-tint text-primary')}
          >
            <Icon name={n.icon} size={22} />
            {t(n.labelKey)}
          </StaffLink>
        )
      })}
      <button type="button" className={tab} onClick={onMore}>
        <Ellipsis size={22} aria-hidden="true" />
        {t('common.more')}
      </button>
    </nav>
  )
}
