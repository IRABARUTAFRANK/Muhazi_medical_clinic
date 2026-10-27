import {
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  ChartColumn,
  ListOrdered,
  Stethoscope,
  Tags,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatHour, formatNumber, formatRwf } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { delta } from '@/components/dash/kit-style'
import { StaffLink } from '@/components/staff/staff-link'
import { Button, buttonVariants } from '@/components/ui/button'
import { controlClass } from '@/components/ui/field'
import {
  useVisitsAnalysis,
  type Treatment,
  type VisitsAnalysis,
  type VisitsDay,
} from '@/lib/api/analytics'
import { categoryName } from '@/lib/api/catalogue'
import type { ReportTable } from '@/lib/report'
import { cn } from '@/lib/utils'
import { bucketsOf, sumBy } from '../buckets'
import { Legend, PickBars, SERIES, StackedBars } from '../charts'
import { dayLong, groupName, num, pct, short, type TFn } from '../format'
import {
  Choice,
  DataTable,
  Figures,
  LoadError,
  NeedsUpdate,
  Quiet,
  Stat,
  useExport,
  ViewSkeleton,
  type Col,
} from '../kit'
import { analyticsReport } from '../reports'
import { pickBy, type ViewProps } from '../view-props'

const VISITS_BY = ['days', 'group', 'type', 'hour', 'bookings'] as const
type VisitsBy = (typeof VISITS_BY)[number]

const typeName = (type: string, t: TFn) =>
  t(`analytics.visits.types.${type}`, { defaultValue: type.replace(/_/g, ' ') })

/** The name of a service category in the interface language. */
const catName = (
  c: { name: string | null; nameKin: string | null; nameFr: string | null; group?: string },
  lang: string,
  t: TFn,
) =>
  c.name
    ? categoryName({ nameEn: c.name, nameKin: c.nameKin, nameFr: c.nameFr }, lang)
    : c.group
      ? groupName(c.group, t)
      : t('analytics.visits.noCategory')

/** Patients and visits in the period. */
export function VisitsView({ period, search, update, dept, clinic }: ViewProps) {
  const { t, i18n } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useVisitsAnalysis(p, dept)
  const v = q.data
  const by = pickBy<VisitsBy>(search.by, VISITS_BY, 'days')

  useExport(() => (v && !v.needsUpdate ? visitsReport(v, t, i18n.language, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!v) return <ViewSkeleton />
  if (v.needsUpdate) return <NeedsUpdate />

  const T = v.totals
  const P = v.prev
  const bk = bucketsOf(v.from || p.from, v.to || p.to)
  const visits = sumBy(
    bk,
    v.days,
    (x) => x.day,
    (x) => x.visits,
  )
  const registered = sumBy(
    bk,
    v.days,
    (x) => x.day,
    (x) => x.registered,
  )
  const series = [
    { key: 'visits', label: t('analytics.visits.visits'), color: SERIES[0], values: visits },
  ]
  const lines = [{ label: t('analytics.visits.registered'), color: SERIES[1], values: registered }]

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={UserPlus}
          tint="teal"
          label={t('analytics.visits.registered')}
          value={T.registered}
          unit=""
          delta={delta(T.registered, P.registered, true, t)}
        />
        <Kpi
          i={1}
          icon={Stethoscope}
          tint="mint"
          label={t('analytics.visits.visits')}
          value={T.visits}
          unit=""
          delta={delta(T.visits, P.visits, true, t)}
        />
        <Kpi
          i={2}
          icon={Users}
          tint="violet"
          label={t('analytics.visits.newReturning')}
          value={T.newPatients}
          text={`${formatNumber(T.newPatients)} / ${formatNumber(T.returning)}`}
          unit=""
          delta={delta(T.newPatients, P.newPatients, true, t)}
        />
        <Kpi
          i={3}
          icon={CalendarCheck}
          tint="amber"
          label={t('analytics.visits.keptMissed')}
          value={T.kept}
          text={`${formatNumber(T.kept)} / ${formatNumber(T.missed)}`}
          unit=""
          delta={delta(T.kept, P.kept, true, t)}
        />
      </Figures>

      <Panel i={1} icon={ChartColumn} tint="mint" title={t('analytics.visits.chartTitle')}>
        <Legend
          items={[
            { label: series[0]!.label, color: series[0]!.color },
            { label: lines[0]!.label, color: lines[0]!.color, line: true },
          ]}
        />
        {T.visits + T.registered === 0 ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={series}
            lines={lines}
            format={(x) => formatNumber(x)}
            tick={short}
            onPick={
              bk.monthly
                ? (i) => {
                    const sp = bk.span(bk.keys[i]!)
                    update({ range: 'custom', from: sp.from, to: sp.to })
                  }
                : undefined
            }
            ariaLabel={t('analytics.visits.chartAria', { period: period.label, count: T.visits })}
          />
        )}
        {bk.monthly && <Hint>{t('analytics.chartHintMonth')}</Hint>}
      </Panel>

      <Panel
        i={2}
        icon={ListOrdered}
        tint="teal"
        title={t('analytics.breakdown')}
        right={
          <Choice<VisitsBy>
            label={t('analytics.breakdown')}
            value={by}
            onChange={(x) => update({ by: x === 'days' ? undefined : x }, { replace: true })}
            options={VISITS_BY.map((x) => ({ value: x, label: t(`analytics.visits.by.${x}`) }))}
          />
        }
      >
        {by === 'days' && <DayTable v={v} />}
        {by === 'group' &&
          (v.byGroup.length === 0 ? (
            <Quiet>{t('analytics.noData')}</Quiet>
          ) : (
            <>
              <PickBars
                color={SERIES[0]}
                rows={v.byGroup.map((g) => ({
                  key: g.categoryId ?? `group:${g.group}`,
                  label: catName(g, i18n.language, t),
                  value: g.count,
                  display: `${formatNumber(g.count)} · ${pct(g.count, T.visits)}`,
                }))}
                onPick={(k) =>
                  update({
                    view: 'treatments',
                    by: undefined,
                    group: k.startsWith('group:') ? undefined : k,
                  })
                }
              />
              <Hint>{t('analytics.visits.groupHint')}</Hint>
            </>
          ))}
        {by === 'type' && (
          <DataTable
            rows={v.byType}
            rowKey={(r) => r.type}
            cols={[
              { key: 'type', label: t('report.cols.type'), cell: (r) => typeName(r.type, t) },
              {
                key: 'count',
                label: t('analytics.visits.visits'),
                align: 'right',
                cell: (r) => num(r.count),
                sort: (r) => r.count,
                total: num(v.byType.reduce((s, x) => s + x.count, 0)),
              },
              {
                key: 'share',
                label: t('analytics.share'),
                align: 'right',
                cell: (r) =>
                  pct(
                    r.count,
                    v.byType.reduce((s, x) => s + x.count, 0),
                  ),
              },
            ]}
            initialSort={{ key: 'count', desc: true }}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('analytics.visits.by.type')}
          />
        )}
        {by === 'hour' && (
          <>
            <StackedBars
              labels={v.byHour.map((_, h) => `${formatHour(h)}–${formatHour((h + 1) % 24)}`)}
              tickLabels={v.byHour.map((_, h) => formatHour(h))}
              series={[
                {
                  key: 'arrivals',
                  label: t('analytics.visits.arrivals'),
                  color: SERIES[0],
                  values: v.byHour,
                },
              ]}
              format={(x) => formatNumber(x)}
              tick={short}
              ariaLabel={t('analytics.visits.hourAria')}
            />
            <Hint>{t('analytics.visits.hourHint')}</Hint>
          </>
        )}
        {by === 'bookings' && (
          <>
            <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Stat
                icon={CalendarPlus}
                label={t('analytics.visits.booked')}
                value={num(T.booked)}
              />
              <Stat
                icon={CalendarCheck}
                label={t('analytics.visits.kept')}
                value={num(T.kept)}
                tone="green"
              />
              <Stat
                icon={CalendarX}
                label={t('analytics.visits.missed')}
                value={num(T.missed)}
                tone={T.missed ? 'red' : undefined}
              />
              <Stat
                icon={CalendarClock}
                tint="amber"
                label={t('analytics.visits.pending')}
                value={num(T.pending)}
              />
            </div>
            <StaffLink
              to="/app/appointments"
              className={cn(buttonVariants({ variant: 'tint-teal', size: 'sm' }), 'self-start')}
            >
              <CalendarCheck size={16} aria-hidden="true" />
              {t('analytics.visits.openBookings')}
            </StaffLink>
          </>
        )}
      </Panel>
    </>
  )
}

function DayTable({ v }: { v: VisitsAnalysis }) {
  const { t } = useTranslation()
  const types = v.byType.map((x) => x.type)
  const days = [...v.days].reverse()
  const sum = (f: (d: VisitsDay) => number) => num(days.reduce((s, d) => s + f(d), 0))
  const cols: Col<VisitsDay>[] = [
    { key: 'day', label: t('report.cols.day'), cell: (r) => dayLong(r.day), sort: (r) => r.day },
    {
      key: 'visits',
      label: t('analytics.visits.visits'),
      align: 'right',
      cell: (r) => <b>{num(r.visits)}</b>,
      sort: (r) => r.visits,
      total: sum((d) => d.visits),
    },
    {
      key: 'new',
      label: t('analytics.visits.new'),
      align: 'right',
      cell: (r) => num(r.newPatients),
      sort: (r) => r.newPatients,
      total: sum((d) => d.newPatients),
    },
    {
      key: 'returning',
      label: t('analytics.visits.returning'),
      align: 'right',
      wide: true,
      cell: (r) => num(r.returning),
      sort: (r) => r.returning,
      total: sum((d) => d.returning),
    },
    {
      key: 'registered',
      label: t('analytics.visits.registered'),
      align: 'right',
      wide: true,
      cell: (r) => num(r.registered),
      sort: (r) => r.registered,
      total: sum((d) => d.registered),
    },
    ...types.map((ty): Col<VisitsDay> => ({
      key: `type-${ty}`,
      label: typeName(ty, t),
      align: 'right',
      wide: true,
      cell: (r) => num(r.byType[ty] ?? 0),
      sort: (r) => r.byType[ty] ?? 0,
      total: sum((d) => d.byType[ty] ?? 0),
    })),
  ]
  return (
    <DataTable
      rows={days}
      cols={cols}
      rowKey={(r) => r.day}
      totalsLabel={t('report.total')}
      empty={<Quiet>{t('analytics.noData')}</Quiet>}
      caption={t('analytics.visits.by.days')}
    />
  )
}

/** The treatments (services) given in the period; `group=` limits them to one category. */
export function TreatmentsView({ period, search, update, dept, clinic }: ViewProps) {
  const { t, i18n } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useVisitsAnalysis(p, dept)
  const v = q.data
  const group = search.group ?? null

  const rowsOf = (d: VisitsAnalysis) =>
    group ? d.treatments.filter((x) => x.categoryId === group) : d.treatments
  useExport(() =>
    v && !v.needsUpdate ? treatmentsReport(v, rowsOf(v), group, t, i18n.language, clinic) : null,
  )

  if (q.error) return <LoadError error={q.error} />
  if (!v) return <ViewSkeleton />
  if (v.needsUpdate) return <NeedsUpdate />

  const rows = rowsOf(v)
  const total = rows.reduce((s, x) => s + x.count, 0)
  const manager = v.manager && v.treatmentTotals.charged != null
  const cat = (x: Treatment) =>
    catName({ name: x.category, nameKin: x.categoryKin, nameFr: x.categoryFr }, i18n.language, t)
  // categories present, most given first
  const cats = new Map<string, { name: string; count: number }>()
  for (const x of v.treatments) {
    const k = x.categoryId ?? ''
    const c = cats.get(k) ?? { name: cat(x), count: 0 }
    c.count += x.count
    cats.set(k, c)
  }
  const catList = [...cats.entries()].sort((a, b) => b[1].count - a[1].count)
  const top = catList[0]
  const groupLabel = group
    ? (cats.get(group)?.name ?? v.byGroup.find((g) => g.categoryId === group)?.name ?? '')
    : null

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={ListOrdered}
          tint="teal"
          label={t('analytics.treatments.given')}
          value={v.treatmentTotals.lines}
          unit=""
        />
        <Kpi
          i={1}
          icon={Tags}
          tint="violet"
          label={t('analytics.treatments.distinct')}
          value={v.treatmentTotals.distinct}
          unit=""
        />
        {manager ? (
          <Kpi
            i={2}
            icon={Wallet}
            tint="amber"
            label={t('analytics.revenue.charged')}
            value={v.treatmentTotals.charged ?? 0}
            unit="RWF"
          />
        ) : (
          <Kpi
            i={2}
            icon={Stethoscope}
            tint="amber"
            label={t('analytics.visits.visits')}
            value={v.totals.visits}
            unit=""
          />
        )}
        <Kpi
          i={3}
          icon={Stethoscope}
          tint="mint"
          label={t('analytics.treatments.topCategory')}
          value={top?.[1].count ?? 0}
          text={top ? top[1].name : '—'}
          unit=""
        />
      </Figures>

      <Panel
        i={1}
        icon={ChartColumn}
        tint="teal"
        title={t('analytics.treatments.top15')}
        right={
          <select
            aria-label={t('analytics.treatments.category')}
            value={group ?? ''}
            onChange={(e) => update({ group: e.target.value || undefined }, { replace: true })}
            className={cn(controlClass, 'h-8 max-w-full px-2 text-[13px]')}
          >
            <option value="">{t('analytics.treatments.allCategories')}</option>
            {catList
              .filter(([k]) => k)
              .map(([k, c]) => (
                <option key={k} value={k}>
                  {c.name}
                </option>
              ))}
          </select>
        }
      >
        {group && (
          <Button
            variant="tint-teal"
            size="sm"
            className="self-start"
            onClick={() => update({ group: undefined }, { replace: true })}
          >
            {groupLabel || t('analytics.treatments.category')}
            <X size={14} aria-hidden="true" />
            <span className="sr-only">{t('analytics.treatments.clearCategory')}</span>
          </Button>
        )}
        {rows.length === 0 ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <PickBars
            color={SERIES[0]}
            rows={rows.slice(0, 15).map((x) => ({
              key: `${x.description}-${x.categoryId}`,
              label: x.description,
              value: x.count,
              display:
                manager && x.amount != null
                  ? `${formatNumber(x.count)} · ${formatNumber(x.amount)}`
                  : formatNumber(x.count),
            }))}
          />
        )}
      </Panel>

      <Panel
        i={2}
        icon={ListOrdered}
        tint="navy"
        title={t('analytics.treatments.all')}
        right={num(rows.length)}
      >
        <DataTable<Treatment>
          rows={rows}
          rowKey={(r) => `${r.description}-${r.categoryId}`}
          cols={[
            {
              key: 'name',
              label: t('report.cols.treatment'),
              cell: (r) => r.description,
              sort: (r) => r.description,
            },
            {
              key: 'cat',
              label: t('analytics.treatments.category'),
              wide: true,
              cell: cat,
              sort: cat,
            },
            {
              key: 'count',
              label: t('report.cols.count'),
              align: 'right',
              cell: (r) => num(r.count),
              sort: (r) => r.count,
              total: num(total),
            },
            ...(manager
              ? [
                  {
                    key: 'amount',
                    label: t('analytics.amountRwf'),
                    align: 'right' as const,
                    cell: (r: Treatment) => num(r.amount),
                    sort: (r: Treatment) => r.amount ?? 0,
                    total: num(rows.reduce((s, x) => s + (x.amount ?? 0), 0)),
                  },
                ]
              : []),
            {
              key: 'share',
              label: t('analytics.share'),
              align: 'right',
              wide: true,
              cell: (r) => pct(r.count, total),
            },
          ]}
          initialSort={{ key: 'count', desc: true }}
          totalsLabel={t('report.total')}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={t('analytics.treatments.all')}
        />
      </Panel>
    </>
  )
}

/* ---------------------------------------------------------------- export */

function visitsReport(v: VisitsAnalysis, t: TFn, lang: string, clinic: ViewProps['clinic']) {
  const T = v.totals
  const types = v.byType.map((x) => x.type)
  const tables: ReportTable[] = [
    {
      title: t('analytics.visits.by.days'),
      columns: [
        { label: t('report.cols.day'), kind: 'date' },
        { label: t('analytics.visits.visits'), kind: 'number' },
        { label: t('analytics.visits.new'), kind: 'number' },
        { label: t('analytics.visits.returning'), kind: 'number' },
        { label: t('analytics.visits.registered'), kind: 'number' },
        ...types.map((ty) => ({ label: typeName(ty, t), kind: 'number' as const })),
      ],
      rows: v.days.map((d) => [
        d.day,
        d.visits,
        d.newPatients,
        d.returning,
        d.registered,
        ...types.map((ty) => d.byType[ty] ?? 0),
      ]),
      totals: [1, 2, 3, 4, ...types.map((_, i) => 5 + i)],
    },
    {
      title: t('report.t.visitsByType'),
      columns: [
        { label: t('report.cols.type') },
        { label: t('report.cols.visits'), kind: 'number' },
      ],
      rows: v.byType.map((x) => [typeName(x.type, t), x.count]),
      totals: [1],
    },
    {
      title: t('analytics.visits.by.group'),
      columns: [
        { label: t('analytics.treatments.category') },
        { label: t('report.cols.visits'), kind: 'number' },
      ],
      rows: v.byGroup.map((g) => [catName(g, lang, t), g.count]),
    },
    {
      title: t('report.t.bookings'),
      columns: [
        { label: t('report.cols.type') },
        { label: t('report.cols.count'), kind: 'number' },
      ],
      rows: [
        [t('analytics.visits.booked'), T.booked],
        [t('analytics.visits.kept'), T.kept],
        [t('analytics.visits.missed'), T.missed],
        [t('analytics.visits.pending'), T.pending],
      ],
    },
    {
      title: t('analytics.visits.by.hour'),
      columns: [
        { label: t('report.cols.time') },
        { label: t('analytics.visits.arrivals'), kind: 'number' },
      ],
      rows: v.byHour.map((n, h) => [formatHour(h), n]),
      totals: [1],
    },
  ]
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.visits.reportTitle'),
    code: 'VIS',
    name: 'visits',
    from: v.from,
    to: v.to,
    figures: [
      { label: t('analytics.visits.visits'), value: T.visits },
      { label: t('analytics.visits.registered'), value: T.registered },
      { label: t('analytics.visits.new'), value: T.newPatients },
      { label: t('analytics.visits.returning'), value: T.returning },
      { label: t('analytics.visits.kept'), value: T.kept },
      { label: t('analytics.visits.missed'), value: T.missed },
    ],
    summary: t('analytics.visits.summary', {
      visits: formatNumber(T.visits),
      prev: formatNumber(v.prev.visits),
      registered: formatNumber(T.registered),
    }),
    sections: [{ name: t('analytics.visits.reportTitle'), tables }],
  })
}

function treatmentsReport(
  v: VisitsAnalysis,
  rows: Treatment[],
  group: string | null,
  t: TFn,
  lang: string,
  clinic: ViewProps['clinic'],
) {
  const manager = v.manager && v.treatmentTotals.charged != null
  const total = rows.reduce((s, x) => s + x.count, 0)
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.treatments.reportTitle'),
    code: 'TRT',
    name: group ? 'treatments-category' : 'treatments',
    from: v.from,
    to: v.to,
    figures: [
      { label: t('analytics.treatments.given'), value: v.treatmentTotals.lines },
      { label: t('analytics.treatments.distinct'), value: v.treatmentTotals.distinct },
      ...(manager
        ? [
            {
              label: t('analytics.revenue.charged'),
              value: v.treatmentTotals.charged ?? 0,
              unit: 'RWF',
            },
          ]
        : []),
    ],
    sections: [
      {
        name: t('analytics.treatments.reportTitle'),
        tables: [
          {
            title: t('analytics.treatments.all'),
            columns: [
              { label: t('report.cols.treatment') },
              { label: t('analytics.treatments.category') },
              { label: t('report.cols.count'), kind: 'number' },
              ...(manager ? [{ label: t('report.cols.amount'), kind: 'money' as const }] : []),
            ],
            rows: rows.map((x) => [
              x.description,
              catName({ name: x.category, nameKin: x.categoryKin, nameFr: x.categoryFr }, lang, t),
              x.count,
              ...(manager ? [x.amount ?? 0] : []),
            ]),
            totals: manager ? [2, 3] : [2],
          },
        ],
      },
    ],
    summary: [
      t('analytics.treatments.summary', { count: formatNumber(total), distinct: rows.length }),
      manager
        ? t('analytics.treatments.summaryMoney', {
            amount: formatRwf(rows.reduce((s, x) => s + (x.amount ?? 0), 0)),
          })
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  })
}
