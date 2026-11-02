import { useEffect, type ReactNode } from 'react'
import {
  Banknote,
  CalendarDays,
  CircleCheck,
  ClipboardCheck,
  Clock,
  FlaskConical,
  ListTodo,
  MessageSquare,
  Receipt,
  RefreshCw,
  Stethoscope,
  UserRoundCheck,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchPeriod } from '@/lib/period'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import {
  ROLE_HOME,
  demoNow,
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
import { useMySummary, type MySummary } from '@/lib/api/my'
import { stationFor } from '@/lib/api/visits'
import { useCan } from '@/lib/api/permissions'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/store/sync'
import { CashierDashboard } from './cashier-dashboard'
import { HandoverPanel } from './handover-panel'
import { DeskDashboard } from './desk-dashboard'
import { LabDashboard } from './lab-dashboard'
import { ErrorBox, RolePanels, ToAcceptSection } from './role-panels'
import { CallsPanel } from './calls-panel'
import { DeskOrdersPanel } from './desk-orders-panel'
import { PharmacyDashboard } from './pharmacy-dashboard'
import { DeskBlocks } from './home-desks'
import { actionShown, homeKindFor, useHomeDesks } from './home-desks-rules'
import { MyWorkPanel, WaitingForMePanel } from './my-panels'
import { WORK_OF } from './my-work'
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
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = useSearchPeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const periodWord = t(`dashboard.period.${period.range}`)
  const { data: summary, error, refetch, isFetching, dataUpdatedAt } = useHomeSummary(days)
  // my own queue and my own work (0120): sent to me by name first, then my desks
  const { data: myGot, refetch: refetchMine } = useMySummary(days)
  // the quiet-morning design: nobody waits, nothing done yet
  const my: MySummary | undefined =
    empty && myGot
      ? {
          ...myGot,
          waiting: [],
          counts: { sentToMe: 0, atMyDesks: 0, inProgress: 0, earlier: 0 },
          work: {},
          workPrev: {},
        }
      : myGot
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
  // a head: their own work on the Analytics page; a doctor: their own dashboard's analytics (0102)
  const seenLink = link('staff', { person: user.id, kind: 'patientsSeen' }) ?? link('myPatients')
  const waitingLink = link('waiting') ?? link('waitingNow')
  const ordersLink = link('staff', { person: user.id, kind: 'orders' }) ?? link('orders')
  const tasksLink = link('tasks')

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

  // the tiles count MY patients (0120): sent to me by name, or waiting at my desks for anyone,
  // and the ones I took; "Seen": the patients I saw in the period, never the desk's
  const counts = my
    ? {
        waiting: my.counts.sentToMe + my.counts.atMyDesks,
        inProgress: my.counts.inProgress,
        done: my.work.patientsSeen ?? summary?.seenToday ?? 0,
      }
    : { waiting: 0, inProgress: 0, done: 0 }
  // the kinds of my work this home lists first: the doctor's, or the desk's
  const kinds = WORK_OF[role === 'doctor' ? 'doctor' : role === 'nurse' ? 'nurse' : 'reception']

  // "Open next patient" takes the next patient of the desk and opens the visit.
  const takesNext = (id: string) => id === 'openNext' && user.role === 'doctor'
  const tabletActions = home.actions.map((a) =>
    takesNext(a.id) ? (
      <OpenNextButton
        key={a.id}
        user={user}
        className="[&>button]:h-auto [&>button]:min-h-[max(2.25rem,var(--tap,0px))] [&>button]:w-full [&>button]:flex-wrap [&>button]:px-2 [&>button]:py-1.5 [&>button]:whitespace-normal"
      />
    ) : (
      <StaffLink
        key={a.id}
        to={a.to}
        className={cn(
          buttonVariants({ variant: a.primary ? 'primary' : 'default' }),
          'h-auto min-h-[max(2.25rem,var(--tap,0px))] px-2 py-1.5 text-center leading-tight whitespace-normal',
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
          <div className="text-ink-2 flex min-w-[min(240px,100%)] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
            onClick={() => {
              void refetch()
              void refetchMine()
            }}
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
          my={my}
          counts={counts}
          periodWord={periodWord}
          seenLink={seenLink}
          waitingLink={waitingLink}
          ordersLink={ordersLink}
          tasksLink={tasksLink}
        />

        {/* Bookings to accept right under the tiles while there is something to answer (a notice
            "Booking to accept" points here); empty, the doctor's panel stays at the bottom */}
        {summary && <ToAcceptSection items={summary.toAccept} />}

        {/* Patients a colleague hands over to me (Take / Decline), and mine waiting (0088) */}
        <HandoverPanel />

        {/* WAITING FOR ME: sent to me by name first, then my desks' queue (0120) */}
        <section className="flex flex-col gap-3">
          <SectionTitle icon={UserRoundCheck}>{t('my.section')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <WaitingForMePanel
              summary={my}
              rowAction={home.rowAction}
              title={t('home.myQueue', { station })}
              done={counts.done}
            />
            <div className="flex min-w-0 flex-col gap-4">
              <MyWorkPanel
                summary={my}
                periodWord={periodWord}
                kinds={kinds}
                link={link}
                user={user}
                i={2}
              />
              <CallsPanel user={user} />
              {/* orders sent to this doctor's desk (dental, minor surgery, consultation…) */}
              {user.role === 'doctor' && (
                <DeskOrdersPanel
                  station={stationFor(user)}
                  title={t('desk.ordersAt', { desk: station })}
                  hideEmpty
                />
              )}
            </div>
          </div>
        </section>

        {/* THE WORK OF THE DAY: my results, my calendar, my notices */}
        {summary && (
          <section className="flex flex-col gap-3">
            <SectionTitle icon={role === 'doctor' ? Workflow : ListTodo}>
              {t(`roleHome.section.${role}`)}
            </SectionTitle>
            <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
              <RolePanels role={role} data={summary} />
              {/* a head of department: colleagues asking to see past records */}
              <AccessApprovalsPanel user={user} />
              <NoticesPanel limit={4} />
            </div>
          </section>
        )}
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
  my,
  counts,
  periodWord,
  seenLink,
  waitingLink,
  ordersLink,
  tasksLink,
}: {
  role: HomeRole
  summary: HomeSummary | undefined
  /** My own figures (0120). No average waiting time on the tiles: the waiting times are on
   *  the Analytics page. */
  my: MySummary | undefined
  counts: { waiting: number; inProgress: number; done: number }
  /** "today", "this week"…: what the counted tiles cover. */
  periodWord: string
  /** The person's own work on the Analytics page (heads of department, and every desk's own
   *  analytics since 0102). */
  seenLink?: string
  waitingLink?: string
  ordersLink?: string
  tasksLink?: string
}) {
  const { t } = useTranslation()
  const unitNow = t('dashboard.units.now')
  const unitToday = periodWord
  // "2 sent to you by name" under the waiting tile when there are some
  const sent = my?.counts.sentToMe ?? 0
  const sentDelta =
    sent > 0 ? { text: t('my.sentToMe', { count: sent }), good: null, up: null } : undefined
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
          delta={sentDelta}
          to={waitingLink}
        />
        <Kpi
          i={1}
          icon={Stethoscope}
          tint="teal"
          label={t('roleHome.tiles.inProgress')}
          value={counts.inProgress}
          unit={unitNow}
          to={waitingLink}
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
          to={ordersLink}
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
      </>
    )
  } else {
    // the other desks on this home (a nurse or receptionist without their usual desk): my
    // queue, what I did, my tasks; nothing of the clinic
    const done = my?.work.patientsSeen ?? 0
    const tasks = summary?.tasks.length ?? 0
    tiles = (
      <>
        <Kpi
          i={0}
          icon={Users}
          tint="amber"
          label={t('roleHome.tiles.waiting')}
          value={counts.waiting}
          unit={unitNow}
          delta={sentDelta}
          to={waitingLink}
        />
        <Kpi
          i={1}
          icon={Stethoscope}
          tint="teal"
          label={t('roleHome.tiles.inProgress')}
          value={counts.inProgress}
          unit={unitNow}
          to={waitingLink}
        />
        <Kpi
          i={2}
          icon={CircleCheck}
          tint="mint"
          label={t('roleHome.tiles.seen')}
          value={done}
          unit={unitToday}
          to={seenLink}
        />
        <Kpi
          i={3}
          icon={ListTodo}
          tint="violet"
          label={t('home.tasksDue')}
          value={tasks}
          unit={unitNow}
          to={tasksLink}
        />
      </>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3">
      {tiles}
    </div>
  )
}
