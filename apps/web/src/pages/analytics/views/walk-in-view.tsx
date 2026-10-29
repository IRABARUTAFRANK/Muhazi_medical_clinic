import { Coins, PackageCheck, ShoppingCart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatRwf } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { useCounterSales, type CounterSale } from '@/lib/api/counter-sales'
import type { ReportTable } from '@/lib/report'
import { num, payMethod, when, type TFn } from '../format'
import { DataTable, Figures, LoadError, Quiet, useExport, ViewSkeleton, type Col } from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'
import { tx } from '../words'

/**
 * Walk-in sales of the period (0102): the counter sales handed over (paid at the cash desk,
 * collected at the pharmacy), those paid and still to hand over, their total and their lines.
 */
export function WalkInView({ period, access, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const handed = useCounterSales('handed_over', p)
  const paid = useCounterSales('paid', p)
  const money = access.manager || access.dashboard === 'pharmacy' || access.dashboard === 'cashier'

  useExport(() => (handed.data ? walkInReport(handed.data, p, t, clinic) : null))

  if (handed.error) return <LoadError error={handed.error} />
  if (!handed.data) return <ViewSkeleton />

  const sales = handed.data
  const total = sales.reduce((s, x) => s + x.total, 0)
  const toHand = paid.data ?? []
  const buyers = new Set(sales.map((x) => x.buyer?.trim() || x.phone || x.id)).size
  const cols: Col<CounterSale>[] = [
    {
      key: 'number',
      label: tx(t, 'walkIn.saleNo', 'Sale no.'),
      cell: (r) => <b className="whitespace-nowrap">{r.number}</b>,
      sort: (r) => r.number,
    },
    {
      key: 'at',
      label: t('report.cols.dateTime'),
      cell: (r) => (
        <span className="whitespace-nowrap">{when(r.handedOverAt ?? r.paidAt ?? r.at)}</span>
      ),
      sort: (r) => r.handedOverAt ?? r.paidAt ?? r.at,
    },
    {
      key: 'buyer',
      label: tx(t, 'walkIn.buyer', 'Buyer'),
      cell: (r) =>
        r.buyer?.trim() || t('cashierDesk.counter.walkIn', { defaultValue: 'Walk-in buyer' }),
      sort: (r) => r.buyer,
    },
    {
      key: 'lines',
      label: tx(t, 'walkIn.items', 'Items'),
      wide: true,
      cell: (r) => r.lines.map((l) => `${l.item} × ${l.quantity}`).join(', '),
    },
    {
      key: 'method',
      label: t('report.cols.method'),
      wide: true,
      cell: (r) => (r.method ? payMethod(r.method, t) : '—'),
    },
    ...(money
      ? [
          {
            key: 'total',
            label: t('report.cols.amount'),
            align: 'right' as const,
            cell: (r: CounterSale) => <b>{num(r.total)}</b>,
            sort: (r: CounterSale) => r.total,
            total: num(total),
          },
        ]
      : []),
  ]
  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={ShoppingCart}
          tint="teal"
          label={tx(t, 'walkIn.handed', 'Sales handed over')}
          value={sales.length}
          unit={period.label}
        />
        {money && (
          <Kpi
            i={1}
            icon={Coins}
            tint="violet"
            label={t('report.fig.collected')}
            value={total}
            unit="RWF"
          />
        )}
        <Kpi
          i={2}
          icon={PackageCheck}
          tint="amber"
          label={tx(t, 'walkIn.toHandOver', 'Paid, to hand over')}
          value={toHand.length}
          unit={t('dashboard.units.now')}
        />
        <Kpi
          i={3}
          icon={ShoppingCart}
          tint="mint"
          label={tx(t, 'walkIn.buyers', 'Buyers')}
          value={buyers}
          unit={period.label}
        />
      </Figures>
      <Hint>
        {tx(
          t,
          'walkIn.note',
          'A walk-in buyer pays at the cash desk first, then collects at the pharmacy.',
        )}
      </Hint>
      <Panel
        i={1}
        icon={ShoppingCart}
        tint="teal"
        title={tx(t, 'walkIn.handed', 'Sales handed over')}
        right={money ? formatRwf(total) : num(sales.length)}
      >
        <DataTable<CounterSale>
          rows={sales}
          rowKey={(r) => r.id}
          cols={cols}
          initialSort={{ key: 'at', desc: true }}
          totalsLabel={money ? t('report.total') : undefined}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={tx(t, 'walkIn.handed', 'Sales handed over')}
        />
      </Panel>
      {toHand.length > 0 && (
        <Panel
          i={2}
          icon={PackageCheck}
          tint="amber"
          title={tx(t, 'walkIn.toHandOver', 'Paid, to hand over')}
          right={num(toHand.length)}
        >
          <DataTable<CounterSale>
            rows={toHand}
            rowKey={(r) => r.id}
            cols={cols.filter((c) => c.key !== 'at')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={tx(t, 'walkIn.toHandOver', 'Paid, to hand over')}
          />
        </Panel>
      )}
    </>
  )
}

function walkInReport(
  sales: CounterSale[],
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const total = sales.reduce((s, x) => s + x.total, 0)
  const tables: ReportTable[] = [
    {
      title: tx(t, 'walkIn.handed', 'Sales handed over'),
      columns: [
        { label: tx(t, 'walkIn.saleNo', 'Sale no.'), nowrap: true },
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: tx(t, 'walkIn.buyer', 'Buyer') },
        { label: tx(t, 'walkIn.items', 'Items') },
        { label: t('report.cols.method'), nowrap: true },
        { label: t('report.cols.cashier'), nowrap: true },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: sales.map((r) => [
        r.number,
        r.handedOverAt ?? r.paidAt ?? r.at,
        r.buyer,
        r.lines.map((l) => `${l.item} × ${l.quantity}`).join(', '),
        r.method ? payMethod(r.method, t) : null,
        r.cashier,
        r.total,
      ]),
      totals: [6],
    },
  ]
  return analyticsReport({
    t,
    clinic: clinic ?? CLINIC_PROFILE,
    title: tx(t, 'analytics.views.walkIn', 'Walk-in sales'),
    code: 'WLK',
    name: 'walk-in-sales',
    from: p.from,
    to: p.to,
    figures: [
      { label: tx(t, 'walkIn.handed', 'Sales handed over'), value: sales.length },
      { label: t('report.fig.collected'), value: total, unit: 'RWF' },
    ],
    sections: [{ name: tx(t, 'analytics.groups.pharmacy', 'Pharmacy'), tables }],
  })
}
