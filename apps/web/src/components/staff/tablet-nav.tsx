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
  'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl border-0 bg-transparent px-1 text-[11px] font-semibold text-white/70 no-underline transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-[0.97] sm:text-xs'

/** Tablet bottom bar (navy like the rail): the same ≤ 5 items plus "More". */
export function TabletNav({ nav, activeId, onMore }: TabletNavProps) {
  const { t } = useTranslation()
  const { shown, rest } = splitNav(nav, useBarCount(), activeId)
  const moreActive = rest.some((n) => n.id === activeId)
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="topbar-gradient pc:hidden flex flex-none gap-1 px-2 py-1.5 pb-[max(6px,env(safe-area-inset-bottom))] text-white"
    >
      {shown.map((n) => {
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
            <NavIcon id={n.id} name={n.icon} />
            <span className="max-w-full truncate">{t(n.labelKey)}</span>
          </StaffLink>
        )
      })}
      <button
        type="button"
        className={cn(tab, moreActive && 'bg-white/15 text-white')}
        onClick={onMore}
      >
        <span className="relative inline-flex">
          <Ellipsis size={22} aria-hidden="true" />
          {rest.some((n) => n.id === 'notifications') && <UnreadBadge />}
        </span>
        {t('common.more')}
      </button>
    </nav>
  )
}
