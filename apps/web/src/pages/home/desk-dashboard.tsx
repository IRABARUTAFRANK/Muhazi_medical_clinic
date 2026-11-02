import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CalendarCheck,
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
  UserPlus,
  UserRoundCheck,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchPeriod } from '@/lib/period'
import type { DashboardRange } from '@/lib/api/dashboard'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { formatTime, type StaffUser } from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Hint, Kpi, ListRows, Panel, Pill, SectionTitle } from '@/components/dash/kit'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { AccessApprovalsPanel } from '@/components/privacy/approvals'
import { periodSearch, useAnalyticsLink } from '@/components/dash/analytics-links'
import { HandoverPanel } from './handover-panel'
import { greetingFor, triageIcon, type Tint } from '@/components/dash/kit-style'
import { Button, actionLink, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useDeskSummary, type DeskSummary } from '@/lib/api/desk'
import { useMySummary, type MySummary } from '@/lib/api/my'
import {
  AppointmentsPanel,
  BedsPanel,
  FilesToCompletePanel,
  InquiriesPanel,
  TasksPanel,
} from './desk-panels'
import { onePerPool, openItems, type QueueItem } from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { cn } from '@/lib/utils'
import { CallsPanel } from './calls-panel'
import { useDeskOrders } from '@/lib/api/lab'
import { LabOrderRow } from '../lab/lab-parts'
import { ErrorBox, ToAcceptSection } from './role-panels'
import { useNow } from '@/lib/hooks'
import { TREATING_DESKS } from '@/lib/api/desks'
import { DeskBlocks } from './home-desks'
import { useHomeDesks } from './home-desks-rules'
import { MyWorkPanel, WaitingForMePanel } from './my-panels'
import { WORK_OF, type LinkFn } from './my-work'

export type DeskRole = 'receptionist' | 'nurse'

/**
 * Front-desk and nursing dashboards, in the manager dashboard's design (same kit, same
 * motion), and personal since 0120: the tiles and lists are the signed-in person's own.
 * First "Waiting for me" (the patients sent to me by name, then my desks' queue), then "My
 * work" (what I did in the period, each with Details), then my calls, notices and approvals,
 * then the tools of my desk (reception: the day's bookings and inquiries, the files to
 * complete; the nurse: the nursing requests, beds and tasks). The clinic's totals are not
 * here: they belong to the manager dashboard.
 */
export function DeskDashboard({ user, role }: { user: StaffUser; role: DeskRole }) {
  const { t } = useTranslation()
  const now = new Date()
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = useSearchPeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const periodWord = t(`dashboard.period.${period.range}`)
  // my own figures: my queue, my work (0120)
  const { data: my, error, isFetching, refetch, dataUpdatedAt } = useMySummary(days)
  // the desk's own tools (the day's bookings, the inquiries to answer, the beds): no clinic
  // total of it is shown
  const { data: desk } = useDeskSummary(days)
  // the figures open their detailed view on the Analytics page: my own views (0102), or a
  // head's and the manager's "Who did what"
  const link = useAnalyticsLink(periodSearch(period))
  const can = useCan(user)
  // the desk's own work the manager has switched off: said once, at the top
  const switchedOff = useSwitchedOff(user)
  // the desks the person works at (their departments decide, 0085): each block of a desk shows
  // only to those who work there
  const { has } = useHomeDesks(user)
  const myRows = my ? onePerPool(openItems(my.waiting)) : []

  const greeting = greetingFor(user.name, t)
  const nurse = role === 'nurse'
  // a desk counts here with the manager's switch for its work (vital signs, starting visits)
  const triage = has('triage') && can('vitals.write')
  const reception = has('reception') && can('visit.start')
  const nursing = has('nursing')
  // the primary button: vitals at triage (nurse), registering at reception
  const primary = nurse ? triage : reception
  const kind = nurse ? 'nurse' : 'reception'
  // the kinds of my work this home lists first (a nurse who also registers: her registrations)
  const kinds = [...WORK_OF[kind], ...(nurse && has('reception') ? ['registered'] : [])]

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* WHO IS SIGNED IN */}
        <IdentityBanner user={user} greeting={greeting} />

        {/* TOOLBAR */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[min(240px,100%)] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
            variant="tint-grey"
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

        {error && <ErrorBox>{t('dashboard.loadFailed', { message: error.message })}</ErrorBox>}

        {role === 'nurse' && switchedOff('vitals.write') && (
          <NotAllowedNotice feature="vitals.write" compact />
        )}
        {switchedOff('visit.start') && <NotAllowedNotice feature="visit.start" compact />}

        {!my && !error && (
          <div
            className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3"
            aria-busy="true"
          >
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton h-[130px] rounded-md" />
            ))}
          </div>
        )}

        {my && (
          <div className="flex flex-col gap-4">
            {nurse ? (
              <NurseTiles
                my={my}
                rows={myRows}
                desk={desk}
                range={period.range}
                link={link}
                triage={triage}
                nursing={nursing}
              />
            ) : (
              <ReceptionTiles my={my} desk={desk} range={period.range} link={link} />
            )}

            {/* a nurse keeps a calendar (0094): the bookings made with them, to accept, under the
                tiles while there is something to answer */}
            {nurse && <ToAcceptSection />}

            {/* Patients a colleague hands over to me (Take / Decline), and mine waiting (0088) */}
            {nurse && <HandoverPanel />}

            {/* WAITING FOR ME: sent to me by name first, then my desks' queue */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={UserRoundCheck}>{t('my.section')}</SectionTitle>
              <div className="pc:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
                <WaitingForMePanel
                  summary={my}
                  rowAction={nurse ? 'call' : 'open'}
                  done={nurse ? (my.work.vitals ?? 0) : (my.work.visitsStarted ?? 0)}
                />
                {nurse ? <UrgentPanel rows={myRows} /> : <FilesToCompletePanel i={2} />}
              </div>
            </section>

            {/* MY WORK in the period, then what is addressed to me */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={ListTodo}>{t('my.work', { period: periodWord })}</SectionTitle>
              <div className="pc:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
                <MyWorkPanel
                  summary={my}
                  periodWord={periodWord}
                  kinds={kinds}
                  link={link}
                  user={user}
                  i={1}
                />
                <div className="flex min-w-0 flex-col gap-4">
                  {/* Colleagues calling for the next patient, help requests */}
                  <CallsPanel user={user} />
                  <AccessApprovalsPanel user={user} />
                  <NoticesPanel limit={4} />
                </div>
              </div>
            </section>

            {/* THE TOOLS OF MY DESK */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={Wrench}>{t('my.tools')}</SectionTitle>
              <div
                className={cn(
                  'grid grid-cols-1 gap-4',
                  nurse ? 'pc:grid-cols-3' : 'pc:grid-cols-2',
                )}
              >
                {nurse ? (
                  <>
                    {/* the orders done at Nursing (a dressing, an injection course…) */}
                    {has(TREATING_DESKS) && <NursingOrdersPanel />}
                    {nursing && (
                      <>
                        <BedsPanel
                          userRole={user.role}
                          className={has(TREATING_DESKS) ? undefined : 'pc:col-span-2'}
                          canAct={can('clinical.write')}
                        />
                        <TasksPanel canAct={can('clinical.write')} />
                      </>
                    )}
                    {!nursing && !has(TREATING_DESKS) && (
                      <Panel i={1} icon={Workflow} tint="teal" title={t('my.tools')}>
                        <Empty>{t('my.noTools')}</Empty>
                      </Panel>
                    )}
                  </>
                ) : (
                  <>
                    <AppointmentsPanel
                      canAct={can('appointment.approve')}
                      canArrive={can('visit.start')}
                      limit={6}
                      footer={
                        <StaffLink
                          to="/app/appointments"
                          className={cn(actionLink, 'self-start text-[13px]')}
                        >
                          {t('ops.appts.all')}
                          <ArrowRight size={14} aria-hidden="true" />
                        </StaffLink>
                      }
                    />
                    <InquiriesPanel canAct={can('appointment.approve')} />
                  </>
                )}
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

/* No average waiting time on these tiles: the waiting times (completed waits, median and 90th
   percentile) are on the Analytics page, Waiting times. */

/** "+2 vs yesterday" / "same as the period before", for a count of my work. */
function useVsBefore(range: DashboardRange) {
  const { t } = useTranslation()
  const before = range === 'today' ? 'Yesterday' : 'Before'
  return (now: number, prev: number, upIsGood: boolean | null = null) => {
    const diff = now - prev
    return {
      text:
        diff === 0
          ? t(`desk.sameAs${before}`)
          : t(`desk.vs${before}`, { change: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}` }),
      good: upIsGood === null || diff === 0 ? null : upIsGood ? diff > 0 : diff < 0,
      up: diff === 0 ? null : diff > 0,
    }
  }
}

function ReceptionTiles({
  my,
  desk,
  range,
  link,
}: {
  my: MySummary
  desk: DeskSummary | undefined
  range: DashboardRange
  link: LinkFn
}) {
  const { t } = useTranslation()
  const vs = useVsBefore(range)
  const today = t(`dashboard.period.${range}`)
  const w = my.work
  const p = my.workPrev
  const waiting = my.counts.sentToMe + my.counts.atMyDesks
  return (
    <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] sm:gap-3">
      <Kpi
        i={0}
        icon={Users}
        tint="amber"
        label={t('my.tiles.waitingForMe')}
        value={waiting}
        unit={t('dashboard.units.now')}
        delta={
          my.counts.sentToMe > 0
            ? { text: t('my.sentToMe', { count: my.counts.sentToMe }), good: null, up: null }
            : undefined
        }
        to={link('waitingNow')}
      />
      <Kpi
        i={1}
        icon={UserPlus}
        tint="teal"
        label={t('my.tiles.registeredByMe')}
        value={w.registered ?? 0}
        unit={today}
        delta={vs(w.registered ?? 0, p.registered ?? 0)}
        to={link('registrations')}
      />
      <Kpi
        i={2}
        icon={Stethoscope}
        tint="mint"
        label={t('my.tiles.visitsByMe')}
        value={w.visitsStarted ?? 0}
        unit={today}
        delta={vs(w.visitsStarted ?? 0, p.visitsStarted ?? 0)}
        to={link('arrivals')}
      />
      <Kpi
        i={3}
        icon={CalendarCheck}
        tint="violet"
        label={t('desk.tiles.appointments')}
        value={desk?.tiles.apptsToday ?? 0}
        unit={today}
        to={link('bookings')}
      />
      <Kpi
        i={4}
        icon={MessageSquare}
        tint="teal"
        label={t('desk.tiles.inquiries')}
        value={desk?.tiles.inquiriesPending ?? 0}
        unit={t('desk.units.toAnswer')}
        delta={
          (desk?.tiles.inquiriesPending ?? 0) > 0
            ? { text: t('desk.answerSoon'), good: false, up: null }
            : undefined
        }
        to={link('bookings')}
      />
    </div>
  )
}

function NurseTiles({
  my,
  rows,
  desk,
  range,
  link,
  triage,
  nursing,
}: {
  my: MySummary
  /** My waiting rows (one per shared patient). */
  rows: QueueItem[]
  desk: DeskSummary | undefined
  range: DashboardRange
  link: LinkFn
  /** Works at triage with "Record vital signs": the triage and vital-sign tiles. */
  triage: boolean
  /** Works at Nursing: the beds. */
  nursing: boolean
}) {
  const { t } = useTranslation()
  const vs = useVsBefore(range)
  const w = my.work
  const p = my.workPrev
  const waiting = my.counts.sentToMe + my.counts.atMyDesks
  // among MY waiting patients: those still without any measurement, the red ones
  const toMeasure = rows.filter((r) => !r.vitalsAt && !r.startedAt).length
  const red = rows.filter((r) => r.triage === 'red' && !r.startedAt).length
  return (
    <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3">
      <Kpi
        i={0}
        icon={Users}
        tint="amber"
        label={t('my.tiles.waitingForMe')}
        value={waiting}
        unit={t('dashboard.units.now')}
        delta={
          my.counts.sentToMe > 0
            ? { text: t('my.sentToMe', { count: my.counts.sentToMe }), good: null, up: null }
            : undefined
        }
        to={link('waitingNow')}
      />
      {triage && (
        <>
          <Kpi
            i={1}
            icon={Activity}
            tint="teal"
            label={t('my.tiles.toMeasure')}
            value={toMeasure}
            unit={t('dashboard.units.now')}
            to={link('waitingNow')}
          />
          <Kpi
            i={2}
            icon={AlertTriangle}
            tint="coral"
            label={t('my.tiles.redMine')}
            value={red}
            unit={t('dashboard.units.now')}
            delta={red > 0 ? { text: t('desk.seeFirst'), good: false, up: null } : undefined}
            to={link('waitingNow')}
          />
          <Kpi
            i={3}
            icon={HeartPulse}
            tint="mint"
            label={t('my.tiles.vitalsByMe')}
            value={w.vitals ?? 0}
            unit={t(`dashboard.period.${range}`)}
            delta={vs(w.vitals ?? 0, p.vitals ?? 0)}
            to={link('vitals')}
          />
        </>
      )}
      {nursing && (
        <Kpi
          i={4}
          icon={BedDouble}
          tint="navy"
          label={t('dashboard.tiles.beds')}
          value={desk?.tiles.bedsOccupied ?? 0}
          unit={`/ ${desk?.tiles.bedsTotal ?? 0} ${t('dashboard.units.beds')}`}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- panels */

/** My waiting patients by urgency (the triage colours of MY rows, not the clinic's). */
function UrgentPanel({ rows }: { rows: QueueItem[] }) {
  const { t } = useTranslation()
  const open = rows.filter((r) => !r.startedAt)
  const n = (c: string) => open.filter((r) => r.triage === c).length
  const none = open.filter((r) => !r.vitalsAt && r.triage === 'green').length
  const list = [
    { key: 'red', tint: 'coral' as Tint, label: t('desk.urgency.red'), n: n('red') },
    { key: 'yellow', tint: 'amber' as Tint, label: t('desk.urgency.yellow'), n: n('yellow') },
    { key: 'green', tint: 'mint' as Tint, label: t('desk.urgency.green'), n: n('green') - none },
    { key: 'none', tint: 'navy' as Tint, label: t('desk.urgency.none'), n: none },
  ]
  return (
    <Panel
      i={2}
      icon={Siren}
      tint="coral"
      title={t('my.urgency')}
      right={t('visits.count', { count: open.length })}
    >
      <ListRows
        rows={list.map((r) => ({
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

/* ---------------------------------------------------------------- nursing orders */
/** Orders done at Nursing (a dressing, an injection course…): what was done, or "Cannot do". */
function NursingOrdersPanel() {
  const { t } = useTranslation()
  const now = useNow()
  const { data: orders = [] } = useDeskOrders('nursing')
  return (
    <Panel
      i={1}
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
