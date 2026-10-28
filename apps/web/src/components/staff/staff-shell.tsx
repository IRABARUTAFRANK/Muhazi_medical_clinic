import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
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
import { NAV_GROUPS, navGroupOf } from '@/lib/nav'
import { FilePanelHost } from '@/components/clinical/file-panel'
import { useNoticeFocus } from '@/lib/notice-focus'

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
  // ?focus=<kind>:<id> from a notice: that item comes into view, outlined (lib/notice-focus.ts)
  useNoticeFocus()
  const now = appNow()
  const clock = `${dayNames.short[now.getDay()]} ${formatDate(now)} · ${time ?? formatTime(now)}`
  // the open page's name for the top bar's breadcrumb
  const activeItem = nav.find((n) => n.id === activeId)
  const activeGroup = activeId ? NAV_GROUPS.find((g) => g.id === navGroupOf(activeId)) : undefined

  return (
    // Text size (Settings or the user menu) scales the whole staff screen; the height is divided
    // by the zoom so the zoomed frame still fills exactly one screen. --mmc-zoom keeps touch
    // targets at 44 px on the screen whatever the zoom (globals.css, --tap).
    <div
      data-shell
      className="bg-surface text-ink relative flex flex-col overflow-hidden text-sm"
      style={{ zoom, height: `calc(100dvh / ${zoom})`, '--mmc-zoom': zoom } as CSSProperties}
    >
      {/* while locked, nothing behind the lock screen can be reached (keyboard or reader) */}
      <div className="contents" inert={locked} aria-hidden={locked || undefined}>
        <TopBar
          user={user}
          sync={sync}
          onOpenSheet={() => setSheet(true)}
          title={activeItem ? t(activeItem.labelKey) : undefined}
          group={activeItem && activeGroup ? t(activeGroup.labelKey) : undefined}
        />
        {sync.status === 'offline' && <OfflineBanner />}
        <div data-shell-body className="flex min-h-0 flex-1">
          <Rail nav={nav} activeId={activeId} clock={clock} user={user} />
          {/* Workspace: a flat neutral surface behind the page (the class is kept for print). */}
          <div className="workspace bg-surface flex min-h-0 min-w-0 flex-1 flex-col">
            {children}
          </div>
        </div>
        {/* The patient file as a side panel (?file=<id> on any staff route), mounted once. */}
        <FilePanelHost />
        {tabletActions && (
          <div
            aria-label={t('common.quickActions')}
            className="border-border bg-card pc:hidden grid flex-none grid-cols-2 gap-2 border-t px-3 py-2 sm:flex sm:px-4 [&>*]:h-auto [&>*]:min-h-[max(2rem,var(--tap,0px))] [&>*]:min-w-0 [&>*]:py-1.5 [&>*]:whitespace-normal sm:[&>*]:flex-1"
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
