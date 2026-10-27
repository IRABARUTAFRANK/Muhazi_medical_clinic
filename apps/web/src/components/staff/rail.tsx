import { useTranslation } from 'react-i18next'
import type { NavItem, StaffUser } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { groupNav } from '@/lib/nav'
import { roleLabel } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'
import { NavIcon } from './nav-icon'

interface RailProps {
  nav: NavItem[]
  activeId?: string
  /** "Thu 15/10/2026 · 12:45" */
  clock: string
  /** The signed-in person, shown at the bottom (left out: only the clock). */
  user?: StaffUser
}

/**
 * PC sidebar: 220 px, white, a 1 px right border. The clinic name and small logo at the top
 * (40 px), then the menu in groups (Work, Patients, Finance, Stock, Management, Inbox): an
 * 11 px uppercase grey label over each group (the one place uppercase is allowed), 36 px items
 * with icon and label, the active one on a teal tint (no solid fill would shout), 12 px between
 * groups; a group with nothing for this person is not drawn. The menu scrolls inside itself
 * when the screen is short; the signed-in person and the clock stay at the bottom.
 */
export function Rail({ nav, activeId, clock, user }: RailProps) {
  const { t } = useTranslation()
  const groups = groupNav(nav)
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="pc:flex border-border bg-card hidden w-[220px] flex-none flex-col border-r"
    >
      <StaffLink
        to="/app"
        aria-label={t('app.staffHome')}
        className="text-ink border-border flex h-10 flex-none items-center gap-2 border-b px-3 no-underline"
      >
        <img src="/logo.jpg" alt="" className="size-6 flex-none rounded-full object-cover" />
        <span className="truncate text-[14px] font-semibold">{t('app.clinicName')}</span>
      </StaffLink>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2 pt-1">
        {groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={`rail-group-${g.id}`}>
            <div
              id={`rail-group-${g.id}`}
              className="text-ink-3 mt-2 mb-1 px-2.5 text-[11px] font-semibold tracking-[0.06em] uppercase"
            >
              {t(g.labelKey)}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((n) => {
                const active = n.id === activeId
                return (
                  <StaffLink
                    key={n.id}
                    to={n.to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'focus-visible:ring-primary/20 flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[14px] font-medium no-underline transition-colors duration-120 focus-visible:ring-2 focus-visible:outline-none',
                      active
                        ? 'bg-primary-tint text-primary'
                        : 'text-ink-2 hover:bg-hover hover:text-ink',
                    )}
                  >
                    <NavIcon id={n.id} name={n.icon} size={18} ring="ring-card" />
                    <span className="min-w-0 truncate">{t(n.labelKey)}</span>
                  </StaffLink>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="border-border flex flex-none flex-col gap-2 border-t p-3">
        {user && (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={user.name} size="sm" />
            <span className="flex min-w-0 flex-col leading-[1.2]">
              <span className="text-ink truncate text-[14px] font-medium">{user.name}</span>
              <span className="text-ink-3 truncate text-[12px]">{roleLabel(user, t)}</span>
            </span>
          </span>
        )}
        <span className="text-ink-3 text-[12px] tabular-nums">{clock}</span>
      </div>
    </nav>
  )
}
