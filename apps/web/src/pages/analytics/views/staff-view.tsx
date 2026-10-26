import { useState } from 'react'
import { ChartColumn, FileText, Stethoscope, Users, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { delta } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { controlClass } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import {
  previousPeriod,
  useStaffActivity,
  useStaffActivityDetail,
  type ActivityKind,
  type ActivityPerson,
  type StaffActivity,
  type StaffActivityDetail,
} from '@/lib/api/analytics'
import type { ReportTable } from '@/lib/report'
import { bucketsOf } from '../buckets'
import { Legend, StackedBars } from '../charts'
import { kindName, num, roleName, short, when, type TFn } from '../format'
import {
  Choice,
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
import { pickBy, type ViewProps } from '../view-props'
import { workSeries } from '../work-series'
import { PersonDrawer } from './person-drawer'

const STAFF_BY = ['people', 'signins'] as const
type StaffBy = (typeof STAFF_BY)[number]

/** Who did what, in detail: everyone, then one person in the side panel (`person=`). */
export function StaffView({ period, search, update, dept, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useStaffActivity(p, dept)
  const prev = useStaffActivity(previousPeriod(p), dept)
  const a = q.data
  const kind = search.kind && a?.kinds.includes(search.kind) ? search.kind : null
  const by = pickBy<StaffBy>(search.by, STAFF_BY, 'people')
  const [role, setRole] = useState('')
  // the open person's records (the side panel reads the same query)
  const detail = useStaffActivityDetail(search.person ?? null, p, kind)

  useExport(() =>
    a && !a.needsUpdate
      ? staffReport(a, search.person ? (detail.data ?? null) : null, t, clinic)
      : null,
  )

  if (q.error) return <LoadError error={q.error} />
  if (!a) return <ViewSkeleton />
  if (a.needsUpdate) return <NeedsUpdate />

  const S = a.summary
  const PS = prev.data && !prev.data.needsUpdate ? prev.data.summary : null
  const bk = bucketsOf(a.from || p.from, a.to || p.to)
  const series = workSeries(bk, a.days, a.kinds, kind, t)
  const roles = [...new Set(a.people.map((x) => x.role))].sort()
  const people = role ? a.people.filter((x) => x.role === role) : a.people
  const openPerson = (id: string) => update({ person: id })

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Users}
          tint="teal"
          label={t('analytics.staff.peopleActive')}
          value={S.peopleActive}
          unit=""
          delta={PS ? delta(S.peopleActive, PS.peopleActive, true, t) : undefined}
        />
        <Kpi
          i={1}
          icon={Stethoscope}
          tint="violet"
          label={t('analytics.kinds.patientsSeen')}
          value={S.patientsSeen}
          unit=""
          delta={PS ? delta(S.patientsSeen, PS.patientsSeen, true, t) : undefined}
        />
        <Kpi
          i={2}
          icon={FileText}
          tint="mint"
          label={t('analytics.staff.records')}
          value={S.records}
          unit=""
          delta={PS ? delta(S.records, PS.records, true, t) : undefined}
        />
        {S.collected != null ? (
          <Kpi
            i={3}
            icon={Wallet}
            tint="amber"
            label={t('analytics.revenue.collected')}
            value={S.collected}
            unit="RWF"
            delta={PS?.collected != null ? delta(S.collected, PS.collected, true, t) : undefined}
          />
        ) : (
          <Kpi
            i={3}
            icon={Users}
            tint="amber"
            label={t('analytics.staff.peopleListed')}
            value={a.people.length}
            unit=""
          />
        )}
      </Figures>
      <Hint>{t('analytics.staff.seenRule')}</Hint>

      <Panel
        i={1}
        icon={ChartColumn}
        tint="teal"
        title={t('analytics.staff.chartTitle')}
        right={
          <KindPicker
            kinds={a.kinds.filter((k) => k !== 'patientsSeen' && (a.totals[k] ?? 0) > 0)}
            value={kind}
            onChange={(k) => update({ kind: k ?? undefined }, { replace: true })}
          />
        }
      >
        {series.length > 1 && (
          <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
        )}
        {series.every((s) => s.values.every((v) => !v)) ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={series}
            format={(v) => formatNumber(v)}
            tick={short}
            onPick={
              bk.monthly
                ? (i) => {
                    const sp = bk.span(bk.keys[i]!)
                    update({ range: 'custom', from: sp.from, to: sp.to })
                  }
                : undefined
            }
            ariaLabel={t('analytics.staff.chartAria', { period: period.label })}
          />
        )}
        {bk.monthly && (
          <p className="text-ink-3 m-0 text-[13px]">{t('analytics.chartHintMonth')}</p>
        )}
      </Panel>

      <Panel
        i={2}
        icon={Users}
        tint="navy"
        title={t('analytics.staff.tableTitle')}
        right={
          <span className="flex flex-wrap items-center gap-2">
            {by === 'people' && roles.length > 1 && (
              <select
                aria-label={t('analytics.staff.role')}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={cn(controlClass, 'h-8 max-w-full px-2 text-[13px]')}
              >
                <option value="">{t('analytics.staff.allRoles')}</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r, t)}
                  </option>
                ))}
              </select>
            )}
            <Choice<StaffBy>
              label={t('analytics.breakdown')}
              value={by}
              onChange={(v) => update({ by: v === 'people' ? undefined : v }, { replace: true })}
              options={STAFF_BY.map((v) => ({ value: v, label: t(`analytics.staff.by.${v}`) }))}
            />
          </span>
        }
      >
        {by === 'signins' ? (
          <SignInList people={a.people} onOpen={openPerson} />
        ) : (
          <PeopleTable
            a={a}
            people={people}
            kind={kind}
            onOpen={openPerson}
            selected={search.person ?? null}
          />
        )}
      </Panel>

      {search.person && (
        <PersonDrawer
          userId={search.person}
          period={p}
          periodLabel={period.label}
          kind={kind}
          manager={a.manager}
          onKind={(k) => update({ kind: k ?? undefined }, { replace: true })}
          onClose={() => update({ person: undefined })}
        />
      )}
    </>
  )
}

/** "All kinds of work" or one kind (limits the chart, the table and the person's records). */
export function KindPicker({
  kinds,
  value,
  onChange,
}: {
  kinds: readonly ActivityKind[]
  value: ActivityKind | null
  onChange: (k: ActivityKind | null) => void
}) {
  const { t } = useTranslation()
  return (
    <select
      aria-label={t('analytics.staff.kind')}
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || null) as ActivityKind | null)}
      className={cn(controlClass, 'h-8 max-w-full px-2 text-[13px]')}
    >
      <option value="">{t('analytics.staff.allKinds')}</option>
      {kinds.map((k) => (
        <option key={k} value={k}>
          {kindName(k, t)}
        </option>
      ))}
    </select>
  )
}

function PersonName({ p }: { p: ActivityPerson }) {
  const { t } = useTranslation()
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
        {p.name}
        {!p.active && (
          <Badge tone="grey" dot={false}>
            {t('analytics.staff.left')}
          </Badge>
        )}
      </span>
      <span className="text-ink-3 text-[12px] font-normal">
        {roleName(p.role, t)}
        {p.staffId ? ` · ${p.staffId}` : ''}
      </span>
    </span>
  )
}

function PeopleTable({
  a,
  people,
  kind,
  onOpen,
  selected,
}: {
  a: StaffActivity
  people: ActivityPerson[]
  kind: ActivityKind | null
  onOpen: (id: string) => void
  selected: string | null
}) {
  const { t } = useTranslation()
  const sum = (k: string) => people.reduce((s, x) => s + (x.counts[k] ?? 0), 0)
  // the kinds done by someone in the period; on a phone: patients seen, records and the kind chosen
  const shown = a.kinds.filter((k) => (a.totals[k] ?? 0) > 0)
  const cols: Col<ActivityPerson>[] = [
    {
      key: 'name',
      label: t('report.cols.name'),
      cell: (r) => <PersonName p={r} />,
      sort: (r) => r.name,
    },
    {
      key: 'dept',
      label: t('analytics.department'),
      wide: true,
      cell: (r) => r.departments.map((d) => d.name).join(', ') || '—',
    },
    ...shown.map((k): Col<ActivityPerson> => ({
      key: k,
      label: kindName(k, t),
      align: 'right',
      wide: k !== 'patientsSeen' && k !== kind,
      cell: (r) => num(r.counts[k] ?? 0),
      sort: (r) => r.counts[k] ?? 0,
      total: num(sum(k)),
    })),
    {
      key: 'records',
      label: t('analytics.staff.records'),
      align: 'right',
      cell: (r) => <b>{num(r.records)}</b>,
      sort: (r) => r.records,
      total: num(people.reduce((s, x) => s + x.records, 0)),
    },
    ...(a.manager
      ? [
          {
            key: 'amount',
            label: t('analytics.amountRwf'),
            align: 'right' as const,
            wide: true,
            cell: (r: ActivityPerson) => num(r.amount),
            sort: (r: ActivityPerson) => r.amount ?? 0,
            total: num(people.reduce((s, x) => s + (x.amount ?? 0), 0)),
          },
        ]
      : []),
    {
      key: 'signin',
      label: t('report.cols.lastSignIn'),
      wide: true,
      cell: (r) => <span className="whitespace-nowrap">{when(r.lastSignIn)}</span>,
      sort: (r) => r.lastSignIn ?? '',
    },
  ]
  return (
    <DataTable
      rows={people}
      cols={cols}
      rowKey={(r) => r.id}
      onRow={(r) => onOpen(r.id)}
      rowLabel={(r) => t('analytics.staff.openPerson', { name: r.name })}
      initialSort={kind ? { key: kind, desc: true } : { key: 'records', desc: true }}
      totalsLabel={t('report.total')}
      empty={<Quiet>{t('analytics.staff.nobody')}</Quiet>}
      caption={t('analytics.staff.tableTitle')}
      selectedKey={selected}
    />
  )
}

function SignInList({
  people,
  onOpen,
}: {
  people: ActivityPerson[]
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <DataTable
        rows={people}
        rowKey={(r) => r.id}
        onRow={(r) => onOpen(r.id)}
        rowLabel={(r) => t('analytics.staff.openPerson', { name: r.name })}
        cols={[
          {
            key: 'name',
            label: t('report.cols.name'),
            cell: (r) => <PersonName p={r} />,
            sort: (r) => r.name,
          },
          {
            key: 'signin',
            label: t('report.cols.lastSignIn'),
            cell: (r) => <span className="whitespace-nowrap">{when(r.lastSignIn)}</span>,
            sort: (r) => r.lastSignIn ?? '',
          },
        ]}
        initialSort={{ key: 'signin', desc: true }}
        empty={<Quiet>{t('analytics.staff.nobody')}</Quiet>}
        caption={t('analytics.staff.by.signins')}
      />
      <Hint>{t('analytics.staff.signinsNote')}</Hint>
    </>
  )
}

/* ---------------------------------------------------------------- export */

function staffReport(
  a: StaffActivity,
  d: StaffActivityDetail | null,
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const kinds = a.kinds.filter((k) => (a.totals[k] ?? 0) > 0)
  const tables: ReportTable[] = [
    {
      title: t('analytics.staff.tableTitle'),
      note: t('analytics.staff.seenRule'),
      columns: [
        { label: t('report.cols.name') },
        { label: t('report.cols.role') },
        { label: t('analytics.department') },
        ...kinds.map((k) => ({ label: kindName(k, t), kind: 'number' as const })),
        { label: t('analytics.staff.records'), kind: 'number' as const },
        ...(a.manager ? [{ label: t('report.cols.collected'), kind: 'money' as const }] : []),
        { label: t('report.cols.lastSignIn'), kind: 'datetime' as const },
      ],
      rows: a.people.map((x) => [
        x.active ? x.name : `${x.name} (${t('analytics.staff.left')})`,
        roleName(x.role, t),
        x.departments.map((dp) => dp.name).join(', '),
        ...kinds.map((k) => x.counts[k] ?? 0),
        x.records,
        ...(a.manager ? [x.amount ?? 0] : []),
        x.lastSignIn,
      ]),
      totals: [
        ...kinds.map((_, i) => 3 + i),
        3 + kinds.length,
        ...(a.manager ? [4 + kinds.length] : []),
      ],
    },
  ]
  if (d && !d.needsUpdate)
    tables.push({
      title: t('analytics.staff.recordsOf', { name: d.person.name }),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: t('analytics.staff.kind') },
        { label: t('analytics.patient') },
        { label: t('report.cols.file'), under: true },
        { label: t('analytics.staff.what') },
        ...(a.manager ? [{ label: t('report.cols.amount'), kind: 'money' as const }] : []),
      ],
      rows: d.records.map((r) => [
        r.at,
        kindName(r.kind, t),
        r.patientName,
        r.fileNumber,
        r.what,
        ...(a.manager ? [r.amount] : []),
      ]),
    })
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.staff.reportTitle'),
    code: 'STF',
    name: 'who-did-what',
    from: a.from,
    to: a.to,
    figures: [
      { label: t('analytics.staff.peopleActive'), value: a.summary.peopleActive },
      { label: t('analytics.kinds.patientsSeen'), value: a.summary.patientsSeen },
      { label: t('analytics.staff.records'), value: a.summary.records },
      ...(a.summary.collected != null
        ? [{ label: t('report.cols.collected'), value: a.summary.collected, unit: 'RWF' }]
        : []),
    ],
    summary:
      t('analytics.staff.summary', {
        people: a.summary.peopleActive,
        seen: formatNumber(a.summary.patientsSeen),
        records: formatNumber(a.summary.records),
      }) +
      (a.summary.collected != null
        ? ` ${t('analytics.staff.summaryMoney', { amount: formatRwf(a.summary.collected) })}`
        : ''),
    sections: [{ name: t('analytics.staff.reportTitle'), tables }],
  })
}
