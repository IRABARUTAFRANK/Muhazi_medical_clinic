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
 * PC sidebar: 220 px on its own light surface with a 1 px right border. The clinic block at the
 * top (44 px) sits on the clinic's navy → teal hero with the logo and the name in white. Then
 * the menu in groups (Work, Patients, Finance, Stock, Management, Inbox), each group a rounded
 * block filled with its light tint (work = teal, patients = clinical blue, finance = mint,
 * stock = amber, manage = lavender, inbox = rose; .rail-* in globals.css): the group's label in
 * its hue (11 px uppercase, the one place uppercase is allowed), 36 px items with icon and
 * label, the active item a white pill with the hue's text and a 3 px bar at its left (the hue
 * fades in over 160 ms); 10 px between groups; a group with nothing for this person is not
 * drawn. The menu scrolls inside itself when the screen is short; the signed-in person and the
 * clock stay at the bottom on white with a rule above.
 */
export function Rail({ nav, activeId, clock, user }: RailProps) {
  const { t } = useTranslation()
  const groups = groupNav(nav)
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="pc:flex border-border bg-rail hidden w-[220px] flex-none flex-col border-r"
    >
      <StaffLink
        to="/app"
        aria-label={t('app.staffHome')}
        className="hero hero-clinic flex h-11 flex-none items-center gap-2.5 px-3 text-white no-underline"
      >
        <img
          src="/logo.jpg"
          alt=""
          className="size-7 flex-none rounded-full object-cover ring-2 ring-white/40"
        />
        <span className="truncate text-[14px] font-semibold">{t('app.clinicName')}</span>
      </StaffLink>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
        {groups.map((g) => (
          <div
            key={g.id}
            role="group"
            aria-labelledby={`rail-group-${g.id}`}
            className={cn('rail-group p-1.5', `rail-${g.id}`)}
          >
            <div
              id={`rail-group-${g.id}`}
              className="rail-label mt-1 mb-1 px-2 text-[11px] font-semibold tracking-[0.06em] uppercase"
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
                    className="rail-item focus-visible:ring-primary/20 flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] leading-tight font-medium no-underline focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <NavIcon id={n.id} name={n.icon} size={18} ring="ring-card" />
                    {/* a long label (Kinyarwanda) wraps by word instead of being cut */}
                    <span className="min-w-0 [overflow-wrap:normal]">{t(n.labelKey)}</span>
                  </StaffLink>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="border-border bg-card flex flex-none flex-col gap-2 border-t p-3">
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
