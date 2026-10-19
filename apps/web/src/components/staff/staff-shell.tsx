import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type NavItem, type StaffUser } from '@mmc/shared'
import { appNow } from '@/lib/clock'
import { useDayNames } from '@/lib/hooks'
import { useStaffSettings } from '@/lib/api/settings'
import { TEXT_ZOOM, usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'
import { useSyncState } from '@/store/sync'
import { IdleWarning, LockScreen, useIdleLock } from './lock-screen'
import { MoreSheet } from './more-sheet'
import { OfflineBanner } from './offline-banner'
import { Rail } from './rail'
import { TabletNav } from './tablet-nav'
import { TopBar } from './top-bar'

interface StaffShellProps {
  user: StaffUser
  nav: NavItem[]
  activeId?: string
  /** Time shown in the rail clock, hh:mm (defaults to the app clock). */
  time?: string
  /** Tablet-only sticky row rendered above the bottom bar (quick actions). */
  tabletActions?: ReactNode
  children: ReactNode
}

/** Frame of every staff screen: top bar, offline banner, rail (PC) or bottom bar (tablet), idle lock. */
export function StaffShell({
  user,
  nav,
  activeId,
  time,
  tabletActions,
  children,
}: StaffShellProps) {
  const { t } = useTranslation()
  const sync = useSyncState()
  const dayNames = useDayNames()
  const locked = useSession((s) => s.locked)
  const [sheet, setSheet] = useState(false)
  const zoom = TEXT_ZOOM[usePrefs((s) => s.textSize)] ?? 1
  const { data: staffSettings } = useStaffSettings()
  const lockIn = useIdleLock(staffSettings?.idleMinutes ?? 120)
  const now = appNow()
  const clock = `${dayNames.short[now.getDay()]} ${formatDate(now)} · ${time ?? formatTime(now)}`

  return (
    // Text size (Settings or the user menu) scales the whole staff screen; the height is divided
    // by the zoom so the zoomed frame still fills exactly one screen.
    <div
      className="bg-surface text-ink relative flex flex-col overflow-hidden text-sm"
      style={{ zoom, height: `calc(100dvh / ${zoom})` }}
    >
      <TopBar user={user} sync={sync} onOpenSheet={() => setSheet(true)} />
      {sync.status === 'offline' && <OfflineBanner />}
      <div className="flex min-h-0 flex-1">
        <Rail nav={nav} activeId={activeId} clock={clock} />
        {/* Workspace: calm sky-blue surface with a faint dot texture behind the page. */}
        <div className="workspace flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {tabletActions && (
        <div
          aria-label={t('common.quickActions')}
          className="border-border bg-card/90 pc:hidden flex flex-none gap-2 border-t px-4 py-2 backdrop-blur"
        >
          {tabletActions}
        </div>
      )}
      <TabletNav nav={nav} activeId={activeId} onMore={() => setSheet(true)} />
      {sheet && <MoreSheet user={user} onClose={() => setSheet(false)} />}
      {!locked && lockIn != null && <IdleWarning seconds={lockIn} />}
      {locked && <LockScreen />}
    </div>
  )
}
