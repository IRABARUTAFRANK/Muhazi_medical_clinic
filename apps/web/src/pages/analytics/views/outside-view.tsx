import { CircleSlash, Store, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { useBoughtOutside, type BoughtOutside } from '@/lib/api/stock'
import type { ReportTable } from '@/lib/report'
import { num, when, type TFn } from '../format'
import { DataTable, Figures, LoadError, Quiet, useExport, ViewSkeleton } from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'
import { tx } from '../words'

/**
 * Prescribed but bought outside (0100, 0102): what the patients had to buy at an outside
 * pharmacy in the period, most asked first, to help decide what to order.
 */
export function OutsideView({ period, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useBoughtOutside(p.from, p.to)
  const rows = q.data

  useExport(() => (rows ? outsideReport(rows, p, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!rows) return <ViewSkeleton />

  const lines = rows.reduce((s, x) => s + x.times, 0)
  const patients = rows.reduce((s, x) => s + x.patients, 0)
  const notGiven = rows.reduce((s, x) => s + x.notGiven, 0)
  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Store}
          tint="teal"
          label={tx(t, 'outside.lines', 'Lines bought outside')}
          value={lines}
          unit={period.label}
        />
        <Kpi
          i={1}
          icon={Users}
          tint="mint"
          label={tx(t, 'outside.patients', 'Patients')}
          value={patients}
          unit={period.label}
        />
        <Kpi
          i={2}
          icon={CircleSlash}
          tint="coral"
          label={tx(t, 'outside.afterNotGiven', 'After "not given"')}
          value={notGiven}
          unit={period.label}
        />
        <Kpi
          i={3}
          icon={Store}
          tint="amber"
          label={tx(t, 'outside.medicines', 'Medicines')}
          value={rows.length}
          unit={period.label}
        />
      </Figures>
      <Hint>
        {tx(
          t,
          'outside.note',
          'Medicines prescribed here that the patient had to buy elsewhere: the ones to consider ordering.',
        )}
      </Hint>
      <Panel
        i={1}
        icon={Store}
        tint="teal"
        title={tx(t, 'analytics.views.outside', 'Bought outside')}
        right={num(rows.length)}
      >
        <DataTable<BoughtOutside>
          rows={rows}
          rowKey={(r) => `${r.itemId ?? ''}-${r.referenceCode ?? ''}-${r.name}`}
          cols={[
            {
              key: 'name',
              label: t('stock.cols.item'),
              cell: (r) => (
                <span className="block">
                  <b>{r.name}</b>
                  <span className="text-ink-3 block text-[12px]">
                    {r.inClinic
                      ? tx(t, 'outside.inClinic', 'A medicine of the clinic')
                      : tx(t, 'outside.notHeld', 'Not held by the clinic')}
                    {r.referenceCode ? ` · ${r.referenceCode}` : ''}
                  </span>
                </span>
              ),
              sort: (r) => r.name,
            },
            {
              key: 'times',
              label: tx(t, 'outside.times', 'Times'),
              align: 'right',
              cell: (r) => num(r.times),
              sort: (r) => r.times,
              total: num(lines),
            },
            {
              key: 'quantity',
              label: tx(t, 'outside.units', 'Units'),
              align: 'right',
              wide: true,
              cell: (r) => num(r.quantity),
              sort: (r) => r.quantity,
            },
            {
              key: 'patients',
              label: tx(t, 'outside.patients', 'Patients'),
              align: 'right',
              cell: (r) => num(r.patients),
              sort: (r) => r.patients,
              total: num(patients),
            },
            {
              key: 'notGiven',
              label: tx(t, 'outside.afterNotGiven', 'After "not given"'),
              align: 'right',
              wide: true,
              cell: (r) => num(r.notGiven),
              sort: (r) => r.notGiven,
            },
            {
              key: 'last',
              label: tx(t, 'outside.last', 'Last'),
              wide: true,
              cell: (r) => <span className="whitespace-nowrap">{when(r.lastAt)}</span>,
              sort: (r) => r.lastAt,
            },
          ]}
          initialSort={{ key: 'times', desc: true }}
          totalsLabel={t('report.total')}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={tx(t, 'analytics.views.outside', 'Bought outside')}
        />
      </Panel>
    </>
  )
}

function outsideReport(
  rows: BoughtOutside[],
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const tables: ReportTable[] = [
    {
      title: tx(t, 'analytics.views.outside', 'Bought outside'),
      columns: [
        { label: t('stock.cols.item') },
        { label: tx(t, 'outside.inClinic', 'A medicine of the clinic') },
        { label: tx(t, 'outside.times', 'Times'), kind: 'number' },
        { label: tx(t, 'outside.units', 'Units'), kind: 'number' },
        { label: tx(t, 'outside.patients', 'Patients'), kind: 'number' },
        { label: tx(t, 'outside.afterNotGiven', 'After "not given"'), kind: 'number' },
        { label: tx(t, 'outside.last', 'Last'), kind: 'datetime' },
      ],
      rows: rows.map((r) => [
        r.name,
        r.inClinic
          ? t('common.yes', { defaultValue: 'Yes' })
          : t('common.no', { defaultValue: 'No' }),
        r.times,
        r.quantity,
        r.patients,
        r.notGiven,
        r.lastAt,
      ]),
      totals: [2, 3, 4, 5],
    },
  ]
  return analyticsReport({
    t,
    clinic: clinic ?? CLINIC_PROFILE,
    title: tx(t, 'analytics.views.outside', 'Bought outside'),
    code: 'OUT',
    name: 'bought-outside',
    from: p.from,
    to: p.to,
    figures: [
      {
        label: tx(t, 'outside.lines', 'Lines bought outside'),
        value: rows.reduce((s, x) => s + x.times, 0),
      },
      {
        label: tx(t, 'outside.patients', 'Patients'),
        value: rows.reduce((s, x) => s + x.patients, 0),
      },
    ],
    sections: [{ name: tx(t, 'analytics.groups.pharmacy', 'Pharmacy'), tables }],
  })
}
