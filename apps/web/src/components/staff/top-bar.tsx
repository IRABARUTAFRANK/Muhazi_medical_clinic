import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Logo } from '@/components/public/logo'
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
      className={`border-border bg-card text-ink-3 pc:h-10 flex h-10 items-center gap-2 rounded-lg border px-3 text-sm ${className ?? ''}`}
    >
      <Search size={18} aria-hidden="true" />
      <input
        type="search"
        placeholder={t('common.searchPatient')}
        aria-label={t('common.searchPatient')}
        className="text-ink min-w-0 flex-1 border-0 bg-transparent outline-none"
      />
    </label>
  )
}

/**
 * Top bar on every staff screen: logo + name, global patient search, sync badge,
 * current user with one-tap switch, language switch. Two rows on tablets.
 */
export function TopBar({ user, sync, onOpenSheet }: TopBarProps) {
  const { t } = useTranslation()
  return (
    <header className="border-border bg-card relative z-[6] flex-none border-b">
      {/* PC: one 56 px row */}
      <div className="pc:flex hidden h-14 items-center gap-4 px-4">
        <Logo
          to="/app"
          size="md"
          subtitle={t('app.shortPlace')}
          ariaLabel={t('app.staffHome')}
          className="min-w-[220px]"
        />
        <PatientSearch className="max-w-[420px] flex-1" />
        <div className="flex-1" />
        <SyncBadge state={sync} />
        <UserMenu user={user} />
        <LangSwitch size="sm" />
      </div>
      {/* Tablet: two rows */}
      <div className="pc:hidden flex flex-col gap-2 px-4 py-2">
        <div className="flex items-center gap-3">
          <Logo to="/app" size="md" subtitle={t('app.shortPlace')} ariaLabel={t('app.staffHome')} />
          <span className="flex-1" />
          <SyncBadge state={sync} />
          <LangSwitch />
        </div>
        <div className="flex items-center gap-3">
          <PatientSearch className="h-11 flex-1" />
          <UserMenu user={user} onOpenSheet={onOpenSheet} />
        </div>
      </div>
    </header>
  )
}
