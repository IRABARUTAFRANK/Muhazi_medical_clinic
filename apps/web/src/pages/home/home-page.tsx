import { useEffect, type ReactNode } from 'react'
import {
  Banknote,
  BedDouble,
  CalendarDays,
  CircleCheck,
  ClipboardCheck,
  Clock,
  FlaskConical,
  MessageSquare,
  Receipt,
  RefreshCw,
  Stethoscope,
  Timer,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLINIC_HOURS,
  CLINIC_NOW,
  CLINIC_NOW_QUIET,
  ROLE_HOME,
  demoNow,
  formatNumber,
  formatTime,
  type HomeMode,
  type HomeRole,
  type StaffUser,
} from '@mmc/shared'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Kpi, SectionTitle } from '@/components/dash/kit'
import { greetingFor } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useHomeSummary, type HomeSummary } from '@/lib/api/home'
import { useClinicStatus, useClinicInfo } from '@/lib/api/public'
import { openItems, queueCounts, stationFor, useQueueBoard } from '@/lib/api/visits'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/store/sync'
import { DeskDashboard } from './desk-dashboard'
import { ErrorBox, MyQueuePanel, RolePanels } from './role-panels'

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

/**
 * Staff home. Receptionists and nurses get their desk dashboard; doctors, cashiers and the lab,
 * pharmacy and ultrasound desks get the same dashboard design: identity banner, toolbar with
 * their quick actions, KPI tiles, then their queue and the work of the day.
 */
export function HomePage({ user, mode }: HomePageProps) {
  if (user.role === 'receptionist' || user.role === 'nurse')
    return <DeskDashboard user={user} role={user.role} />
  return <RoleHome user={user} mode={mode} />
}

function RoleHome({ user, mode }: HomePageProps) {
  const { t } = useTranslation()
  const role: HomeRole = user.role === 'manager' ? 'receptionist' : user.role
  const home = ROLE_HOME[role]
  const empty = mode === 'empty'
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)
  const { data: summary, error, refetch, isFetching, dataUpdatedAt } = useHomeSummary()
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
  const rows = isLive ? openItems(live) : empty ? [] : home.queue
  const counts = isLive
    ? queueCounts(live)
    : empty
      ? { waiting: 0, inProgress: 0, done: 0 }
      : home.counts

  const tabletActions = home.actions.map((a) => (
    <StaffLink
      key={a.id}
      to={a.to}
      className={cn(
        buttonVariants({ variant: a.primary ? 'primary' : 'default' }),
        'min-h-[52px] flex-1 px-2 text-center text-[14px] leading-tight whitespace-normal',
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
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        {/* WHO IS SIGNED IN */}
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        {/* TOOLBAR: what this desk is, freshness, quick actions */}
        <div className="anim-enter flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[240px] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <ClipboardCheck size={16} aria-hidden="true" className="text-primary" />
              {t('home.myQueue', { station })}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={15} aria-hidden="true" className="text-ink-3" />
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : new Date()),
              })}
            </span>
            {!isLive && <span className="text-ink-3">{t('dashboard.sampleData')}</span>}
          </div>
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {home.actions.map((a) => (
            <StaffLink
              key={a.id}
              to={a.to}
              className={cn(
                buttonVariants({ variant: a.primary ? 'primary' : 'default', size: 'md' }),
                'pc:inline-flex hidden',
              )}
            >
              <Icon name={a.icon} size={16} />
              {t(a.labelKey)}
            </StaffLink>
          ))}
        </div>

        {error && <ErrorBox>{t('dashboard.loadFailed', { message: error.message })}</ErrorBox>}

        {/* KPI TILES */}
        <RoleTiles role={role} summary={summary} counts={counts} now={now} />

        {/* THE WORK OF THE DAY */}
        <section className="flex flex-col gap-3">
          <SectionTitle icon={Workflow}>{t(`roleHome.section.${role}`)}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <MyQueuePanel
              title={t('home.myQueue', { station })}
              rows={rows}
              counts={counts}
              rowAction={home.rowAction}
            />
            {summary && (
              <div className="flex min-w-0 flex-col gap-4">
                <RolePanels role={role} data={summary} />
              </div>
            )}
          </div>
        </section>
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- tiles per role */

function RoleTiles({
  role,
  summary,
  counts,
  now,
}: {
  role: HomeRole
  summary: HomeSummary | undefined
  counts: { waiting: number; inProgress: number; done: number }
  now: { inClinic: number; avgWaitMin: number; bedsOccupied: number; bedsTotal: number }
}) {
  const { t } = useTranslation()
  const unitNow = t('dashboard.units.now')
  const unitToday = t('dashboard.period.today')
  const unitMin = t('dashboard.units.min')
  let tiles: ReactNode
  if (role === 'doctor') {
    const toReview = summary?.results.filter((r) => !r.verified).length ?? 0
    const mine = summary?.appointments.filter((a) => a.mine).length ?? 0
    const toAccept = summary?.toAccept.length ?? 0
    tiles = (
      <>
        <Kpi
          i={0}
          icon={Users}
          tint="amber"
          label={t('roleHome.tiles.waiting')}
          value={counts.waiting}
          unit={unitNow}
        />
        <Kpi
          i={1}
          icon={Stethoscope}
          tint="teal"
          label={t('roleHome.tiles.inProgress')}
          value={counts.inProgress}
          unit={unitNow}
        />
        <Kpi
          i={2}
          icon={CircleCheck}
          tint="mint"
          label={t('roleHome.tiles.seen')}
          value={counts.done}
          unit={unitToday}
        />
        <Kpi
          i={3}
          icon={FlaskConical}
          tint="violet"
          label={t('roleHome.tiles.results')}
          value={toReview}
          unit={t('roleHome.units.toReview')}
          delta={
            toReview > 0 ? { text: t('roleHome.reviewSoon'), good: false, up: null } : undefined
          }
        />
        <Kpi
          i={4}
          icon={CalendarDays}
          tint="navy"
          label={t('roleHome.tiles.myAppointments')}
          value={mine}
          unit={unitToday}
        />
        <Kpi
          i={5}
          icon={MessageSquare}
          tint="coral"
          label={t('roleHome.tiles.toAccept')}
          value={toAccept}
          unit={t('roleHome.units.toAnswer')}
          delta={toAccept > 0 ? { text: t('desk.answerSoon'), good: false, up: null } : undefined}
        />
      </>
    )
  } else if (role === 'cashier') {
    const bills = summary?.openBills ?? []
    const due = bills.reduce((s, b) => s + b.balance, 0)
    tiles = (
      <>
        <Kpi
          i={0}
          icon={Receipt}
          tint="coral"
          label={t('roleHome.tiles.openBills')}
          value={bills.length}
          unit={t('roleHome.units.toCollect')}
        />
        <Kpi
          i={1}
          icon={Wallet}
          tint="amber"
          label={t('roleHome.tiles.amountDue')}
          value={due}
          unit="RWF"
        />
        <Kpi
          i={2}
          icon={CircleCheck}
          tint="mint"
          label={t('roleHome.tiles.payments')}
          value={summary?.paidToday.count ?? 0}
          unit={unitToday}
        />
        <Kpi
          i={3}
          icon={Banknote}
          tint="violet"
          label={t('roleHome.tiles.collected')}
          value={summary?.paidToday.amount ?? 0}
          unit="RWF"
        />
        <Kpi
          i={4}
          icon={Users}
          tint="navy"
          label={t('roleHome.tiles.inClinic')}
          value={now.inClinic}
          unit={unitNow}
        />
        <Kpi
          i={5}
          icon={Timer}
          tint="teal"
          label={t('dashboard.tiles.avgWait')}
          value={now.avgWaitMin}
          unit={unitMin}
        />
      </>
    )
  } else {
    tiles = (
      <>
        <Kpi
          i={0}
          icon={Users}
          tint="amber"
          label={t('roleHome.tiles.waiting')}
          value={counts.waiting}
          unit={unitNow}
        />
        <Kpi
          i={1}
          icon={Users}
          tint="navy"
          label={t('roleHome.tiles.inClinic')}
          value={now.inClinic}
          unit={unitNow}
        />
        <Kpi
          i={2}
          icon={Timer}
          tint="coral"
          label={t('dashboard.tiles.avgWait')}
          value={now.avgWaitMin}
          unit={unitMin}
        />
        <Kpi
          i={3}
          icon={BedDouble}
          tint="teal"
          label={t('dashboard.tiles.beds')}
          value={now.bedsOccupied}
          unit={`/ ${formatNumber(now.bedsTotal)} ${t('dashboard.units.beds')}`}
        />
      </>
    )
  }
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">{tiles}</div>
}
