import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Logo } from '@/components/public/logo'
import { NotificationBell } from './notification-bell'
import { SyncBadge } from './sync-badge'
import { UserMenu } from './user-menu'

interface TopBarProps {
  user: StaffUser
  sync: SyncState
  onOpenSheet: () => void
}

function PatientSearch({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <label
      className={`glass-dark flex h-11 items-center gap-2.5 rounded-xl px-3.5 text-sm text-white/70 transition-[background-color,box-shadow] duration-150 focus-within:bg-white/15 focus-within:ring-[3px] focus-within:ring-white/25 ${className ?? ''}`}
    >
      <Search size={18} aria-hidden="true" />
      <input
        type="search"
        placeholder={t('common.searchPatient')}
        aria-label={t('common.searchPatient')}
        className="min-w-0 flex-1 border-0 bg-transparent text-white outline-none placeholder:text-white/60"
      />
      <kbd className="hidden rounded-md border border-white/20 px-1.5 text-[11px] text-white/60 lg:inline">
        /
      </kbd>
    </label>
  )
}

/**
 * Top bar on every staff screen (Figma: Manager Dashboard v2): the same navy as the rail so the
 * two form one frame around the workspace. Logo and name, global patient search, sync badge,
 * current user, language switch. Two rows on tablets.
 */
export function TopBar({ user, sync, onOpenSheet }: TopBarProps) {
  const { t } = useTranslation()
  const logoClass = 'text-white [&_span]:text-white [&_span>span:last-child]:text-white/65'
  return (
    <header className="topbar-gradient relative z-[6] flex-none text-white shadow-[0_6px_24px_rgba(11,34,82,0.25)]">
      {/* PC: one 64 px row */}
      <div className="pc:flex hidden h-16 items-center gap-3 px-4 xl:gap-4">
        <Logo
          to="/app"
          size="md"
          compact
          subtitle={t('app.shortPlace')}
          ariaLabel={t('app.staffHome')}
          className={`flex-none ${logoClass}`}
        />
        <PatientSearch className="min-w-[150px] flex-1 xl:max-w-[440px]" />
        <div className="hidden flex-1 xl:block" />
        <SyncBadge state={sync} />
        <NotificationBell user={user} />
        <UserMenu user={user} onDark />
        <span className="hidden xl:inline-flex">
          <LangSwitch size="sm" />
        </span>
      </div>
      {/* Tablet and phone: two rows. Phones keep only the logo, bell and person on the first
          row (sync state and language live in the "More" sheet) and the search on the second. */}
      <div className="pc:hidden flex flex-col gap-2 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <Logo
            to="/app"
            size="md"
            compact
            subtitle={t('app.shortPlace')}
            ariaLabel={t('app.staffHome')}
            className={`min-w-0 ${logoClass}`}
          />
          <span className="flex-1" />
          <span className="hidden md:inline-flex">
            <SyncBadge state={sync} />
          </span>
          <NotificationBell user={user} />
          <span className="hidden lg:inline-flex">
            <LangSwitch />
          </span>
          <UserMenu user={user} onOpenSheet={onOpenSheet} onDark />
        </div>
        <PatientSearch className="h-11" />
      </div>
    </header>
  )
}
