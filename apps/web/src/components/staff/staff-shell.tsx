import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type NavItem, type StaffUser } from '@mmc/shared'
import { useStaffSettings } from '@/lib/api/settings'
import { appNow } from '@/lib/clock'
import { useDayNames } from '@/lib/hooks'
import { usePrefsSync } from '@/lib/prefs-sync'
import { TEXT_ZOOM, usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'
import { useSyncState } from '@/store/sync'
import { IdleWarning, LockScreen } from './lock-screen'
import { MoreSheet } from './more-sheet'
import { OfflineBanner } from './offline-banner'
import { Rail } from './rail'
import { TabletNav } from './tablet-nav'
import { TopBar } from './top-bar'
import { splitNav, useBarCount } from '@/lib/bottom-bar'

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

/** Frame of every staff screen: top bar, offline banner, rail (PC) or bottom bar (tablet), the
 *  warning before the sign-out for inactivity and the screen locked by the person. */
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
  // Hours without activity before the tab signs out: a change by the manager reaches open tabs.
  const { data: staffSettings } = useStaffSettings()
  const sessionHours = staffSettings?.sessionHours
  useEffect(() => {
    if (sessionHours != null) useSession.getState().setSessionHours(sessionHours)
  }, [sessionHours])
  const [sheet, setSheet] = useState(false)
  const barCount = useBarCount()
  const zoom = TEXT_ZOOM[usePrefs((s) => s.textSize)] ?? 1
  // Text size, theme and language follow the person to every device.
  usePrefsSync(user.id)
  const now = appNow()
  const clock = `${dayNames.short[now.getDay()]} ${formatDate(now)} · ${time ?? formatTime(now)}`

  return (
    // Text size (Settings or the user menu) scales the whole staff screen; the height is divided
    // by the zoom so the zoomed frame still fills exactly one screen.
    <div
      data-shell
      className="bg-surface text-ink relative flex flex-col overflow-hidden text-sm"
      style={{ zoom, height: `calc(100dvh / ${zoom})` }}
    >
      {/* while locked, nothing behind the lock screen can be reached (keyboard or reader) */}
      <div className="contents" inert={locked} aria-hidden={locked || undefined}>
        <TopBar user={user} sync={sync} onOpenSheet={() => setSheet(true)} />
        {sync.status === 'offline' && <OfflineBanner />}
        <div data-shell-body className="flex min-h-0 flex-1">
          <Rail nav={nav} activeId={activeId} clock={clock} />
          {/* Workspace: calm sky-blue surface with a faint dot texture behind the page. */}
          <div className="workspace flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </div>
        {tabletActions && (
          <div
            aria-label={t('common.quickActions')}
            className="border-border bg-card/90 pc:hidden grid flex-none grid-cols-2 gap-2 border-t px-3 py-2 backdrop-blur sm:flex sm:px-4 sm:[&>*]:flex-1"
          >
            {tabletActions}
          </div>
        )}
        <TabletNav nav={nav} activeId={activeId} onMore={() => setSheet(true)} />
        {sheet && (
          <MoreSheet
            user={user}
            nav={splitNav(nav, barCount, activeId).rest}
            activeId={activeId}
            sync={sync}
            onClose={() => setSheet(false)}
          />
        )}
      </div>
      {!locked && <IdleWarning />}
      {locked && <LockScreen />}
    </div>
  )
}
