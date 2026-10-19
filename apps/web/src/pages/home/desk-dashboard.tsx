import type { CSSProperties } from 'react'
import {
  Activity,
  AlertTriangle,
  BedDouble,
  CalendarCheck,
  ClipboardList,
  HeartPulse,
  MessageSquare,
  RefreshCw,
  Search,
  Stethoscope,
  Timer,
  UserPlus,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_HOURS, formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { LineChart } from '@/components/charts/line-chart'
import { Empty, Kpi, ListRows, Panel, Pill } from '@/components/dash/kit'
import { delta, sectionTitle, stationLabel, type Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useDeskSummary, type DeskSummary } from '@/lib/api/desk'
import { AppointmentsPanel, BedsPanel, InquiriesPanel, TasksPanel } from './desk-panels'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { openItems, useQueueBoard, type QueueItem } from '@/lib/api/visits'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'

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
  const dayNames = useDayNames()
  const now = new Date()
  const { data, error, isFetching, refetch, dataUpdatedAt } = useDeskSummary()
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)
  const { data: queue = [] } = useQueueBoard(role === 'nurse' ? 'triage' : 'all', user.role)
  const waiting = openItems(queue)

  const hour = now.getHours()
  const greeting = t(
    `dashboard.greeting.${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`,
    {
      name: user.name
        .replace(/^Dr\.?\s+/i, '')
        .split(' ')
        .pop(),
    },
  )
  const nurse = role === 'nurse'

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        {/* HEADER */}
        <div className="anim-enter flex flex-wrap items-center gap-4">
          <div className="min-w-[240px] flex-1">
            <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em]">{greeting}</h1>
            <div className="text-ink-2 mt-1 text-sm">
              {dayNames.long[now.getDay()]} {formatDate(now)} · {t(`desk.${role}.subtitle`)} ·{' '}
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : now),
              })}{' '}
              ·{' '}
              <b className={status?.open ? 'text-green' : 'text-red'}>
                ● {t(status?.open ? 'dashboard.clinicOpen' : 'dashboard.clinicClosed')}
              </b>
              {!isLive && <span className="text-ink-3"> · {t('dashboard.sampleData')}</span>}
            </div>
          </div>
          <StaffLink
            to="/app/patients"
            className="border-border bg-card text-ink-3 card-lift wide:flex hidden h-11 w-[260px] items-center gap-2.5 rounded-xl border px-3.5 text-sm no-underline"
          >
            <Search size={16} aria-hidden="true" />
            {t('common.searchPatient')}
          </StaffLink>
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {nurse && (
            <StaffLink to="/app/register" className={buttonVariants({ size: 'md' })}>
              <UserPlus size={16} aria-hidden="true" />
              {t('dashboard.registerPatient')}
            </StaffLink>
          )}
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
        </div>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {!data && !error && (
          <div
            className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4"
            aria-busy="true"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-[150px] rounded-[16px]" />
            ))}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-5">
            {nurse ? <NurseTiles d={data} /> : <ReceptionTiles d={data} />}

            {/* THE WORK OF THE DAY */}
            <section className="flex flex-col gap-3">
              <div className={sectionTitle}>{t(`desk.${role}.section`)}</div>
              <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
                <QueuePanel role={role} rows={waiting} />
                {nurse ? <UrgentPanel d={data} /> : <StationsPanel d={data} />}
                <ArrivalsPanel d={data} />
              </div>
            </section>

            {/* TODAY */}
            <section className="flex flex-col gap-3">
              <div className={sectionTitle}>{t('desk.today')}</div>
              <div className="pc:grid-cols-3 grid grid-cols-1 gap-4">
                {nurse ? (
                  <>
                    <BedsPanel userRole={user.role} />
                    <TasksPanel />
                  </>
                ) : (
                  <>
                    <AppointmentsPanel
                      canAct
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
                    <InquiriesPanel canAct />
                  </>
                )}
                <MinePanel d={data} role={role} />
              </div>
            </section>
          </div>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- tiles */

function ReceptionTiles({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const x = d.tiles
  const today = t('dashboard.period.today')
  const vsYesterday = (a: number, b: number) => {
    const r = delta(a, b, true, t)
    return {
      ...r,
      text:
        r.up === null
          ? t('desk.sameAsYesterday')
          : t('desk.vsYesterday', { change: `${a - b > 0 ? '+' : '−'}${Math.abs(a - b)}` }),
    }
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
      <Kpi
        i={0}
        icon={UserPlus}
        tint="teal"
        label={t('dashboard.tiles.registered')}
        value={x.registeredToday}
        unit={today}
        delta={vsYesterday(x.registeredToday, x.registeredYesterday)}
      />
      <Kpi
        i={1}
        icon={Stethoscope}
        tint="mint"
        label={t('dashboard.tiles.visits')}
        value={x.visitsToday}
        unit={today}
        delta={vsYesterday(x.visitsToday, x.visitsYesterday)}
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
      />
      <Kpi
        i={4}
        icon={Timer}
        tint="coral"
        label={t('dashboard.tiles.avgWait')}
        value={x.avgWaitMin}
        unit={t('dashboard.units.min')}
        delta={
          x.avgWaitMin > 30 ? { text: t('dashboard.queueLong'), good: false, up: true } : undefined
        }
      />
      <Kpi
        i={5}
        icon={CalendarCheck}
        tint="violet"
        label={t('desk.tiles.appointments')}
        value={x.apptsToday}
        unit={today}
      />
      <Kpi
        i={6}
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

function NurseTiles({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const x = d.tiles
  const diff = x.vitalsToday - x.vitalsYesterday
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
      <Kpi
        i={0}
        icon={Activity}
        tint="teal"
        label={t('desk.tiles.triageWaiting')}
        value={x.triageWaiting}
        unit={t('dashboard.units.now')}
      />
      <Kpi
        i={1}
        icon={AlertTriangle}
        tint="coral"
        label={t('desk.tiles.red')}
        value={x.triageRed}
        unit={t('dashboard.units.now')}
        delta={x.triageRed > 0 ? { text: t('desk.seeFirst'), good: false, up: null } : undefined}
      />
      <Kpi
        i={2}
        icon={AlertTriangle}
        tint="amber"
        label={t('desk.tiles.yellow')}
        value={x.triageYellow}
        unit={t('dashboard.units.now')}
      />
      <Kpi
        i={3}
        icon={HeartPulse}
        tint="mint"
        label={t('desk.tiles.vitals')}
        value={x.vitalsToday}
        unit={t('dashboard.period.today')}
        delta={{
          text:
            diff === 0
              ? t('desk.sameAsYesterday')
              : t('desk.vsYesterday', { change: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}` }),
          good: null,
          up: diff === 0 ? null : diff > 0,
        }}
      />
      <Kpi
        i={4}
        icon={Timer}
        tint="violet"
        label={t('desk.tiles.triageWait')}
        value={x.triageAvgWaitMin}
        unit={t('dashboard.units.min')}
        delta={
          x.triageAvgWaitMin > 15
            ? { text: t('dashboard.queueLong'), good: false, up: true }
            : undefined
        }
      />
      <Kpi
        i={5}
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
  return (
    <Panel
      i={1}
      title={t(nurse ? 'desk.nurse.queue' : 'desk.receptionist.queue')}
      right={t('visits.count', { count: rows.length })}
    >
      {list.length === 0 ? (
        <Empty>{t(nurse ? 'desk.nurse.queueEmpty' : 'visits.none')}</Empty>
      ) : (
        <div className="flex flex-col">
          {list.slice(0, 7).map((r, i) => (
            <div
              key={r.queueId}
              className="border-grid anim-enter flex min-h-11 items-center gap-2.5 border-b py-1.5 text-[13px] last:border-b-0"
              style={{ '--i': i } as CSSProperties}
            >
              <Pill tint={triageTint[r.triage] ?? 'teal'}>{r.ticket}</Pill>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="text-ink-3 block truncate text-xs">
                  {r.ageSex} · {stationLabel(r.station, t)} ·{' '}
                  {r.startedAt ? t('visits.inProgress') : t('visits.waiting', { count: r.waitMin })}
                </span>
              </span>
              <StaffLink
                to={nurse ? '/app/vitals' : '/app/visit'}
                search={{ encounter: r.encounterId }}
                className={buttonVariants({ size: 'sm', variant: i === 0 ? 'primary' : 'default' })}
              >
                {t(nurse ? 'desk.nurse.vitalsShort' : 'visits.openVisit')}
              </StaffLink>
            </div>
          ))}
        </div>
      )}
      <StaffLink to="/app/visits" className={cn(buttonVariants({ size: 'sm' }), 'self-start')}>
        {t('desk.allInClinic')} →
      </StaffLink>
    </Panel>
  )
}

function StationsPanel({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const rows = d.stations.filter((s) => s.waiting + s.busy > 0)
  return (
    <Panel i={2} title={t('dashboard.queueNow')} right={t('dashboard.refreshNote')}>
      {rows.length === 0 ? (
        <Empty>{t('dashboard.noQueue')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {rows.map((s, i) => {
            const hot = s.minutes > 20
            return (
              <div
                key={s.station}
                className={cn(
                  'anim-enter flex flex-col gap-0.5 rounded-xl border px-3 py-2.5',
                  hot ? 'border-red-dot/30 bg-red-bg/40' : 'border-border',
                )}
                style={{ '--i': i } as CSSProperties}
              >
                <span className="text-xl font-extrabold tabular-nums">{s.waiting}</span>
                <span className="text-ink-2 text-xs font-semibold">
                  {stationLabel(s.station, t)}
                </span>
                <span className={cn('text-[11px]', hot ? 'text-red font-semibold' : 'text-ink-3')}>
                  {t('desk.busyShort', { count: s.busy })} ·{' '}
                  {t('dashboard.avgShort', { min: s.minutes })}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function UrgentPanel({ d }: { d: DeskSummary }) {
  const { t } = useTranslation()
  const x = d.tiles
  const green = Math.max(0, x.triageWaiting - x.triageRed - x.triageYellow)
  const rows = [
    { key: 'red', tint: 'coral' as Tint, label: t('desk.urgency.red'), n: x.triageRed },
    { key: 'yellow', tint: 'amber' as Tint, label: t('desk.urgency.yellow'), n: x.triageYellow },
    { key: 'green', tint: 'mint' as Tint, label: t('desk.urgency.green'), n: green },
  ]
  return (
    <Panel i={2} title={t('desk.nurse.urgency')} right={t('dashboard.refreshNote')}>
      <ListRows
        rows={rows.map((r) => ({
          key: r.key,
          pill: <Pill tint={r.tint}>{r.n}</Pill>,
          label: r.label,
          value: '',
        }))}
      />
      <p className="text-ink-3 m-0 text-xs">{t('desk.nurse.urgencyHint')}</p>
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
    <Panel i={3} title={t('desk.arrivals')} right={t('desk.arrivalsTotal', { count: total })}>
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
        <p className="text-ink-3 m-0 text-xs">
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
    <Panel i={3} title={t('desk.mine.title')} right={t('desk.mine.note')}>
      <div className="grid grid-cols-3 gap-2.5">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="border-border anim-enter flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5"
            style={{ '--i': i } as CSSProperties}
          >
            <r.icon size={16} aria-hidden="true" className="text-ink-3" />
            <span className="text-2xl font-extrabold tabular-nums">{r.n}</span>
            <span className="text-ink-2 text-[11px] leading-tight font-semibold">{r.label}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}
