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
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePeriod } from '@/lib/period'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
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
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Kpi, SectionTitle } from '@/components/dash/kit'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { AccessApprovalsPanel } from '@/components/privacy/approvals'
import { greetingFor } from '@/components/dash/kit-style'
import { periodSearch, useAnalyticsLink } from '@/components/dash/analytics-links'
import { Button, buttonVariants } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useHomeSummary, type HomeSummary } from '@/lib/api/home'
import { useClinicStatus, useClinicInfo } from '@/lib/api/public'
import {
  mineElsewhere,
  onePerPool,
  openItems,
  queueCounts,
  stationFor,
  useQueueBoard,
} from '@/lib/api/visits'
import { useCan } from '@/lib/api/permissions'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/store/sync'
import { CashierDashboard } from './cashier-dashboard'
import { HandoverPanel } from './handover-panel'
import { DeskDashboard } from './desk-dashboard'
import { LabDashboard } from './lab-dashboard'
import { ErrorBox, MyQueuePanel, RolePanels, ToAcceptSection } from './role-panels'
import { CallsPanel } from './calls-panel'
import { DeskOrdersPanel } from './desk-orders-panel'
import { PharmacyDashboard } from './pharmacy-dashboard'
import { DeskBlocks } from './home-desks'
import { actionShown, homeKindFor, useHomeDesks } from './home-desks-rules'
import { OpenNextButton } from './open-next'

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
 *
 * The role picks the dashboard while the person works at one of its desks (0085: their
 * departments decide); otherwise the dashboard of a desk they do work at (a doctor only in the
 * Laboratory: the laboratory bench). The desks their departments give beyond it add blocks.
 */
export function HomePage({ user, mode }: HomePageProps) {
  const { desks } = useHomeDesks(user)
  const { kind } = homeKindFor(user.role, desks)
  if (kind === 'cashier') return <CashierDashboard user={user} />
  if (kind === 'reception') return <DeskDashboard user={user} role="receptionist" />
  if (kind === 'nurse') return <DeskDashboard user={user} role="nurse" />
  if (kind === 'lab') return <LabDashboard user={user} />
  if (kind === 'pharmacy') return <PharmacyDashboard user={user} />
  return <RoleHome user={user} mode={mode} />
}

function RoleHome({ user, mode }: HomePageProps) {
  const { t } = useTranslation()
  const role: HomeRole = user.role === 'manager' ? 'receptionist' : user.role
  const { desks } = useHomeDesks(user)
  const can = useCan(user)
  // the quick actions of the desks the person works at, as far as the manager allows them
  const home = {
    ...ROLE_HOME[role],
    actions: ROLE_HOME[role].actions.filter((a) =>
      // the manager's toolbar never changes
      actionShown(a.id, desks, user.role === 'manager' ? undefined : can),
    ),
  }
  const empty = mode === 'empty'
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = usePeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const periodWord = t(`dashboard.period.${period.range}`)
  const { data: summary, error, refetch, isFetching, dataUpdatedAt } = useHomeSummary(days)
  const sampleNow = empty ? CLINIC_NOW_QUIET : CLINIC_NOW
  const now = isLive
    ? {
        inClinic: status?.waiting ?? 0,
        bedsOccupied: summary?.beds.filter((b) => b.state === 'occupied').length ?? 0,
        bedsTotal: summary?.beds.filter((b) => b.state !== 'out_of_service').length ?? 0,
      }
    : sampleNow
  // the desk's own name (live: from the profile; no sample "Consultation 1")
  const station =
    user.role === 'doctor' && user.station
      ? user.station
      : isLive
        ? t(`register.stations.${stationFor(user)}`)
        : home.station
  const setOverride = useSyncStore((s) => s.setOverride)
  // a head of department: "Seen" opens their own work on the Analytics page (others: no link)
  const link = useAnalyticsLink(periodSearch(period))
  const seenLink = link('staff', { person: user.id, kind: 'patientsSeen' })

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
  // also the patients at other desks that are theirs: sent to them by name, or to a section they
  // work in (a doctor of Nursing, a nurse of Consultation)
  const { data: everyone = [] } = useQueueBoard('all', user.role)
  const elsewhere = myStation === 'all' ? [] : mineElsewhere(everyone, myStation)
  // a patient sent to several desks at once (all mine) is one row
  const rows = isLive ? onePerPool([...openItems(live), ...elsewhere]) : empty ? [] : home.queue
  // the tiles count the patients this person may work on (not those sent to a colleague)
  const counts = isLive
    ? (() => {
        const c = queueCounts(
          onePerPool([...live, ...elsewhere]).filter((r) => r.canWork !== false),
        )
        // a doctor's "Seen": the patients this doctor took and finished, not the desk's
        if (user.role === 'doctor')
          c.done =
            summary?.seenToday ??
            everyone.filter((r) => r.finishedAt && r.takenById === user.id).length
        return c
      })()
    : empty
      ? { waiting: 0, inProgress: 0, done: 0 }
      : home.counts

  // "Open next patient" takes the next patient of the desk and opens the visit.
  const takesNext = (id: string) => id === 'openNext' && user.role === 'doctor'
  const tabletActions = home.actions.map((a) =>
    takesNext(a.id) ? (
      <OpenNextButton
        key={a.id}
        user={user}
        className="[&>button]:h-auto [&>button]:min-h-9 [&>button]:w-full [&>button]:px-2 [&>button]:py-1.5 [&>button]:whitespace-normal"
      />
    ) : (
      <StaffLink
        key={a.id}
        to={a.to}
        className={cn(
          buttonVariants({ variant: a.primary ? 'primary' : 'default' }),
          'h-auto min-h-9 px-2 py-1.5 text-center leading-tight whitespace-normal',
        )}
      >
        {t(a.labelKey)}
      </StaffLink>
    ),
  )

  return (
    <StaffShell
      user={user}
      nav={navForUser(user)}
      activeId="home"
      time={timeForMode[mode]}
      tabletActions={tabletActions}
    >
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* WHO IS SIGNED IN */}
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        {/* TOOLBAR: what this desk is, freshness, quick actions */}
        <div className="flex flex-wrap items-center gap-3">
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
          <PeriodSeg period={period} />
          <Button
            variant="tint-grey"
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {home.actions.map((a) =>
            takesNext(a.id) ? (
              <OpenNextButton key={a.id} user={user} className="pc:inline-flex hidden" />
            ) : (
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
            ),
          )}
          <PeriodCustom period={period} className="basis-full" />
        </div>

        {error && <ErrorBox>{t('dashboard.loadFailed', { message: error.message })}</ErrorBox>}

        {/* KPI TILES */}
        <RoleTiles
          role={role}
          summary={summary}
          counts={counts}
          now={now}
          periodWord={periodWord}
          seenLink={seenLink}
        />

        {/* Bookings to accept right under the tiles while there is something to answer (a notice
            "Booking to accept" points here); empty, the doctor's panel stays at the bottom */}
        {summary && <ToAcceptSection items={summary.toAccept} />}

        {/* Patients a colleague hands over to me (Take / Decline), and mine waiting (0088) */}
        <HandoverPanel />

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
                <CallsPanel user={user} />
                {/* orders sent to this doctor's desk (dental, minor surgery, consultation…) */}
                {user.role === 'doctor' && (
                  <DeskOrdersPanel
                    station={stationFor(user)}
                    title={t('desk.ordersAt', { desk: station })}
                    hideEmpty
                  />
                )}
                {/* a head of department: colleagues asking to see past records */}
                <AccessApprovalsPanel user={user} />
                <NoticesPanel limit={4} />
                <RolePanels role={role} data={summary} />
              </div>
            )}
          </div>
        </section>
        {/* the desks the person's departments give besides this one (the lab, the pharmacy…) */}
        <DeskBlocks user={user} kind="doctor" />
        <DoctorCalendarsSection user={user} />
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
  periodWord,
  seenLink,
}: {
  role: HomeRole
  summary: HomeSummary | undefined
  counts: { waiting: number; inProgress: number; done: number }
  /** No average waiting time on the tiles: the waiting times are on the Analytics page. */
  now: { inClinic: number; bedsOccupied: number; bedsTotal: number }
  /** "today", "this week"…: what the counted tiles cover. */
  periodWord: string
  /** The person's own work on the Analytics page (heads of department only). */
  seenLink?: string
}) {
  const { t } = useTranslation()
  const unitNow = t('dashboard.units.now')
  const unitToday = periodWord
  let tiles: ReactNode
  if (role === 'doctor') {
    // verified results the doctor has not seen yet
    const toReview = summary?.results.filter((r) => r.verified && !r.reviewed).length ?? 0
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
          to={seenLink}
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
          // the "Bookings to accept" panel of this page, brought into view and outlined
          to="/app?focus=to_accept"
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
          icon={BedDouble}
          tint="teal"
          label={t('dashboard.tiles.beds')}
          value={now.bedsOccupied}
          unit={`/ ${formatNumber(now.bedsTotal)} ${t('dashboard.units.beds')}`}
        />
      </>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3">
      {tiles}
    </div>
  )
}
