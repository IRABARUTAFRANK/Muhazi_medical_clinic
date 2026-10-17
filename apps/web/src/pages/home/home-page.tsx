import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CLINIC_HOURS,
  CLINIC_NOW,
  CLINIC_NOW_QUIET,
  ROLE_HOME,
  demoNow,
  type HomeMode,
  type HomeRole,
  type StaffUser,
} from '@mmc/shared'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Icon } from '@/components/ui/icon'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useHomeSummary } from '@/lib/api/home'
import { useClinicStatus, useClinicInfo } from '@/lib/api/public'
import { openItems, queueCounts, stationFor, useQueueBoard } from '@/lib/api/visits'
import { roleLabel } from '@/lib/roles'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/store/sync'
import { QueueCard } from './queue-card'
import { RolePanels } from './role-panels'

interface HomePageProps {
  user: StaffUser
  mode: HomeMode
}

/** Design clock per variant: normal 12:45, offline 14:52, quiet morning 07:42. */
const timeForMode: Record<HomeMode, string | undefined> = {
  normal: undefined,
  offline: '14:52',
  empty: '07:42',
}

/** Role-aware staff home: Clinic-now strip, my queue, today's panels, quick actions. */
export function HomePage({ user, mode }: HomePageProps) {
  const { t } = useTranslation()
  const role: HomeRole = user.role === 'manager' ? 'receptionist' : user.role
  const home = ROLE_HOME[role]
  const empty = mode === 'empty'
  // Clinic now: live from public_clinic_status() (waiting, average wait) and the bed board.
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)
  const { data: summary } = useHomeSummary()
  const sampleNow = empty ? CLINIC_NOW_QUIET : CLINIC_NOW
  const now = isLive
    ? {
        inClinic: status?.waiting ?? 0,
        avgWaitMin: status?.avgWaitMin ?? 0,
        bedsOccupied: summary?.beds.filter((b) => b.state === 'occupied').length ?? 0,
        bedsTotal: summary?.beds.filter((b) => b.state !== 'out_of_service').length ?? 0,
      }
    : sampleNow
  const station = user.role === 'doctor' && user.station ? user.station : home.station
  const setOverride = useSyncStore((s) => s.setOverride)

  useEffect(() => {
    if (mode === 'offline') {
      const since = demoNow()
      since.setHours(14, 20, 0, 0)
      setOverride({ status: 'offline', since, pending: 3 })
    } else {
      setOverride(null)
    }
    return () => setOverride(null)
  }, [mode, setOverride])

  // Live: today's queue at this user's station (reception sees every station).
  const myStation = role === 'receptionist' ? 'all' : stationFor(user)
  const { data: live = [] } = useQueueBoard(myStation, user.role)
  const liveRows = openItems(live)
  const rows = isLive ? liveRows : home.queue
  const counts = isLive
    ? queueCounts(live)
    : empty
      ? { waiting: 0, inProgress: 0, done: 0 }
      : home.counts
  const queueEmpty = isLive ? liveRows.length === 0 : empty

  const tabletActions = home.actions.map((a) => (
    <StaffLink
      key={a.id}
      to={a.to}
      className={cn(
        buttonVariants({ variant: a.primary ? 'primary' : 'default' }),
        'min-h-[52px] flex-1 px-2 text-center text-[13px] leading-tight whitespace-normal',
      )}
    >
      {t(a.labelKey)}
    </StaffLink>
  ))

  return (
    <StaffShell
      user={user}
      nav={home.nav}
      activeId="home"
      time={timeForMode[mode]}
      tabletActions={tabletActions}
    >
      <main className="pc:overflow-hidden pc:p-4 flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {/* CLINIC NOW */}
        <div className="border-border bg-card flex flex-none flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border px-4 py-2">
          <span className="text-ink-3 text-xs font-semibold tracking-[.04em] uppercase">
            {t('home.clinicNow')}
          </span>
          <Stat
            value={now.inClinic}
            label={t('home.inClinic')}
            shortLabel={t('home.inClinicShort')}
          />
          <Stat
            value={now.avgWaitMin}
            label={t('home.avgWait')}
            shortLabel={t('home.avgWaitShort')}
          />
          <Stat
            value={`${now.bedsOccupied} / ${now.bedsTotal}`}
            label={t('home.bedsOccupied')}
            shortLabel={t('home.bedsShort')}
          />
          <span className="flex-1" />
          <span className="text-ink-3 pc:inline hidden text-xs">
            {t('roles.view', { role: roleLabel(user, t) })}
          </span>
        </div>

        <div className="pc:grid pc:flex-1 pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_232px] flex min-h-0 flex-col gap-3">
          {/* ZONE 1: MY QUEUE */}
          <QueueCard
            title={t('home.myQueue', { station })}
            rows={rows}
            counts={counts}
            rowAction={home.rowAction}
            empty={queueEmpty}
            className="pc:min-h-0 flex-none"
          />

          {/* ZONE 2: TODAY */}
          <section
            aria-label={t('dashboard.ranges.today')}
            className="pc:overflow-hidden flex min-h-0 flex-col gap-3"
          >
            <RolePanels role={role} empty={empty} />
          </section>

          {/* ZONE 3: QUICK ACTIONS (PC) */}
          <Card aria-label={t('common.quickActions')} className="pc:flex hidden gap-2 p-3">
            <div className="px-1 pt-1 pb-2 font-semibold">{t('common.quickActions')}</div>
            {home.actions.map((a) => (
              <StaffLink
                key={a.id}
                to={a.to}
                className={cn(
                  buttonVariants({ variant: a.primary ? 'primary' : 'default' }),
                  'min-h-14 justify-start px-3.5 text-sm',
                )}
              >
                <Icon name={a.icon} size={20} />
                {t(a.labelKey)}
              </StaffLink>
            ))}
            <div className="flex-1" />
            <div className="text-ink-3 px-1 text-xs">{t('home.quickNote')}</div>
          </Card>
        </div>
      </main>
    </StaffShell>
  )
}

function Stat({
  value,
  label,
  shortLabel,
}: {
  value: number | string
  label: string
  shortLabel: string
}) {
  return (
    <span className="flex items-baseline gap-1.5 tabular-nums">
      <b className="text-xl font-bold">{value}</b>
      <span className="text-ink-2 pc:inline hidden">{label}</span>
      <span className="text-ink-2 pc:hidden">{shortLabel}</span>
    </span>
  )
}
