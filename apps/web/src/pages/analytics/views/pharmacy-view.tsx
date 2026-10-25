import { CircleSlash, Coins, ListOrdered, Pill, Tablets, TrendingUp, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Kpi, Panel } from '@/components/dash/kit'
import {
  usePharmacySummary,
  useStockSales,
  type PharmacySummary,
  type StockSales,
} from '@/lib/api/stock'
import { PickBars } from '../charts'
import { num, pct, when, type TFn } from '../format'
import {
  Choice,
  DataTable,
  Figures,
  LoadError,
  Quiet,
  useExport,
  ViewSkeleton,
  type Col,
} from '../kit'
import { analyticsReport } from '../reports'
import { pickBy, type ViewProps } from '../view-props'

const PHARMACY_BY = ['items', 'notGiven'] as const
type PharmacyBy = (typeof PHARMACY_BY)[number]

type SoldItem = StockSales['items'][number]
type NotGiven = PharmacySummary['notGiven'][number]

/**
 * The pharmacy in the period: medicines given and not given, the most given, and what was sold
 * per medicine (quantity; revenue, cost and margin for the manager only).
 */
export function PharmacyView({ access, period, search, update, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = usePharmacySummary(p)
  const sales = useStockSales(p.from, p.to)
  const s = q.data
  const money = access.manager
  const by = pickBy<PharmacyBy>(search.by, PHARMACY_BY, 'items')
  const items = sales.data?.items ?? []
  const revenue = items.reduce((n, x) => n + x.revenue, 0)
  const margin = items.reduce((n, x) => n + x.margin, 0)

  useExport(() => (s ? pharmacyReport(s, items, money, p, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!s) return <ViewSkeleton />

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Tablets}
          tint="teal"
          label={t('analytics.pharmacy.given')}
          value={Number(s.dispensedToday)}
          unit=""
        />
        <Kpi
          i={1}
          icon={CircleSlash}
          tint="coral"
          label={t('analytics.pharmacy.notGiven')}
          value={Number(s.notGivenToday)}
          unit=""
        />
        {money ? (
          <>
            <Kpi
              i={2}
              icon={Coins}
              tint="violet"
              label={t('analytics.pharmacy.sales')}
              value={Number(s.salesToday)}
              unit="RWF"
            />
            <Kpi
              i={3}
              icon={TrendingUp}
              tint="mint"
              label={t('analytics.pharmacy.margin')}
              value={margin}
              unit="RWF"
              delta={revenue > 0 ? { text: pct(margin, revenue), good: null, up: null } : undefined}
            />
          </>
        ) : (
          <>
            <Kpi
              i={2}
              icon={Users}
              tint="violet"
              label={t('analytics.pharmacy.patientsServed')}
              value={Number(s.patientsServedToday)}
              unit=""
            />
            <Kpi
              i={3}
              icon={Pill}
              tint="mint"
              label={t('analytics.pharmacy.unitsSold')}
              value={items.reduce((n, x) => n + x.units, 0)}
              unit=""
            />
          </>
        )}
      </Figures>

      <Panel i={1} icon={ListOrdered} tint="teal" title={t('analytics.pharmacy.mostGiven')}>
        {s.topToday.length === 0 ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <PickBars
            rows={s.topToday.slice(0, 15).map((x) => ({
              key: x.item,
              label: x.item,
              value: Number(x.count),
            }))}
          />
        )}
      </Panel>

      <Panel
        i={2}
        icon={Pill}
        tint="violet"
        title={t(`analytics.pharmacy.by.${by}`)}
        right={
          <Choice<PharmacyBy>
            label={t('analytics.breakdown')}
            value={by}
            onChange={(v) => update({ by: v === 'items' ? undefined : v }, { replace: true })}
            options={PHARMACY_BY.map((v) => ({ value: v, label: t(`analytics.pharmacy.by.${v}`) }))}
          />
        }
      >
        {by === 'notGiven' ? (
          <NotGivenTable rows={s.notGiven} />
        ) : sales.error ? (
          <LoadError error={sales.error} />
        ) : (
          <SalesTable items={items} money={money} />
        )}
      </Panel>
    </>
  )
}

function SalesTable({ items, money }: { items: SoldItem[]; money: boolean }) {
  const { t } = useTranslation()
  const sum = (f: (x: SoldItem) => number) => items.reduce((n, x) => n + f(x), 0)
  const cols: Col<SoldItem>[] = [
    {
      key: 'item',
      label: t('analytics.pharmacy.item'),
      cell: (x) => <span className="font-semibold [overflow-wrap:anywhere]">{x.item}</span>,
      sort: (x) => x.item,
    },
    {
      key: 'units',
      label: t('analytics.pharmacy.units'),
      align: 'right',
      cell: (x) => num(x.units),
      sort: (x) => x.units,
      total: num(sum((x) => x.units)),
    },
    ...(money
      ? ([
          {
            key: 'revenue',
            label: t('analytics.amountRwf'),
            align: 'right',
            cell: (x) => num(x.revenue),
            sort: (x) => x.revenue,
            total: num(sum((x) => x.revenue)),
          },
          {
            key: 'cost',
            label: t('analytics.pharmacy.cost'),
            align: 'right',
            wide: true,
            cell: (x) => num(x.cost),
            sort: (x) => x.cost,
            total: num(sum((x) => x.cost)),
          },
          {
            key: 'margin',
            label: t('analytics.pharmacy.margin'),
            align: 'right',
            wide: true,
            cell: (x) => num(x.margin),
            sort: (x) => x.margin,
            total: num(sum((x) => x.margin)),
          },
        ] satisfies Col<SoldItem>[])
      : []),
  ]
  return (
    <DataTable
      rows={items}
      cols={cols}
      rowKey={(x) => x.item}
      initialSort={{ key: money ? 'revenue' : 'units', desc: true }}
      totalsLabel={t('report.total')}
      empty={<Quiet>{t('analytics.pharmacy.noSales')}</Quiet>}
      caption={t('analytics.pharmacy.by.items')}
    />
  )
}

function NotGivenTable({ rows }: { rows: NotGiven[] }) {
  const { t } = useTranslation()
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => `${r.at}-${r.item}-${r.patient}`}
      cols={[
        {
          key: 'item',
          label: t('analytics.pharmacy.item'),
          cell: (r) => <b className="[overflow-wrap:anywhere]">{r.item}</b>,
          sort: (r) => r.item,
        },
        {
          key: 'patient',
          label: t('analytics.patient'),
          cell: (r) => r.patient,
          sort: (r) => r.patient,
        },
        { key: 'reason', label: t('analytics.reason'), cell: (r) => r.reason ?? '—' },
        {
          key: 'at',
          label: t('report.cols.dateTime'),
          wide: true,
          cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
          sort: (r) => r.at,
        },
      ]}
      initialSort={{ key: 'at', desc: true }}
      empty={<Quiet>{t('analytics.pharmacy.allGiven')}</Quiet>}
      caption={t('analytics.pharmacy.by.notGiven')}
    />
  )
}

function pharmacyReport(
  s: PharmacySummary,
  items: SoldItem[],
  money: boolean,
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.pharmacy.reportTitle'),
    code: 'PHA',
    name: 'pharmacy',
    from: p.from,
    to: p.to,
    figures: [
      { label: t('analytics.pharmacy.given'), value: Number(s.dispensedToday) },
      { label: t('analytics.pharmacy.notGiven'), value: Number(s.notGivenToday) },
      ...(money
        ? [{ label: t('analytics.pharmacy.sales'), value: Number(s.salesToday), unit: 'RWF' }]
        : []),
    ],
    summary: money
      ? t('analytics.pharmacy.salesNote', { amount: formatRwf(Number(s.salesToday)) })
      : undefined,
    sections: [
      {
        name: t('analytics.pharmacy.reportTitle'),
        tables: [
          {
            title: t('analytics.pharmacy.by.items'),
            columns: [
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.pharmacy.units'), kind: 'number' },
              ...(money
                ? [
                    { label: t('report.cols.amount'), kind: 'money' as const },
                    { label: t('analytics.pharmacy.cost'), kind: 'money' as const },
                    { label: t('analytics.pharmacy.margin'), kind: 'money' as const },
                  ]
                : []),
            ],
            rows: items.map((x) => [
              x.item,
              x.units,
              ...(money ? [x.revenue, x.cost, x.margin] : []),
            ]),
            totals: money ? [1, 2, 3, 4] : [1],
          },
          {
            title: t('analytics.pharmacy.mostGiven'),
            columns: [
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.pharmacy.units'), kind: 'number' },
            ],
            rows: s.topToday.map((x) => [x.item, Number(x.count)]),
          },
          {
            title: t('analytics.pharmacy.by.notGiven'),
            columns: [
              { label: t('report.cols.dateTime'), kind: 'datetime' },
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.patient') },
              { label: t('analytics.reason') },
            ],
            rows: s.notGiven.map((r) => [r.at, r.item, r.patient, r.reason]),
          },
        ],
      },
    ],
  })
}
