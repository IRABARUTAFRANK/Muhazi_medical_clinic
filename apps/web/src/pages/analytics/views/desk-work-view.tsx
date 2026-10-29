import {
  Activity,
  CalendarCheck,
  CalendarX,
  CircleCheck,
  ClipboardList,
  FlaskConical,
  Hourglass,
  ListTodo,
  type LucideIcon,
  Pill,
  Siren,
  Stethoscope,
  UserPlus,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatNumber } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useDeskAnalytics,
  type AnalyticsView,
  type DeskAnalytics,
  type DeskRecord,
  type WorkKind,
} from '@/lib/api/analytics'
import { useDeskSummary } from '@/lib/api/desk'
import { useOpenTasks } from '@/lib/api/desk-ops'
import type { ReportTable } from '@/lib/report'
import { bucketsOf, sumBy } from '../buckets'
import { Legend, SERIES, StackedBars } from '../charts'
import { kindName, minutes, num, stationName, when, type TFn } from '../format'
import {
  DataTable,
  Figures,
  LoadError,
  NeedsUpdate,
  Quiet,
  useExport,
  ViewSkeleton,
  type Col,
} from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'
import { tx } from '../words'

/** The views that show one kind of the person's own work, and the kind each shows. */
const KIND_OF: Partial<Record<AnalyticsView, WorkKind>> = {
  myPatients: 'patientsSeen',
  vitals: 'vitals',
  diagnoses: 'diagnoses',
  prescriptions: 'prescriptions',
  orders: 'orders',
  registrations: 'registered',
}
const ICON_OF: Partial<Record<AnalyticsView, LucideIcon>> = {
  myPatients: Stethoscope,
  vitals: Activity,
  diagnoses: ClipboardList,
  prescriptions: Pill,
  orders: FlaskConical,
  registrations: UserPlus,
}

/**
 * The desk dashboards' analytics (0102): the doctor's, the nurse's and reception's. One kind of
 * the person's own work (patients seen, vital signs, diagnoses, prescriptions, tests requested,
 * registrations) per day with its records; the desk's bookings and arrivals; the tasks; and who
 * waits now. No money, nobody else's records (desk_analytics).
 */
export function DeskWorkView({ view, period, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useDeskAnalytics(p)
  const desk = useDeskSummary(p)
  const tasks = useOpenTasks()
  const d = q.data

  useExport(() => (d && !d.needsUpdate ? deskReport(view, d, p, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!d) return <ViewSkeleton />
  if (d.needsUpdate) return <NeedsUpdate />

  const bk = bucketsOf(p.from, p.to)
  const perDay = (rows: readonly { day: string; n: number }[]) =>
    sumBy(
      bk,
      rows,
      (x) => x.day,
      (x) => x.n,
    )
  const chartAria = (what: string) =>
    tx(t, 'deskWork.chartAria', '{{what}} by day, {{period}}', { what, period: period.label })

  if (view === 'waitingNow') {
    const s = desk.data
    if (desk.error) return <LoadError error={desk.error} />
    if (!s) return <ViewSkeleton />
    const stations = s.stations.filter((x) => x.waiting + x.busy + x.forgotten > 0)
    const waiting = stations.reduce((a, x) => a + x.waiting, 0)
    const busy = stations.reduce((a, x) => a + x.busy, 0)
    const forgotten = stations.reduce((a, x) => a + x.forgotten, 0)
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={Hourglass}
            tint="amber"
            label={t('dashboard.tiles.waiting')}
            value={waiting}
            unit={t('dashboard.units.now')}
          />
          <Kpi
            i={1}
            icon={Users}
            tint="teal"
            label={t('roleHome.tiles.inProgress')}
            value={busy}
            unit={t('dashboard.units.now')}
          />
          <Kpi
            i={2}
            icon={Users}
            tint="navy"
            label={t('desk.tiles.inClinic')}
            value={s.tiles.inClinic}
            unit={t('dashboard.units.now')}
          />
          {forgotten > 0 && (
            <Kpi
              i={3}
              icon={CalendarX}
              tint="coral"
              label={t('dashboard.forgottenShort', { count: forgotten })}
              value={forgotten}
              unit={t('dashboard.units.now')}
            />
          )}
        </Figures>
        <Hint>
          {tx(
            t,
            'deskWork.waitingNote',
            'Who waits at each desk right now; the waiting times of the period are on the manager’s Analytics.',
          )}
        </Hint>
        <Panel i={1} icon={Hourglass} tint="amber" title={t('dashboard.queueNow')}>
          <DataTable
            rows={stations}
            rowKey={(r) => r.station}
            cols={[
              {
                key: 'station',
                label: t('analytics.department'),
                cell: (r) => <b>{stationName(r.station, t)}</b>,
              },
              {
                key: 'waiting',
                label: t('dashboard.tiles.waiting'),
                align: 'right',
                cell: (r) => num(r.waiting),
                sort: (r) => r.waiting,
              },
              {
                key: 'busy',
                label: t('roleHome.tiles.inProgress'),
                align: 'right',
                cell: (r) => num(r.busy),
                sort: (r) => r.busy,
              },
              {
                key: 'longest',
                label: tx(t, 'deskWork.longest', 'Longest wait'),
                align: 'right',
                wide: true,
                cell: (r) => (r.longest == null ? '—' : minutes(r.longest, t)),
                sort: (r) => r.longest,
              },
              {
                key: 'forgotten',
                label: tx(t, 'deskWork.forgotten', 'From an earlier day'),
                align: 'right',
                wide: true,
                cell: (r) =>
                  r.forgotten ? <span className="text-red">{num(r.forgotten)}</span> : '0',
                sort: (r) => r.forgotten,
              },
            ]}
            empty={<Quiet>{t('dashboard.noQueue')}</Quiet>}
            caption={t('dashboard.queueNow')}
          />
        </Panel>
      </>
    )
  }

  if (view === 'tasks') {
    const open = tasks.data ?? []
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={ListTodo}
            tint="coral"
            label={t('dept.tiles.tasks')}
            value={d.tasks.open}
            unit={t('dashboard.units.now')}
          />
          <Kpi
            i={1}
            icon={CalendarX}
            tint="amber"
            label={tx(t, 'deskWork.overdue', 'Overdue')}
            value={d.tasks.overdue}
            unit={t('dashboard.units.now')}
          />
          <Kpi
            i={2}
            icon={CircleCheck}
            tint="mint"
            label={t('analytics.kinds.tasksDone')}
            value={d.tasks.done}
            unit={period.label}
          />
          <Kpi
            i={3}
            icon={CircleCheck}
            tint="teal"
            label={tx(t, 'deskWork.doneByMe', 'Done by me')}
            value={d.tasks.doneByMe}
            unit={period.label}
          />
        </Figures>
        <Panel
          i={1}
          icon={ListTodo}
          tint="coral"
          title={t('dept.tiles.tasks')}
          right={num(open.length)}
        >
          <DataTable
            rows={open}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'title',
                label: tx(t, 'deskWork.task', 'Task'),
                cell: (r) => (
                  <span className="block">
                    <b>{r.title}</b>
                    {r.detail && <span className="text-ink-3 block text-[12px]">{r.detail}</span>}
                  </span>
                ),
                sort: (r) => r.title,
              },
              {
                key: 'patient',
                label: t('analytics.patient'),
                cell: (r) =>
                  r.encounterId ? (
                    <StaffLink
                      to="/app/visit"
                      search={{ encounter: r.encounterId }}
                      className="text-primary font-semibold [overflow-wrap:anywhere]"
                    >
                      {r.patient ?? '—'}
                    </StaffLink>
                  ) : (
                    (r.patient ?? '—')
                  ),
                sort: (r) => r.patient,
              },
              {
                key: 'due',
                label: tx(t, 'deskWork.due', 'Due'),
                wide: true,
                cell: (r) => (
                  <span className={r.overdue ? 'text-red whitespace-nowrap' : 'whitespace-nowrap'}>
                    {r.dueAt ? when(r.dueAt) : '—'}
                  </span>
                ),
                sort: (r) => r.dueAt,
              },
              {
                key: 'by',
                label: tx(t, 'deskWork.givenBy', 'Given by'),
                wide: true,
                cell: (r) => r.by ?? '—',
              },
            ]}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('dept.tiles.tasks')}
          />
        </Panel>
      </>
    )
  }

  if (view === 'bookings') {
    const b = d.bookings
    const booked = sumBy(
      bk,
      b.byDay,
      (x) => x.day,
      (x) => x.booked,
    )
    const kept = sumBy(
      bk,
      b.byDay,
      (x) => x.day,
      (x) => x.kept,
    )
    const missed = sumBy(
      bk,
      b.byDay,
      (x) => x.day,
      (x) => x.missed,
    )
    const series = [
      { key: 'kept', label: t('analytics.visits.kept'), color: SERIES[0], values: kept },
      { key: 'missed', label: t('analytics.visits.missed'), color: SERIES[2], values: missed },
    ]
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={CalendarCheck}
            tint="violet"
            label={t('dashboard.booked')}
            value={b.booked}
            unit={period.label}
          />
          <Kpi
            i={1}
            icon={CircleCheck}
            tint="mint"
            label={series[0]!.label}
            value={b.kept}
            unit={period.label}
          />
          <Kpi
            i={2}
            icon={CalendarX}
            tint="coral"
            label={series[1]!.label}
            value={b.missed}
            unit={period.label}
          />
          <Kpi
            i={3}
            icon={Hourglass}
            tint="amber"
            label={t('dashboard.pendingInquiries', { count: b.pending })}
            value={b.pending}
            unit={t('desk.units.toAnswer')}
          />
        </Figures>
        <Panel i={1} icon={CalendarCheck} tint="violet" title={t('desk.tiles.appointments')}>
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={series}
            format={(v) => formatNumber(v)}
            tick={(v) => formatNumber(v)}
            ariaLabel={chartAria(t('desk.tiles.appointments'))}
          />
          <Legend items={series} />
        </Panel>
        <Panel
          i={2}
          icon={CalendarCheck}
          tint="teal"
          title={tx(t, 'cashDesk.dayTable', 'Day by day')}
        >
          <DataTable
            rows={bk.keys.map((k, i) => ({
              key: k,
              label: bk.long[i]!,
              booked: booked[i] ?? 0,
              kept: kept[i] ?? 0,
              missed: missed[i] ?? 0,
            }))}
            rowKey={(r) => r.key}
            cols={[
              { key: 'day', label: t('report.cols.day'), cell: (r) => <b>{r.label}</b> },
              {
                key: 'booked',
                label: t('dashboard.booked'),
                align: 'right',
                cell: (r) => num(r.booked),
                sort: (r) => r.booked,
                total: num(b.booked),
              },
              {
                key: 'kept',
                label: series[0]!.label,
                align: 'right',
                cell: (r) => num(r.kept),
                sort: (r) => r.kept,
                total: num(b.kept),
              },
              {
                key: 'missed',
                label: series[1]!.label,
                align: 'right',
                cell: (r) => num(r.missed),
                sort: (r) => r.missed,
                total: num(b.missed),
              },
            ]}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('desk.tiles.appointments')}
          />
        </Panel>
      </>
    )
  }

  if (view === 'arrivals') {
    const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
    const visits = perDay(d.visits)
    const total = d.visits.reduce((a, x) => a + x.n, 0)
    const peak = d.arrivals.indexOf(Math.max(...d.arrivals))
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={Siren}
            tint="teal"
            label={t('dashboard.tiles.visits')}
            value={total}
            unit={period.label}
          />
          <Kpi
            i={1}
            icon={Hourglass}
            tint="amber"
            label={tx(t, 'deskWork.busiestHour', 'Busiest hour')}
            value={0}
            text={total ? hours[peak]! : '—'}
            unit=""
          />
          <Kpi
            i={2}
            icon={UserPlus}
            tint="mint"
            label={t('dashboard.tiles.registered')}
            value={d.registrations.reduce((a, x) => a + x.n, 0)}
            unit={period.label}
          />
        </Figures>
        <Panel
          i={1}
          icon={Siren}
          tint="teal"
          title={tx(t, 'deskWork.byHour', 'Arrivals by hour of the day')}
        >
          <StackedBars
            labels={hours}
            tickLabels={hours.map((h, i) => (i % 3 === 0 ? h.slice(0, 2) : ''))}
            series={[
              {
                key: 'arrivals',
                label: t('dashboard.tiles.visits'),
                color: SERIES[0],
                values: d.arrivals,
              },
            ]}
            format={(v) => formatNumber(v)}
            tick={(v) => formatNumber(v)}
            ariaLabel={tx(t, 'deskWork.byHour', 'Arrivals by hour of the day')}
          />
        </Panel>
        <Panel
          i={2}
          icon={Stethoscope}
          tint="mint"
          title={tx(t, 'deskWork.visitsByDay', 'Visits by day')}
        >
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={[
              {
                key: 'visits',
                label: t('dashboard.tiles.visits'),
                color: SERIES[1],
                values: visits,
              },
            ]}
            format={(v) => formatNumber(v)}
            tick={(v) => formatNumber(v)}
            ariaLabel={chartAria(t('dashboard.tiles.visits'))}
          />
        </Panel>
      </>
    )
  }

  // one kind of the person's own work
  const kind = KIND_OF[view] ?? 'patientsSeen'
  const Icon = ICON_OF[view] ?? Stethoscope
  const name = kindName(kind, t)
  const mine = perDay(d.days.filter((x) => x.kind === kind))
  const count = d.counts[kind] ?? 0
  const records = d.records.filter((r) => r.kind === kind)
  const deskWide = view === 'registrations' ? perDay(d.registrations) : null
  const series = [
    { key: 'mine', label: tx(t, 'deskWork.mine', 'Mine'), color: SERIES[0], values: mine },
    ...(deskWide
      ? [
          {
            key: 'desk',
            label: tx(t, 'deskWork.wholeDesk', 'Whole desk'),
            color: SERIES[3],
            values: deskWide.map((v, i) => Math.max(0, v - (mine[i] ?? 0))),
          },
        ]
      : []),
  ]
  const cols: Col<DeskRecord>[] = [
    {
      key: 'at',
      label: t('report.cols.dateTime'),
      cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
      sort: (r) => r.at,
    },
    {
      key: 'patient',
      label: t('analytics.patient'),
      cell: (r) => (
        <span className="block min-w-0">
          {r.encounterId ? (
            <StaffLink
              to="/app/visit"
              search={{ encounter: r.encounterId }}
              className="text-primary font-semibold [overflow-wrap:anywhere]"
            >
              {r.patientName ?? '—'}
            </StaffLink>
          ) : (
            <b>{r.patientName ?? '—'}</b>
          )}
          {r.fileNumber && <span className="text-ink-3 block text-[12px]">{r.fileNumber}</span>}
        </span>
      ),
      sort: (r) => r.patientName,
    },
    { key: 'what', label: tx(t, 'deskWork.what', 'What'), cell: (r) => r.what ?? '—' },
  ]
  return (
    <>
      <Figures>
        <Kpi i={0} icon={Icon} tint="teal" label={name} value={count} unit={period.label} />
        {deskWide && (
          <Kpi
            i={1}
            icon={UserPlus}
            tint="navy"
            label={tx(t, 'deskWork.wholeDesk', 'Whole desk')}
            value={d.registrations.reduce((a, x) => a + x.n, 0)}
            unit={period.label}
          />
        )}
        <Kpi
          i={2}
          icon={Users}
          tint="mint"
          label={tx(t, 'deskWork.patients', 'Patients')}
          value={new Set(records.map((r) => r.fileNumber ?? r.patientName)).size}
          unit={period.label}
        />
      </Figures>
      <Hint>{tx(t, 'deskWork.mineNote', 'Your own work in the period, as the records say.')}</Hint>
      <Panel i={1} icon={Icon} tint="teal" title={name}>
        <StackedBars
          labels={bk.long}
          tickLabels={bk.short}
          series={series}
          format={(v) => formatNumber(v)}
          tick={(v) => formatNumber(v)}
          ariaLabel={chartAria(name)}
        />
        {series.length > 1 && <Legend items={series} />}
      </Panel>
      <Panel
        i={2}
        icon={ClipboardList}
        tint="navy"
        title={tx(t, 'deskWork.records', 'Records')}
        right={num(records.length)}
      >
        <DataTable<DeskRecord>
          rows={records}
          rowKey={(r) => `${r.at}-${r.encounterId ?? ''}-${r.what ?? ''}`}
          cols={cols}
          initialSort={{ key: 'at', desc: true }}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={name}
        />
      </Panel>
    </>
  )
}

function deskReport(
  view: AnalyticsView,
  d: DeskAnalytics,
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const kind = KIND_OF[view] ?? null
  const tables: ReportTable[] = []
  if (view === 'bookings')
    tables.push({
      title: t('desk.tiles.appointments'),
      columns: [
        { label: t('report.cols.day'), kind: 'date' },
        { label: t('dashboard.booked'), kind: 'number' },
        { label: t('analytics.visits.kept'), kind: 'number' },
        { label: t('report.t.missed'), kind: 'number' },
      ],
      rows: d.bookings.byDay.map((x) => [x.day, x.booked, x.kept, x.missed]),
      totals: [1, 2, 3],
    })
  else if (view === 'arrivals')
    tables.push({
      title: tx(t, 'deskWork.byHour', 'Arrivals by hour of the day'),
      columns: [
        { label: tx(t, 'deskWork.hour', 'Hour') },
        { label: t('dashboard.tiles.visits'), kind: 'number' },
      ],
      rows: d.arrivals.map((n, h) => [`${String(h).padStart(2, '0')}:00`, n]),
      totals: [1],
    })
  else if (view === 'tasks')
    tables.push({
      title: t('dept.tiles.tasks'),
      columns: [
        { label: t('report.cols.figure') },
        { label: t('report.cols.value'), kind: 'number' },
      ],
      rows: [
        [tx(t, 'deskWork.open', 'Open'), d.tasks.open],
        [tx(t, 'deskWork.overdue', 'Overdue'), d.tasks.overdue],
        [t('analytics.kinds.tasksDone'), d.tasks.done],
        [tx(t, 'deskWork.doneByMe', 'Done by me'), d.tasks.doneByMe],
      ],
    })
  else if (kind) {
    const name = kindName(kind, t)
    tables.push(
      {
        title: name,
        columns: [
          { label: t('report.cols.day'), kind: 'date' },
          { label: name, kind: 'number' },
        ],
        rows: d.days.filter((x) => x.kind === kind).map((x) => [x.day, x.n]),
        totals: [1],
      },
      {
        title: tx(t, 'deskWork.records', 'Records'),
        columns: [
          { label: t('report.cols.dateTime'), kind: 'datetime' },
          { label: t('analytics.patient') },
          { label: t('report.cols.file'), under: true },
          { label: tx(t, 'deskWork.what', 'What') },
        ],
        rows: d.records
          .filter((r) => r.kind === kind)
          .map((r) => [r.at, r.patientName, r.fileNumber, r.what]),
      },
    )
  }
  return analyticsReport({
    t,
    clinic: clinic ?? CLINIC_PROFILE,
    title: tx(t, `analytics.views.${view}`, view),
    code: 'DSK',
    name: `desk-${view}`,
    from: p.from,
    to: p.to,
    figures: Object.entries(d.counts)
      .slice(0, 6)
      .map(([k, v]) => ({ label: kindName(k, t), value: v })),
    sections: [{ name: tx(t, 'analytics.groups.mine', 'My work'), tables }],
  })
}
