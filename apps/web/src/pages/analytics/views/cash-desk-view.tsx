import { Banknote, Coins, Receipt, Scale, Undo2, Wallet, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatNumber, formatRwf, isoDate } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { delta } from '@/components/dash/kit-style'
import { StaffLink } from '@/components/staff/staff-link'
import { useCashierSummary, useUnpaidDebts, type CashierSummary } from '@/lib/api/finance'
import { useHomeSummary } from '@/lib/api/home'
import type { ReportTable } from '@/lib/report'
import { bucketsOf, sumBy } from '../buckets'
import { Legend, LINE, OTHER, SERIES, StackedBars, type BarSeries } from '../charts'
import { num, payMethod, pct, short, when, type TFn } from '../format'
import { DataTable, Figures, LoadError, Quiet, useExport, ViewSkeleton } from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'
import { tx } from '../words'

/** Cash, MTN MoMo, Airtel Money in the palette's fixed order; anything else is "Other". */
const METHOD_SERIES = [
  { key: 'cash', color: SERIES[0] },
  { key: 'momo', color: SERIES[1] },
  { key: 'airtel', color: SERIES[2] },
  { key: 'other', color: OTHER },
] as const

/** The local calendar day of a moment (the summary's days are Kigali days, the browser's too). */
const dayOf = (at: string) => isoDate(new Date(at))

/**
 * The cash desk's analytics (0102), from the cashier's own summary (cashier_summary): what came
 * in over the period and how; the payment methods; the open bills and the unpaid ones; the
 * refunds and the payments cancelled. The view open says which of the four is shown:
 * collections, methods, openBills or refunds.
 */
export function CashDeskView({ view, period, update, search, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useCashierSummary(null, p)
  const home = useHomeSummary(null, { enabled: view === 'openBills' })
  const debts = useUnpaidDebts()
  const s = q.data

  useExport(() => (s ? cashDeskReport(view, s, p, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!s) return <ViewSkeleton />

  const refunded = s.refunded ?? 0
  const collected = s.total
  const net = collected - refunded
  const bk = bucketsOf(p.from, p.to)
  const payments = s.payments
  const sum = (m: string) =>
    sumBy(
      bk,
      payments.filter((x) =>
        m === 'other' ? !['cash', 'momo', 'airtel'].includes(x.method) : x.method === m,
      ),
      (x) => dayOf(x.at),
      (x) => x.amount,
    )
  const refundsPerDay = sumBy(
    bk,
    s.refunds ?? [],
    (x) => dayOf(x.at),
    (x) => x.amount,
  )
  const hasOther = payments.some((x) => !['cash', 'momo', 'airtel'].includes(x.method))
  const series: BarSeries[] = METHOD_SERIES.filter((m) => m.key !== 'other' || hasOther).map(
    (m) => ({
      key: m.key,
      label: m.key === 'other' ? t('analytics.revenue.otherMethod') : payMethod(m.key, t),
      color: m.color,
      values: sum(m.key),
    }),
  )
  const netPerDay = bk.keys.map(
    (_, i) => series.reduce((a, x) => a + (x.values[i] ?? 0), 0) - (refundsPerDay[i] ?? 0),
  )
  const selected = search.day && !bk.monthly ? bk.keys.indexOf(search.day) : -1
  const pick = (i: number) => {
    const k = bk.keys[i]
    if (!k) return
    if (bk.monthly) {
      const sp = bk.span(k)
      update({ range: 'custom', from: sp.from, to: sp.to, day: undefined })
    } else update({ day: k === search.day ? undefined : k }, { replace: true })
  }

  if (view === 'methods') {
    const total = s.byMethod.reduce((a, m) => a + m.amount, 0)
    return (
      <>
        <Figures>
          {s.byMethod.slice(0, 4).map((m, i) => (
            <Kpi
              key={m.method}
              i={i}
              icon={Banknote}
              tint={(['mint', 'amber', 'coral', 'navy'] as const)[i] ?? 'teal'}
              label={payMethod(m.method, t)}
              value={m.amount}
              unit={tx(t, 'cashDesk.nPayments', '{{count}} payments', { count: m.count })}
            />
          ))}
        </Figures>
        <Panel
          i={1}
          icon={Banknote}
          tint="mint"
          title={tx(t, 'cashDesk.byMethod', 'Collections by payment method')}
          right={formatRwf(total)}
        >
          <DataTable
            rows={s.byMethod}
            rowKey={(r) => r.method}
            cols={[
              {
                key: 'method',
                label: t('report.cols.method'),
                cell: (r) => <b>{payMethod(r.method, t)}</b>,
              },
              {
                key: 'count',
                label: t('report.cols.count'),
                align: 'right',
                cell: (r) => num(r.count),
                sort: (r) => r.count,
              },
              {
                key: 'amount',
                label: t('report.cols.amount'),
                align: 'right',
                cell: (r) => num(r.amount),
                sort: (r) => r.amount,
                total: num(total),
              },
              {
                key: 'share',
                label: t('analytics.share'),
                align: 'right',
                cell: (r) => pct(r.amount, total),
                sort: (r) => r.amount,
              },
            ]}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={tx(t, 'cashDesk.byMethod', 'Collections by payment method')}
          />
        </Panel>
        <Panel
          i={2}
          icon={Coins}
          tint="violet"
          title={tx(t, 'cashDesk.byDay', 'Collections by day')}
        >
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={series}
            format={formatRwf}
            tick={short}
            onPick={pick}
            selected={selected >= 0 ? selected : null}
            ariaLabel={tx(t, 'cashDesk.chartAria', 'Collections by day, {{period}}', {
              period: period.label,
            })}
          />
          <Legend items={series} />
        </Panel>
      </>
    )
  }

  if (view === 'openBills') {
    const bills = home.data?.openBills ?? []
    const owed = debts.data ?? []
    const open = new Set(owed.filter((d) => d.status === 'open').map((d) => d.encounterId))
    const today = bills.filter((b) => !open.has(b.encounterId))
    const due = today.reduce((a, b) => a + b.balance, 0)
    const owedTotal = owed.reduce((a, d) => a + d.amount, 0)
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={Receipt}
            tint="navy"
            label={t('finance.tiles.openBills')}
            value={today.length}
            unit={formatRwf(due)}
          />
          <Kpi
            i={1}
            icon={Wallet}
            tint="coral"
            label={t('dashboard.tiles.debts')}
            value={owed.length}
            unit={formatRwf(owedTotal)}
          />
          <Kpi
            i={2}
            icon={Coins}
            tint="violet"
            label={t('report.fig.collected')}
            value={collected}
            unit={period.label}
          />
        </Figures>
        <Hint>{tx(t, 'cashDesk.openNote', 'Open bills are of now, not of the period.')}</Hint>
        <Panel
          i={1}
          icon={Receipt}
          tint="navy"
          title={t('finance.tiles.openBills')}
          right={formatRwf(due)}
        >
          <DataTable
            rows={today}
            rowKey={(r) => r.encounterId}
            cols={[
              {
                key: 'patient',
                label: t('finance.cols.patient'),
                cell: (r) => (
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: r.encounterId }}
                    className="text-primary font-semibold [overflow-wrap:anywhere]"
                  >
                    {r.name}
                  </StaffLink>
                ),
                sort: (r) => r.name,
              },
              { key: 'file', label: t('report.cols.file'), wide: true, cell: (r) => r.file },
              {
                key: 'station',
                label: t('analytics.department'),
                wide: true,
                cell: (r) =>
                  r.station
                    ? t(`register.stations.${r.station}`, { defaultValue: r.station })
                    : '—',
              },
              {
                key: 'amount',
                label: t('report.cols.amount'),
                align: 'right',
                cell: (r) => num(r.amount),
                sort: (r) => r.amount,
              },
              {
                key: 'balance',
                label: t('report.fig.outstanding'),
                align: 'right',
                cell: (r) => <b>{num(r.balance)}</b>,
                sort: (r) => r.balance,
                total: num(due),
              },
            ]}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('finance.nothingYet')}</Quiet>}
            caption={t('finance.tiles.openBills')}
          />
        </Panel>
        <Panel
          i={2}
          icon={Wallet}
          tint="coral"
          title={t('dashboard.tiles.debts')}
          right={formatRwf(owedTotal)}
        >
          <DataTable
            rows={owed}
            rowKey={(r) => r.encounterId}
            cols={[
              {
                key: 'patient',
                label: t('finance.cols.patient'),
                cell: (r) => (
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: r.encounterId }}
                    className="text-primary font-semibold [overflow-wrap:anywhere]"
                  >
                    {r.patient}
                  </StaffLink>
                ),
                sort: (r) => r.patient,
              },
              { key: 'file', label: t('report.cols.file'), wide: true, cell: (r) => r.fileNumber },
              {
                key: 'since',
                label: t('report.cols.dateTime'),
                wide: true,
                cell: (r) => (
                  <span className="whitespace-nowrap">{when(r.closedAt ?? r.since ?? null)}</span>
                ),
                sort: (r) => r.closedAt ?? r.since ?? null,
              },
              {
                key: 'reason',
                label: t('analytics.reason'),
                wide: true,
                cell: (r) => r.reason ?? '—',
              },
              {
                key: 'amount',
                label: t('report.fig.outstanding'),
                align: 'right',
                cell: (r) => <b>{num(r.amount)}</b>,
                sort: (r) => r.amount,
                total: num(owedTotal),
              },
            ]}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('finance.nothingYet')}</Quiet>}
            caption={t('dashboard.tiles.debts')}
          />
        </Panel>
      </>
    )
  }

  if (view === 'refunds') {
    const refunds = s.refunds ?? []
    const voided = s.voided ?? []
    const voidedTotal = voided.reduce((a, v) => a + v.amount, 0)
    return (
      <>
        <Figures>
          <Kpi
            i={0}
            icon={Undo2}
            tint="coral"
            label={t('analytics.revenue.refunded')}
            value={refunded}
            unit={tx(t, 'cashDesk.nRefunds', '{{count}} refunds', { count: refunds.length })}
          />
          <Kpi
            i={1}
            icon={XCircle}
            tint="amber"
            label={t('analytics.kinds.voided')}
            value={voidedTotal}
            unit={tx(t, 'cashDesk.nPayments', '{{count}} payments', { count: voided.length })}
          />
          <Kpi
            i={2}
            icon={Scale}
            tint="mint"
            label={t('analytics.revenue.net')}
            value={net}
            unit="RWF"
          />
        </Figures>
        <Panel
          i={1}
          icon={Undo2}
          tint="coral"
          title={t('report.t.refunds')}
          right={formatRwf(refunded)}
        >
          <DataTable
            rows={refunds}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'at',
                label: t('report.cols.dateTime'),
                cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
                sort: (r) => r.at,
              },
              {
                key: 'patient',
                label: t('finance.cols.patient'),
                cell: (r) => <b>{r.patient}</b>,
                sort: (r) => r.patient,
              },
              {
                key: 'method',
                label: t('report.cols.method'),
                wide: true,
                cell: (r) => payMethod(r.method, t),
              },
              { key: 'reason', label: t('analytics.reason'), cell: (r) => r.reason },
              {
                key: 'cashier',
                label: t('report.cols.cashier'),
                wide: true,
                cell: (r) => r.cashier ?? '—',
              },
              {
                key: 'amount',
                label: t('report.cols.amount'),
                align: 'right',
                cell: (r) => num(r.amount),
                sort: (r) => r.amount,
                total: num(refunded),
              },
            ]}
            initialSort={{ key: 'at', desc: true }}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('report.t.refunds')}
          />
        </Panel>
        <Panel
          i={2}
          icon={XCircle}
          tint="amber"
          title={t('analytics.kinds.voided')}
          right={formatRwf(voidedTotal)}
        >
          <DataTable
            rows={voided}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'at',
                label: t('report.cols.dateTime'),
                cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
                sort: (r) => r.at,
              },
              {
                key: 'patient',
                label: t('finance.cols.patient'),
                cell: (r) => <b>{r.patient}</b>,
                sort: (r) => r.patient,
              },
              {
                key: 'method',
                label: t('report.cols.method'),
                wide: true,
                cell: (r) => payMethod(r.method, t),
              },
              { key: 'reason', label: t('analytics.reason'), cell: (r) => r.reason ?? '—' },
              {
                key: 'amount',
                label: t('report.cols.amount'),
                align: 'right',
                cell: (r) => num(r.amount),
                sort: (r) => r.amount,
                total: num(voidedTotal),
              },
            ]}
            initialSort={{ key: 'at', desc: true }}
            totalsLabel={t('report.total')}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('analytics.kinds.voided')}
          />
        </Panel>
      </>
    )
  }

  // collections
  const lines = [{ label: t('analytics.revenue.net'), color: LINE, values: netPerDay }]
  const dayRows = bk.keys.map((k, i) => ({
    key: k,
    label: bk.long[i]!,
    cash: series.find((x) => x.key === 'cash')?.values[i] ?? 0,
    momo: series.find((x) => x.key === 'momo')?.values[i] ?? 0,
    airtel: series.find((x) => x.key === 'airtel')?.values[i] ?? 0,
    refunds: refundsPerDay[i] ?? 0,
    net: netPerDay[i] ?? 0,
    payments: payments.filter((x) => bk.of(dayOf(x.at)) === k).length,
  }))
  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Coins}
          tint="violet"
          label={t('analytics.revenue.collected')}
          value={collected}
          unit="RWF"
          delta={delta(collected, s.previousTotal, true, t)}
        />
        <Kpi
          i={1}
          icon={Receipt}
          tint="teal"
          label={t('finance.payments')}
          value={s.count}
          unit={period.label}
        />
        <Kpi
          i={2}
          icon={Undo2}
          tint="coral"
          label={t('analytics.revenue.refunded')}
          value={refunded}
          unit="RWF"
        />
        <Kpi
          i={3}
          icon={Scale}
          tint="mint"
          label={t('analytics.revenue.net')}
          value={net}
          unit="RWF"
        />
      </Figures>
      <Hint>
        {tx(t, 'cashDesk.figuresNote', 'Every payment taken in the period, before refunds.')}
        {s.scope === 'mine' && ` ${tx(t, 'receipts.mineNote', 'The receipts you gave.')}`}
      </Hint>
      <Panel
        i={1}
        icon={Coins}
        tint="violet"
        title={tx(t, 'cashDesk.byDay', 'Collections by day')}
        right={formatRwf(collected)}
      >
        <StackedBars
          labels={bk.long}
          tickLabels={bk.short}
          series={series}
          lines={lines}
          format={formatRwf}
          tick={short}
          onPick={pick}
          selected={selected >= 0 ? selected : null}
          ariaLabel={tx(t, 'cashDesk.chartAria', 'Collections by day, {{period}}', {
            period: period.label,
          })}
        />
        <Legend items={[...series, { label: lines[0]!.label, color: LINE, line: true }]} />
      </Panel>
      <Panel i={2} icon={Banknote} tint="mint" title={tx(t, 'cashDesk.dayTable', 'Day by day')}>
        <DataTable
          rows={dayRows}
          rowKey={(r) => r.key}
          cols={[
            { key: 'day', label: t('report.cols.day'), cell: (r) => <b>{r.label}</b> },
            {
              key: 'payments',
              label: t('finance.payments'),
              align: 'right',
              cell: (r) => num(r.payments),
              sort: (r) => r.payments,
              total: num(s.count),
            },
            {
              key: 'cash',
              label: payMethod('cash', t),
              align: 'right',
              wide: true,
              cell: (r) => num(r.cash),
              sort: (r) => r.cash,
            },
            {
              key: 'momo',
              label: payMethod('momo', t),
              align: 'right',
              wide: true,
              cell: (r) => num(r.momo),
              sort: (r) => r.momo,
            },
            {
              key: 'airtel',
              label: payMethod('airtel', t),
              align: 'right',
              wide: true,
              cell: (r) => num(r.airtel),
              sort: (r) => r.airtel,
            },
            {
              key: 'refunds',
              label: t('analytics.revenue.refunded'),
              align: 'right',
              wide: true,
              cell: (r) => num(r.refunds),
              sort: (r) => r.refunds,
            },
            {
              key: 'net',
              label: t('analytics.revenue.net'),
              align: 'right',
              cell: (r) => <b>{num(r.net)}</b>,
              sort: (r) => r.net,
              total: num(net),
            },
          ]}
          totalsLabel={t('report.total')}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={tx(t, 'cashDesk.dayTable', 'Day by day')}
        />
      </Panel>
    </>
  )
}

function cashDeskReport(
  view: ViewProps['view'],
  s: CashierSummary,
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const method = (m: string) => payMethod(m, t)
  const refunded = s.refunded ?? 0
  const tables: ReportTable[] = [
    {
      title: t('report.t.collections'),
      columns: [
        { label: t('report.cols.method') },
        { label: t('report.cols.count'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: s.byMethod.map((x) => [method(x.method), x.count, x.amount]),
      totals: [1, 2],
    },
    {
      title: t('finance.payments'),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: t('finance.cols.patient') },
        { label: t('report.cols.file'), under: true },
        { label: t('report.cols.method'), nowrap: true },
        { label: t('report.cols.reference') },
        { label: t('report.cols.receiptNo') },
        { label: t('report.cols.cashier'), nowrap: true },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: s.payments.map((x) => [
        x.at,
        x.patient,
        x.fileNumber,
        method(x.method),
        x.reference,
        x.receipt,
        x.cashier,
        x.amount,
      ]),
      totals: [7],
    },
    {
      title: t('report.t.refunds'),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: t('finance.cols.patient') },
        { label: t('report.cols.method') },
        { label: t('report.cols.reason') },
        { label: t('report.cols.cashier') },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: (s.refunds ?? []).map((r) => [
        r.at,
        r.patient,
        method(r.method),
        r.reason,
        r.cashier,
        r.amount,
      ]),
      totals: [5],
    },
  ]
  const titles: Record<string, string> = {
    collections: tx(t, 'analytics.views.collections', 'Collections'),
    methods: tx(t, 'analytics.views.methods', 'Payment methods'),
    openBills: tx(t, 'analytics.views.openBills', 'Open bills'),
    refunds: tx(t, 'analytics.views.refunds', 'Refunds'),
  }
  return analyticsReport({
    t,
    clinic: clinic ?? CLINIC_PROFILE,
    title: titles[view] ?? titles.collections!,
    code: 'CSH',
    name: 'cash-desk',
    from: p.from,
    to: p.to,
    figures: [
      { label: t('report.fig.collected'), value: s.total, unit: 'RWF' },
      { label: t('finance.payments'), value: s.count },
      { label: t('report.fig.refunded'), value: refunded, unit: 'RWF' },
      { label: t('report.fig.openBills'), value: s.openBills },
      { label: t('report.fig.outstanding'), value: s.openDue, unit: 'RWF' },
    ],
    summary: t('report.summary.collected', { count: s.count, amount: formatNumber(s.total) }),
    sections: [{ name: tx(t, 'analytics.groups.money', 'Money'), tables }],
  })
}
