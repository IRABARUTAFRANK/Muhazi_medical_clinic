import { useTranslation } from 'react-i18next'
import type { StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Logo } from '@/components/public/logo'
import { cn } from '@/lib/utils'
import { GlobalSearch } from './global-search'
import { NotificationBell } from './notification-bell'
import { SyncBadge } from './sync-badge'
import { UserMenu } from './user-menu'

interface TopBarProps {
  user: StaffUser
  sync: SyncState
  onOpenSheet: () => void
  /** The open page's name, after the clinic's in the breadcrumb ("Clinic / Patients / History"). */
  title?: string
  /** The sidebar group the page belongs to, between the clinic and the page. */
  group?: string
}

/**
 * Top bar on every staff screen: 48 px, white at 92 % with an 8 px blur so the workspace's
 * gradient shows through (.topbar), a 1 px bottom border. On a PC the sidebar
 * carries the logo, so the bar starts with the breadcrumb ("Clinic / Group / Page"), then the
 * search pill, sync state, bell, user menu and the language switch. Tablets and phones have
 * no sidebar: the logo comes first, and the search gets a second row.
 */
export function TopBar({ user, sync, onOpenSheet, title, group }: TopBarProps) {
  const { t } = useTranslation()
  return (
    <header className="topbar border-border relative z-[6] flex-none border-b">
      {/* PC: one 48 px row */}
      <div className="pc:flex hidden h-12 items-center gap-3 px-4">
        {/* the breadcrumb takes the free space, so nothing is cut while there is room */}
        <span className="text-ink-3 flex min-w-0 flex-1 items-center gap-1.5 text-[14px]">
          {/* the clinic's name is in the sidebar's header right beside it: it shows on a wide
              screen only (1600 px) and is the first to be shortened, then the group; the page's
              name is the last (long in Kinyarwanda) */}
          <span className="wide:inline hidden min-w-0 shrink-[100] truncate">
            {t('app.clinicName')}
          </span>
          {group && group !== title && (
            <>
              <span className="text-ink-4 wide:inline hidden" aria-hidden="true">
                /
              </span>
              <span className="min-w-0 shrink-[10] truncate">{group}</span>
            </>
          )}
          {title && (
            <>
              <span
                className={cn('text-ink-4', !(group && group !== title) && 'wide:inline hidden')}
                aria-hidden="true"
              >
                /
              </span>
              <span className="text-ink min-w-0 truncate font-medium" title={title}>
                {title}
              </span>
            </>
          )}
        </span>
        <GlobalSearch user={user} className="w-[min(320px,20vw)] min-w-[180px] flex-none" />
        <SyncBadge state={sync} />
        <NotificationBell user={user} />
        <UserMenu user={user} />
        <span className="hidden xl:inline-flex">
          <LangSwitch size="sm" />
        </span>
      </div>
      {/* Tablet and phone: two rows. Phones keep only the logo, bell and person on the first
          row (sync state and language live in the "More" sheet) and the search on the second. */}
      <div className="pc:hidden flex flex-col gap-1.5 px-3 py-1.5 sm:px-4">
        <div className="flex h-10 items-center gap-2 sm:gap-3">
          <Logo
            to="/app"
            size="md"
            compact
            subtitle={t('app.shortPlace')}
            ariaLabel={t('app.staffHome')}
            className="min-w-0 [&_img]:size-7 [&_span>span:first-child]:text-[14px] [&_span>span:first-child]:font-semibold"
          />
          <span className="flex-1" />
          <span className="hidden md:inline-flex">
            <SyncBadge state={sync} />
          </span>
          <NotificationBell user={user} />
          <span className="hidden lg:inline-flex">
            <LangSwitch size="sm" />
          </span>
          <UserMenu user={user} onOpenSheet={onOpenSheet} />
        </div>
        <GlobalSearch user={user} />
      </div>
    </header>
  )
}
