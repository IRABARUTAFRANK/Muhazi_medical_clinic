import type { CSSProperties } from 'react'
import {
  Activity,
  AlertTriangle,
  BedDouble,
  CalendarCheck,
  ChartLine,
  ClipboardCheck,
  ClipboardList,
  Clock,
  HeartPulse,
  ListTodo,
  MessageSquare,
  RefreshCw,
  Search,
  Siren,
  Stethoscope,
  Timer,
  UserPlus,
  Users,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePeriod } from '@/lib/period'
import { rowSignature, useChanged } from '@/lib/motion'
import type { DashboardRange } from '@/lib/api/dashboard'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { formatTime, type StaffUser } from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { LineChart } from '@/components/charts/line-chart'
import { IdentityBanner } from '@/components/dash/identity-banner'
import {
  Empty,
  Hint,
  IconChip,
  Kpi,
  ListRows,
  Panel,
  Pill,
  SectionTitle,
  StationGlyph,
} from '@/components/dash/kit'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { AccessApprovalsPanel } from '@/components/privacy/approvals'
import { periodSearch, useAnalyticsLink } from '@/components/dash/analytics-links'
import type { AnalyticsView } from '@/lib/api/analytics'
import { StationTile } from '@/components/dash/station-tile'
import { HandoverPanel } from './handover-panel'
import {
  delta,
  greetingFor,
  stationLabel,
  triageIcon,
  type Tint,
} from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useDeskSummary, type DeskSummary } from '@/lib/api/desk'
import {
  AppointmentsPanel,
  BedsPanel,
  FilesToCompletePanel,
  InquiriesPanel,
  TasksPanel,
} from './desk-panels'
import {
  mineElsewhere,
  onePerPool,
  openItems,
  useQueueBoard,
  type QueueItem,
} from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { formatDuration } from '@/lib/duration'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { cn } from '@/lib/utils'
import { CallsPanel } from './calls-panel'
import { useDeskOrders } from '@/lib/api/lab'
import { LabOrderRow } from '../lab/lab-parts'
import { MyQueuePanel } from './role-panels'
import { useNow } from '@/lib/hooks'
import { TREATING_DESKS } from '@/lib/api/desks'
import { DeskBlocks } from './home-desks'
import { useHomeDesks } from './home-desks-rules'

export type DeskRole = 'receptionist' | 'nurse'

const triageTint: Record<string, Tint> = { red: 'coral', yellow: 'amber', green: 'mint' }

/**
 * Front-desk and nursing dashboards, in the manager dashboard's design (same kit, same
 * motion): greeting header, KPI tiles, then the work of the day for that role. The
 * receptionist sees arrivals, the queue by station, appointments and inquiries; the nurse
 * sees the triage queue by urgency, beds and tasks. Both see what they did today.
 */
export function DeskDashboard({ user, role }: { user: StaffUser; role: DeskRole }) {
  const { t } = useTranslation()
  const now = new Date()
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = usePeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const { data, error, isFetching, refetch, dataUpdatedAt } = useDeskSummary(days)
  // the figures open their detailed view on the Analytics page when the person may see it
  // (the manager, a head of department); otherwise the tiles stay plain
  const link = useAnalyticsLink(periodSearch(period))
  const can = useCan(user)
  // the desk's own work the manager has switched off: said once, at the top
  const switchedOff = useSwitchedOff(user)
  // the desks the person works at (their departments decide, 0085): each block of a desk shows
  // only to those who work there
  const { has } = useHomeDesks(user)
  const { data: queue = [] } = useQueueBoard('all', user.role)
  const open = onePerPool(openItems(queue))
  // The nurse: everyone at triage and everyone still without vitals, whatever the desk (the same
  // rule as the "To measure" tile and the Vitals page); reception: everyone.
  const waiting =
    role === 'nurse'
      ? open.filter((r) => r.station === 'triage' || !r.vitalsAt)
      : // reception: those still waiting (not those already being seen)
        open.filter((r) => !r.startedAt)
  // patients sent to the nurses for care (Nursing, Beds), and those of the other sections this
  // nurse works in (Consultation…)
  const care = onePerPool([
    ...openItems(queue).filter((r) => r.station === 'nursing' || r.station === 'beds'),
    ...mineElsewhere(queue, 'triage').filter(
      (r) => r.station !== 'nursing' && r.station !== 'beds',
    ),
  ])

  const greeting = greetingFor(user.name, t)
  const nurse = role === 'nurse'
  // a desk counts here with the manager's switch for its work (vital signs, starting visits)
  const triage = has('triage') && can('vitals.write')
  const reception = has('reception') && can('visit.start')
  const nursing = has('nursing')
  // the primary button: vitals at triage (nurse), registering at reception
  const primary = nurse ? triage : reception

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* WHO IS SIGNED IN */}
        <IdentityBanner user={user} greeting={greeting} />

        {/* TOOLBAR */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[240px] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <ClipboardCheck size={16} aria-hidden="true" className="text-primary" />
              {t(`desk.${role}.subtitle`)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={15} aria-hidden="true" className="text-ink-3" />
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : now),
              })}
            </span>
            {!isLive && <span className="text-ink-3">{t('dashboard.sampleData')}</span>}
          </div>
          <StaffLink
            to="/app/patients"
            className="border-border bg-surface text-ink-3 hover:bg-hover wide:flex hidden h-9 w-[260px] items-center gap-2 rounded-full border px-3 text-[14px] no-underline"
          >
            <Search size={16} aria-hidden="true" />
            {t('common.searchPatient')}
          </StaffLink>
          <PeriodSeg period={period} />
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {nurse && reception && (
            <StaffLink to="/app/register" className={buttonVariants({ size: 'md' })}>
              <UserPlus size={16} aria-hidden="true" />
              {t('dashboard.registerPatient')}
            </StaffLink>
          )}
          {primary && (
            <StaffLink
              to={nurse ? '/app/vitals' : '/app/register'}
              className={buttonVariants({ variant: 'primary', size: 'md' })}
            >
              {nurse ? (
                <HeartPulse size={16} aria-hidden="true" />
              ) : (
                <UserPlus size={16} aria-hidden="true" />
              )}
              {t(nurse ? 'desk.nurse.takeVitals' : 'dashboard.registerPatient')}
            </StaffLink>
          )}
          <PeriodCustom period={period} className="basis-full" />
        </div>

        {error && (
          <p
            role="alert"
            className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {role === 'nurse' && switchedOff('vitals.write') && (
          <NotAllowedNotice feature="vitals.write" compact />
        )}
        {switchedOff('visit.start') && <NotAllowedNotice feature="visit.start" compact />}

        {!data && !error && (
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3"
            aria-busy="true"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-[130px] rounded-md" />
            ))}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            {nurse ? (
              <NurseTiles d={data} range={period.range} link={link} triage={triage} />
            ) : (
              <ReceptionTiles d={data} range={period.range} link={link} />
            )}

            {/* Patients a colleague hands over to me (Take / Decline), and mine waiting (0088) */}
            {nurse && <HandoverPanel />}

            {/* Colleagues calling for the next patient, help requests */}
            <CallsPanel user={user} />

            {/* THE WORK OF THE DAY */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={Workflow}>{t(`desk.${role}.section`)}</SectionTitle>
              <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
                {nurse ? (
                  <>
                    {triage && <QueuePanel role={role} rows={waiting} />}
                    <UrgentPanel d={data} />
                    <ArrivalsPanel d={data} />
                  </>
                ) : (
                  <>
                    {/* The nurse registered them first; reception completes the file. */}
                    <FilesToCompletePanel i={1} />
                    <QueuePanel role={role} rows={waiting} />
                    <StationsPanel d={data} to={link('waiting')} />
                  </>
                )}
              </div>
            </section>

            {/* NURSING CARE: patients sent to the nurses, and the orders done at Nursing */}
            {nurse && has(TREATING_DESKS) && (
              <section className="flex flex-col gap-3">
                <SectionTitle icon={HeartPulse}>{t('desk.nurse.careSection')}</SectionTitle>
                <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
                  <MyQueuePanel
                    title={t('desk.nurse.care')}
                    rows={care}
                    counts={{
                      waiting: care.filter((r) => !r.startedAt).length,
                      inProgress: care.filter((r) => r.startedAt).length,
                      done: 0,
                    }}
                    rowAction="open"
                  />
                  <NursingOrdersPanel />
                </div>
              </section>
            )}

            {/* TODAY */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={CalendarCheck}>
                {period.range === 'today' ? t('desk.today') : period.label}
              </SectionTitle>
              <div
                className={cn(
                  'grid grid-cols-1 gap-4',
                  nurse ? 'pc:grid-cols-3' : 'pc:grid-cols-2',
                )}
              >
                {nurse ? (
                  nursing && (
                    <>
                      <BedsPanel
                        userRole={user.role}
                        className="pc:col-span-2"
                        canAct={can('clinical.write')}
                      />
                      <TasksPanel canAct={can('clinical.write')} />
                    </>
                  )
                ) : (
                  <>
                    <AppointmentsPanel
                      canAct={can('appointment.approve')}
                      canArrive={can('visit.start')}
                      limit={6}
                      footer={
                        <StaffLink
                          to="/app/appointments"
                          className={cn(buttonVariants({ size: 'sm' }), 'self-start')}
                        >
                          {t('ops.appts.all')} →
                        </StaffLink>
                      }
                    />
                    <InquiriesPanel canAct={can('appointment.approve')} />
                  </>
                )}
                {!nurse && <ArrivalsPanel d={data} />}
                <MinePanel d={data} role={role} />
                <AccessApprovalsPanel user={user} />
                <NoticesPanel />
              </div>
            </section>
          </div>
        )}
        {/* the desks the person's departments give besides this one (the lab, the pharmacy…) */}
        <DeskBlocks user={user} kind={nurse ? 'nurse' : 'reception'} />
        <DoctorCalendarsSection user={user} />
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- tiles */

/** The address of an Analytics view, or undefined when the person may not open it. */
type LinkFn = (view: AnalyticsView) => string | undefined

/* No average waiting time on these tiles: the waiting times (completed waits, median and 90th
   percentile) are on the Analytics page, Waiting times. */

function ReceptionTiles({
  d,
  range,
  link,
}: {
  d: DeskSummary
  range: DashboardRange
  link: LinkFn
}) {
  const { t } = useTranslation()
  const x = d.tiles
  const today = t(`dashboard.period.${range}`)
  const before = range === 'today' ? 'Yesterday' : 'Before'
  const vsYesterday = (a: number, b: number) => {
    const r = delta(a, b, true, t)
    return {
      ...r,
      text:
        r.up === null
          ? t(`desk.sameAs${before}`)
          : t(`desk.vs${before}`, { change: `${a - b > 0 ? '+' : '−'}${Math.abs(a - b)}` }),
    }
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] sm:gap-3">
      <Kpi
        i={0}
        icon={UserPlus}
        tint="teal"
        label={t('dashboard.tiles.registered')}
        value={x.registeredToday}
        unit={today}
        delta={vsYesterday(x.registeredToday, x.registeredYesterday)}
        to={link('visits')}
      />
      <Kpi
        i={1}
        icon={Stethoscope}
        tint="mint"
        label={t('dashboard.tiles.visits')}
        value={x.visitsToday}
        unit={today}
        delta={vsYesterday(x.visitsToday, x.visitsYesterday)}
        to={link('visits')}
      />
      <Kpi
        i={2}
        icon={Users}
        tint="navy"
        label={t('desk.tiles.inClinic')}
        value={x.inClinic}
        unit={t('dashboard.units.now')}
      />
      <Kpi
        i={3}
        icon={Timer}
        tint="amber"
        label={t('dashboard.tiles.waiting')}
        value={x.waitingNow}
        unit={t('dashboard.units.now')}
        delta={
          (x.forgottenNow ?? 0) > 0
            ? {
                text: t('dashboard.forgottenShort', { count: x.forgottenNow }),
                good: false,
                up: null,
              }
            : undefined
        }
      />
      <Kpi
        i={4}
        icon={CalendarCheck}
        tint="violet"
        label={t('desk.tiles.appointments')}
        value={x.apptsToday}
        unit={today}
      />
      <Kpi
        i={5}
        icon={MessageSquare}
        tint="teal"
        label={t('desk.tiles.inquiries')}
        value={x.inquiriesPending}
        unit={t('desk.units.toAnswer')}
        delta={
          x.inquiriesPending > 0 ? { text: t('desk.answerSoon'), good: false, up: null } : undefined
        }
      />
    </div>
  )
}

function NurseTiles({
  d,
  range,
  link,
  triage,
}: {
  d: DeskSummary
  range: DashboardRange
  link: LinkFn
  /** Works at triage with "Record vital signs": the triage and vital-sign tiles. */
  triage: boolean
}) {
  const before = range === 'today' ? 'Yesterday' : 'Before'
  const { t } = useTranslation()
  const x = d.tiles
  const diff = x.vitalsToday - x.vitalsYesterday
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3">
      {triage && (
        <>
          <Kpi
            i={0}
            icon={Activity}
            tint="teal"
            label={t(x.needVitals == null ? 'desk.tiles.triageWaiting' : 'desk.tiles.toMeasure')}
            value={x.needVitals ?? x.triageWaiting}
            unit={t('dashboard.units.now')}
          />
          <Kpi
            i={1}
            icon={AlertTriangle}
            tint="coral"
            label={t('desk.tiles.red')}
            value={x.triageRed}
            unit={t('dashboard.units.now')}
            delta={
              x.triageRed > 0 ? { text: t('desk.seeFirst'), good: false, up: null } : undefined
            }
            to={link('triage')}
          />
          <Kpi
            i={2}
            icon={AlertTriangle}
            tint="amber"
            label={t('desk.tiles.yellow')}
            value={x.triageYellow}
            unit={t('dashboard.units.now')}
            to={link('triage')}
          />
          <Kpi
            i={3}
            icon={HeartPulse}
            tint="mint"
            label={t('desk.tiles.vitals')}
            value={x.vitalsToday}
            unit={t(`dashboard.period.${range}`)}
            delta={{
              text:
                diff === 0
                  ? t(`desk.sameAs${before}`)
                  : t(`desk.vs${before}`, { change: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}` }),
              good: null,
              up: diff === 0 ? null : diff > 0,
            }}
            to={link('triage')}
          />
        </>
      )}
      <Kpi
        i={4}
        icon={BedDouble}
        tint="navy"
        label={t('dashboard.tiles.beds')}
        value={x.bedsOccupied}
        unit={`/ ${x.bedsTotal} ${t('dashboard.units.beds')}`}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- panels */

function QueuePanel({ role, rows }: { role: DeskRole; rows: QueueItem[] }) {
  const { t } = useTranslation()
  const nurse = role === 'nurse'
  // Longest-waiting first at reception; urgency first at triage (the board is already by priority).
  const list = nurse ? rows : [...rows].sort((a, b) => b.waitMin - a.waitMin)
  // a row whose patient moved (triage colour, station, status) flashes once
  const changed = useChanged(list, (r) => r.queueId, rowSignature)
  return (
    <Panel
      i={1}
      icon={nurse ? Activity : Users}
      tint={nurse ? 'coral' : 'amber'}
      title={t(nurse ? 'desk.nurse.queue' : 'desk.receptionist.queue')}
      right={t('visits.count', { count: rows.length })}
    >
      {list.length === 0 ? (
        <Empty>{t(nurse ? 'desk.nurse.queueEmpty' : 'visits.none')}</Empty>
      ) : (
        <ShownList items={list} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((r, i) => (
                <div
                  // the change count in the key replays the flash on the next change
                  key={`${r.queueId}:${changed.get(r.queueId) ?? 0}`}
                  className={cn(
                    'border-grid flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b py-1.5 text-[14px] last:border-b-0',
                    changed.get(r.queueId) && 'anim-row',
                  )}
                  style={{ '--i': i } as CSSProperties}
                >
                  <Pill tint={triageTint[r.triage] ?? 'teal'} icon={triageIcon[r.triage]}>
                    {r.ticket}
                  </Pill>
                  {/* the full name: it keeps room for itself (the button drops under it on a
                      narrow column) and wraps rather than being cut short */}
                  <span className="min-w-32 flex-1">
                    <span className="block font-semibold wrap-break-word">{r.name}</span>
                    <span className="text-ink-3 flex items-center gap-1 truncate text-[13px]">
                      <StationGlyph station={r.station} size={12} className="flex-none" />
                      {r.ageSex} · {stationLabel(r.station, t)} ·{' '}
                      {r.startedAt
                        ? t('visits.inProgress')
                        : t('visits.waiting', { time: formatDuration(r.waitMin, t) })}
                    </span>
                  </span>
                  <StaffLink
                    to={nurse ? '/app/vitals' : '/app/visit'}
                    search={{ encounter: r.encounterId }}
                    className={cn(
                      buttonVariants({
                        size: 'sm',
                        variant:
                          !nurse && r.canWork === false ? 'ghost' : i === 0 ? 'primary' : 'default',
                      }),
                      'ml-auto flex-none',
                    )}
                  >
                    {/* sent to someone else: reception may look, not work on the patient */}
                    {!nurse && r.canWork === false
                      ? t('access.view')
                      : t(nurse ? 'desk.nurse.vitalsShort' : 'visits.openVisit')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
      <StaffLink to="/app/visits" className={cn(buttonVariants({ size: 'sm' }), 'self-start')}>
        {t('desk.allInClinic')} →
      </StaffLink>
    </Panel>
  )
}

function StationsPanel({ d, to }: { d: DeskSummary; to?: string }) {
  const { t } = useTranslation()
  // a desk with only entries forgotten from an earlier day still shows (to be closed)
  const rows = d.stations.filter((s) => s.waiting + s.busy + (s.forgotten ?? 0) > 0)
  return (
    <Panel
      i={2}
      icon={Workflow}
      tint="teal"
      title={t('dashboard.queueNow')}
      right={t('dashboard.refreshNote')}
      to={to}
      toLabel={t('dashboard.links.waitingTimes')}
    >
      {rows.length === 0 ? (
        <Empty>{t('dashboard.noQueue')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {rows.map((s, i) => (
            <StationTile key={s.station} i={i} {...s} />
          ))}
        </div>
      )}
    </Panel>
  )
}

function UrgentPanel({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const x = d.tiles
  // one population: every open visit by its colour, and those not triaged yet
  const green = x.triageGreen ?? Math.max(0, x.triageWaiting - x.triageRed - x.triageYellow)
  const rows = [
    { key: 'red', tint: 'coral' as Tint, label: t('desk.urgency.red'), n: x.triageRed },
    { key: 'yellow', tint: 'amber' as Tint, label: t('desk.urgency.yellow'), n: x.triageYellow },
    { key: 'green', tint: 'mint' as Tint, label: t('desk.urgency.green'), n: green },
    ...(x.triageNone == null
      ? []
      : [{ key: 'none', tint: 'navy' as Tint, label: t('desk.urgency.none'), n: x.triageNone }]),
  ]
  return (
    <Panel
      i={2}
      icon={Siren}
      tint="coral"
      title={t('desk.nurse.urgency')}
      right={t('dashboard.refreshNote')}
    >
      <ListRows
        rows={rows.map((r) => ({
          key: r.key,
          icon: triageIcon[r.key],
          tint: r.tint,
          pill: <Pill tint={r.tint}>{r.n}</Pill>,
          label: r.label,
          value: '',
        }))}
      />
      <Hint>{t('desk.nurse.urgencyHint')}</Hint>
    </Panel>
  )
}

function ArrivalsPanel({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const values = d.arrivals.map((a) => a.count)
  const labels = d.arrivals.map((a) => `${String(a.hour).padStart(2, '0')}:00`)
  const peak = Math.max(4, ...values)
  const max = Math.ceil(peak / 4) * 4
  const total = values.reduce((s, v) => s + v, 0)
  const busiest = d.arrivals.reduce((b, a) => (a.count > b.count ? a : b), { hour: 0, count: 0 })
  const last = values.length - 1
  return (
    <Panel
      i={3}
      icon={ChartLine}
      tint="violet"
      title={t('desk.arrivals')}
      right={t('desk.arrivalsTotal', { count: total })}
    >
      <LineChart
        values={values}
        labels={labels}
        max={max}
        ticks={[0, max / 2, max]}
        tickLabel={(v) => String(v)}
        format={(v) => t('desk.arrivalsAt', { count: v })}
        xTicks={[0, Math.round(last / 2), last]}
        area
        animate
        ariaLabel={t('desk.arrivalsAria', { count: total })}
      />
      {busiest.count > 0 && (
        <p className="text-ink-3 m-0 text-[13px]">
          {t('desk.busiest', {
            hour: `${String(busiest.hour).padStart(2, '0')}:00`,
            count: busiest.count,
          })}
        </p>
      )}
    </Panel>
  )
}

function MinePanel({ d, role }: { d: DeskSummary; role: DeskRole }) {
  const { t } = useTranslation()
  const m = d.mine
  const rows =
    role === 'nurse'
      ? [
          {
            key: 'vitals',
            icon: HeartPulse,
            tint: 'mint' as Tint,
            n: m.vitals,
            label: t('desk.mine.vitals'),
          },
          {
            key: 'reg',
            icon: UserPlus,
            tint: 'teal' as Tint,
            n: m.registrations,
            label: t('desk.mine.registrations'),
          },
          {
            key: 'charges',
            icon: ClipboardList,
            tint: 'violet' as Tint,
            n: m.charges,
            label: t('desk.mine.charges'),
          },
        ]
      : [
          {
            key: 'reg',
            icon: UserPlus,
            tint: 'teal' as Tint,
            n: m.registrations,
            label: t('desk.mine.registrations'),
          },
          {
            key: 'visits',
            icon: Stethoscope,
            tint: 'mint' as Tint,
            n: m.visitsStarted,
            label: t('desk.mine.visits'),
          },
          {
            key: 'charges',
            icon: ClipboardList,
            tint: 'violet' as Tint,
            n: m.charges,
            label: t('desk.mine.charges'),
          },
        ]
  return (
    <Panel
      i={3}
      icon={ListTodo}
      tint="mint"
      title={t('desk.mine.title')}
      right={t('desk.mine.note')}
    >
      <div className="grid grid-cols-3 gap-2.5">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="border-border flex flex-col items-start gap-1 rounded-md border px-3 py-2.5"
            style={{ '--i': i } as CSSProperties}
          >
            <IconChip icon={r.icon} tint={r.tint} size="sm" />
            <span className="text-[24px] leading-8 font-semibold tabular-nums">{r.n}</span>
            <span className="text-ink-2 text-[12px] leading-tight font-semibold">{r.label}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* ---------------------------------------------------------------- nursing orders */
/** Orders done at Nursing (a dressing, an injection course…): what was done, or "Cannot do". */
function NursingOrdersPanel() {
  const { t } = useTranslation()
  const now = useNow()
  const { data: orders = [] } = useDeskOrders('nursing')
  return (
    <Panel
      i={2}
      icon={ClipboardList}
      tint="violet"
      title={t('desk.nurse.orders')}
      right={t('lab.openCount', { count: orders.length })}
    >
      {orders.length === 0 ? (
        <Empty>{t('desk.nurse.ordersEmpty')}</Empty>
      ) : (
        <ShownList items={orders} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((o, i) => (
                <LabOrderRow key={o.id} order={o} i={i} now={now} desk />
              ))}
            </div>
          )}
        </ShownList>
      )}
    </Panel>
  )
}
