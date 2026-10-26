import { Ellipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NavItem } from '@mmc/shared'
import { splitNav, useBarCount } from '@/lib/bottom-bar'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'
import { NavIcon, UnreadBadge } from './nav-icon'

interface TabletNavProps {
  nav: NavItem[]
  activeId?: string
  onMore: () => void
}

const tab =
  'flex min-h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border-0 bg-transparent px-1 text-[12px] font-medium text-ink-2 no-underline transition-colors duration-120 hover:bg-hover hover:text-ink'

/** Tablet bottom bar: white with a 1 px top border, the same ≤ 5 items plus "More". */
export function TabletNav({ nav, activeId, onMore }: TabletNavProps) {
  const { t } = useTranslation()
  const { shown, rest } = splitNav(nav, useBarCount(), activeId)
  const moreActive = rest.some((n) => n.id === activeId)
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="border-border bg-card pc:hidden flex flex-none gap-1 border-t px-2 py-1 pb-[max(4px,env(safe-area-inset-bottom))]"
    >
      {shown.map((n) => {
        const active = n.id === activeId
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(tab, active && 'bg-primary-tint text-primary')}
          >
            <NavIcon id={n.id} name={n.icon} size={20} />
            <span className="max-w-full truncate">{t(n.labelKey)}</span>
          </StaffLink>
        )
      })}
      <button
        type="button"
        className={cn(tab, moreActive && 'bg-primary-tint text-primary')}
        onClick={onMore}
      >
        <span className="relative inline-flex">
          <Ellipsis size={20} aria-hidden="true" />
          {rest.some((n) => n.id === 'notifications') && <UnreadBadge />}
        </span>
        {t('common.more')}
      </button>
    </nav>
  )
}
