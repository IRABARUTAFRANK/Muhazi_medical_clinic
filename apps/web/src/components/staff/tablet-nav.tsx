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
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl border-0 bg-transparent text-xs font-semibold text-white/70 no-underline transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-[0.97]'

/** Tablet bottom bar (navy like the rail): the same ≤ 5 items plus "More". */
export function TabletNav({ nav, activeId, onMore }: TabletNavProps) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="topbar-gradient pc:hidden flex flex-none gap-1 px-2 py-1.5 text-white"
    >
      {nav.map((n) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              tab,
              active && 'bg-white/15 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]',
            )}
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
