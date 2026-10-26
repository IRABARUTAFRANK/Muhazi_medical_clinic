import { useState, type ReactNode } from 'react'
import { Banknote, ChartColumn, Coins, ReceiptText, Scale, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FEATURES, formatNumber, formatRwf } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { delta } from '@/components/dash/kit-style'
import { StaffLink } from '@/components/staff/staff-link'
import { buttonVariants } from '@/components/ui/button'
import {
  previousPeriod,
  useRevenueAnalysis,
  type RevenueAnalysis,
  type RevenueDay,
} from '@/lib/api/analytics'
import { categoryName } from '@/lib/api/catalogue'
import type { ReportTable } from '@/lib/report'
import { cn } from '@/lib/utils'
import { Legend, LINE, OTHER, SERIES, StackedBars, type BarSeries } from '../charts'
import { dayLong, num, payMethod, pct, short, when, type TFn } from '../format'
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
import { bucketsOf, sumBy } from '../buckets'
import { analyticsReport } from '../reports'
import { pickBy, type ViewProps } from '../view-props'
import { RevenueDayDrawer } from './revenue-day'

/** The breakdowns under the chart, one at a time (`by=`); "days" is the day table. */
export const REVENUE_BY = [
  'days',
  'method',
  'source',
  'service',
  'department',
  'payer',
  'cashier',
  'discounts',
  'refunds',
  'debts',
] as const
type RevenueBy = (typeof REVENUE_BY)[number]

/** Cash, MTN MoMo, Airtel Money in the palette's fixed order; anything else is "Other". */
const METHOD_SERIES = [
  { key: 'cash', color: SERIES[0] },
  { key: 'momo', color: SERIES[1] },
  { key: 'airtel', color: SERIES[2] },
  { key: 'other', color: OTHER },
] as const

/** Revenue by day, in detail: the manager only (money). */
export function RevenueView({ period, search, update, clinic }: ViewProps) {
  const { t, i18n } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useRevenueAnalysis(p)
  const [compare, setCompare] = useState(false)
  const prev = useRevenueAnalysis(previousPeriod(p), compare)
  const by = pickBy<RevenueBy>(search.by, REVENUE_BY, 'days')
  const d = q.data

  useExport(() => (d && !d.needsUpdate ? revenueReport(d, by, t, i18n.language, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!d) return <ViewSkeleton />
  if (d.needsUpdate) return <NeedsUpdate />

  const T = d.totals
  const P = d.prev
  const days = d.days
  const bk = bucketsOf(d.from || p.from, d.to || p.to)
  const sum = (k: 'cash' | 'momo' | 'airtel' | 'other' | 'net') =>
    sumBy(
      bk,
      days,
      (x) => x.day,
      (x) => x[k],
    )
  const hasOther = days.some((x) => x.other > 0)
  const series: BarSeries[] = METHOD_SERIES.filter((m) => m.key !== 'other' || hasOther).map(
    (m) => ({
      key: m.key,
      label: m.key === 'other' ? t('analytics.revenue.otherMethod') : payMethod(m.key, t),
      color: m.color,
      values: sum(m.key),
    }),
  )
  // the period before, bucket by bucket (same length, so the same number of bars)
  const before = previousPeriod(p)
  const prevBk = bucketsOf(d.prevFrom || before.from, d.prevTo || before.to)
  const prevNet =
    compare && prev.data && !prev.data.needsUpdate
      ? sumBy(
          prevBk,
          prev.data.days,
          (x) => x.day,
          (x) => x.net,
        )
      : null
  const lines = [
    { label: t('analytics.revenue.net'), color: LINE, values: sum('net') },
    ...(prevNet
      ? [
          {
            label: t('analytics.revenue.prevNet'),
            color: OTHER,
            dashed: true,
            values: bk.keys.map((_, i) => prevNet[i] ?? null),
          },
        ]
      : []),
  ]
  const openDay = (day: string) => update({ day })
  // a month bar (a long period) narrows the period to that month; a day bar opens the day
  const pick = (i: number) => {
    const k = bk.keys[i]
    if (!k) return
    if (bk.monthly) {
      const sp = bk.span(k)
      update({ range: 'custom', from: sp.from, to: sp.to, day: undefined })
    } else openDay(k)
  }
  const selected = search.day && !bk.monthly ? bk.keys.indexOf(search.day) : -1

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Coins}
          tint="violet"
          label={t('analytics.revenue.collected')}
          value={T.collected}
          unit="RWF"
          delta={delta(T.collected, P.collected, true, t)}
        />
        <Kpi
          i={1}
          icon={Undo2}
          tint="coral"
          label={t('analytics.revenue.refunded')}
          value={T.refunded}
          unit="RWF"
          delta={delta(T.refunded, P.refunded, false, t)}
        />
        <Kpi
          i={2}
          icon={Scale}
          tint="mint"
          label={t('analytics.revenue.net')}
          value={T.net}
          unit="RWF"
          delta={delta(T.net, P.net, true, t)}
        />
        <Kpi
          i={3}
          icon={ReceiptText}
          tint="teal"
          label={t('analytics.revenue.avgPerVisit')}
          value={T.avgPerVisit ?? 0}
          text={T.avgPerVisit == null ? '—' : undefined}
          unit="RWF"
          delta={
            T.avgPerVisit != null && P.avgPerVisit != null
              ? delta(Math.round(T.avgPerVisit), Math.round(P.avgPerVisit), true, t)
              : undefined
          }
        />
      </Figures>
      <Hint>
        {t('analytics.revenue.figuresNote', {
          payments: formatNumber(T.payments),
          visits: formatNumber(T.paidVisits),
        })}
        {T.voidedCount > 0 &&
          ` ${t('analytics.revenue.voidedNote', { count: T.voidedCount, amount: formatRwf(T.voided) })}`}
      </Hint>

      <Panel
        i={1}
        icon={ChartColumn}
        tint="violet"
        title={t('analytics.revenue.chartTitle')}
        right={
          <label className="text-ink-2 inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
            />
            {t('analytics.revenue.compare')}
          </label>
        }
      >
        <Legend
          items={[
            ...series.map((s) => ({ label: s.label, color: s.color })),
            ...lines.map((l) => ({ label: l.label, color: l.color, line: true, dashed: l.dashed })),
          ]}
        />
        {bk.keys.length === 0 ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={series}
            lines={lines}
            format={formatRwf}
            tick={short}
            onPick={pick}
            selected={selected >= 0 ? selected : null}
            ariaLabel={t('analytics.revenue.chartAria', {
              period: period.label,
              amount: formatRwf(T.collected),
            })}
          />
        )}
        <p className="text-ink-3 m-0 text-[13px]">
          {t(bk.monthly ? 'analytics.chartHintMonth' : 'analytics.revenue.chartHint')}
        </p>
      </Panel>

      <Panel
        i={2}
        icon={Banknote}
        tint="teal"
        title={t('analytics.breakdown')}
        right={
          <Choice<RevenueBy>
            label={t('analytics.breakdown')}
            value={by}
            onChange={(v) => update({ by: v === 'days' ? undefined : v }, { replace: true })}
            options={REVENUE_BY.map((v) => ({ value: v, label: t(`analytics.revenue.by.${v}`) }))}
          />
        }
      >
        <Breakdown d={d} by={by} onDay={openDay} selectedDay={search.day ?? null} />
      </Panel>

      {search.day && (
        <RevenueDayDrawer day={search.day} onClose={() => update({ day: undefined })} />
      )}
    </>
  )
}

/* ---------------------------------------------------------------- breakdowns */

function Breakdown({
  d,
  by,
  onDay,
  selectedDay,
}: {
  d: RevenueAnalysis
  by: RevenueBy
  onDay: (day: string) => void
  selectedDay: string | null
}) {
  const { t, i18n } = useTranslation()
  const T = d.totals
  const empty = <Quiet>{t('analytics.noData')}</Quiet>
  const money = (v: number | null | undefined) => num(v == null ? null : Math.round(v))

  if (by === 'days') {
    const days = [...d.days].reverse()
    const sum = (k: keyof RevenueDay) => days.reduce((s, x) => s + Number(x[k] ?? 0), 0)
    const cols: Col<RevenueDay>[] = [
      { key: 'day', label: t('report.cols.day'), cell: (r) => dayLong(r.day), sort: (r) => r.day },
      {
        key: 'payments',
        label: t('analytics.revenue.payments'),
        align: 'right',
        cell: (r) => num(r.payments),
        sort: (r) => r.payments,
        total: num(sum('payments')),
      },
      ...(['cash', 'momo', 'airtel'] as const).map((m): Col<RevenueDay> => ({
        key: m,
        label: payMethod(m, t),
        align: 'right',
        wide: true,
        cell: (r) => money(r[m]),
        sort: (r) => r[m],
        total: money(sum(m)),
      })),
      {
        key: 'refunds',
        label: t('analytics.revenue.refunds'),
        align: 'right',
        wide: true,
        cell: (r) => money(r.refunds),
        sort: (r) => r.refunds,
        total: money(sum('refunds')),
      },
      {
        key: 'voided',
        label: t('analytics.revenue.voided'),
        align: 'right',
        wide: true,
        cell: (r) => money(r.voided),
        sort: (r) => r.voided,
        total: money(sum('voided')),
      },
      {
        key: 'net',
        label: t('analytics.revenue.net'),
        align: 'right',
        cell: (r) => <b>{money(r.net)}</b>,
        sort: (r) => r.net,
        total: money(sum('net')),
      },
      {
        key: 'visits',
        label: t('analytics.revenue.visitsPaid'),
        align: 'right',
        wide: true,
        cell: (r) => num(r.visits),
        sort: (r) => r.visits,
        total: num(sum('visits')),
      },
    ]
    return (
      <DataTable
        rows={days}
        cols={cols}
        rowKey={(r) => r.day}
        onRow={(r) => onDay(r.day)}
        rowLabel={(r) => t('analytics.revenue.openDay', { day: dayLong(r.day) })}
        totalsLabel={t('report.total')}
        empty={empty}
        caption={t('analytics.revenue.by.days')}
        selectedKey={selectedDay}
      />
    )
  }

  if (by === 'method')
    return (
      <DataTable
        rows={d.byMethod}
        rowKey={(r) => r.method}
        cols={[
          { key: 'method', label: t('report.cols.method'), cell: (r) => payMethod(r.method, t) },
          {
            key: 'count',
            label: t('analytics.revenue.payments'),
            align: 'right',
            cell: (r) => num(r.count),
            sort: (r) => r.count,
            total: num(d.byMethod.reduce((s, x) => s + x.count, 0)),
          },
          {
            key: 'amount',
            label: t('analytics.amountRwf'),
            align: 'right',
            cell: (r) => money(r.amount),
            sort: (r) => r.amount,
            total: money(d.byMethod.reduce((s, x) => s + x.amount, 0)),
          },
          {
            key: 'share',
            label: t('analytics.share'),
            align: 'right',
            cell: (r) => `${r.share.toFixed(1)} %`,
          },
        ]}
        initialSort={{ key: 'amount', desc: true }}
        totalsLabel={t('report.total')}
        empty={empty}
        caption={t('analytics.revenue.by.method')}
      />
    )

  if (by === 'source') {
    const all = d.bySource.bills.amount + d.bySource.counterSales.amount
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat
          label={t('analytics.revenue.bills')}
          value={formatRwf(d.bySource.bills.amount)}
          note={t('analytics.revenue.sourceNote', {
            count: d.bySource.bills.count,
            share: pct(d.bySource.bills.amount, all),
          })}
        />
        <Stat
          label={t('analytics.revenue.counterSales')}
          value={formatRwf(d.bySource.counterSales.amount)}
          note={t('analytics.revenue.sourceNote', {
            count: d.bySource.counterSales.count,
            share: pct(d.bySource.counterSales.amount, all),
          })}
        />
      </div>
    )
  }

  if (by === 'service' || by === 'department') {
    const rows =
      by === 'service'
        ? d.byCategory.map((c) => ({
            key: c.id ?? c.group,
            name: c.name
              ? categoryName(
                  { nameEn: c.name, nameKin: c.nameKin, nameFr: c.nameFr },
                  i18n.language,
                )
              : t(`prices.groups.${c.group}`, { defaultValue: c.group }),
            charged: c.charged,
            collectedEst: c.collectedEst,
            lines: c.lines,
          }))
        : d.byDepartment.map((c) => ({
            key: c.id ?? c.key,
            name:
              c.key === 'pharmacy'
                ? t('analytics.revenue.pharmacy')
                : c.key === 'none' || !c.name
                  ? t('analytics.revenue.noDepartment')
                  : c.name,
            charged: c.charged,
            collectedEst: c.collectedEst,
            lines: c.lines,
          }))
    return (
      <>
        <DataTable
          rows={rows}
          rowKey={(r) => r.key}
          cols={[
            { key: 'name', label: t('report.cols.name'), cell: (r) => r.name, sort: (r) => r.name },
            {
              key: 'lines',
              label: t('analytics.revenue.lines'),
              align: 'right',
              wide: true,
              cell: (r) => num(r.lines),
              sort: (r) => r.lines,
              total: num(rows.reduce((s, x) => s + x.lines, 0)),
            },
            {
              key: 'charged',
              label: t('analytics.revenue.charged'),
              align: 'right',
              cell: (r) => money(r.charged),
              sort: (r) => r.charged,
              total: money(rows.reduce((s, x) => s + x.charged, 0)),
            },
            {
              key: 'collected',
              label: t('analytics.revenue.collectedEst'),
              align: 'right',
              cell: (r) => money(r.collectedEst),
              sort: (r) => r.collectedEst,
              total: money(rows.reduce((s, x) => s + x.collectedEst, 0)),
            },
          ]}
          initialSort={{ key: 'charged', desc: true }}
          totalsLabel={t('report.total')}
          empty={empty}
          caption={t(`analytics.revenue.by.${by}`)}
        />
        <Hint>{t('analytics.revenue.estimateNote')}</Hint>
      </>
    )
  }

  if (by === 'payer')
    return (
      <>
        {!FEATURES.insurance && <Hint>{t('analytics.revenue.allCash')}</Hint>}
        <DataTable
          rows={d.byPayer}
          rowKey={(r) => r.payerId ?? r.type}
          cols={[
            {
              key: 'name',
              label: t('analytics.revenue.payer'),
              cell: (r) => r.name ?? t('analytics.revenue.cashPatients'),
            },
            {
              key: 'bills',
              label: t('analytics.revenue.billsCount'),
              align: 'right',
              cell: (r) => num(r.bills),
              sort: (r) => r.bills,
            },
            ...(FEATURES.insurance
              ? [
                  {
                    key: 'patient',
                    label: t('analytics.revenue.patientShare'),
                    align: 'right' as const,
                    wide: true,
                    cell: (r: RevenueAnalysis['byPayer'][number]) => money(r.patientShare),
                  },
                  {
                    key: 'insurer',
                    label: t('analytics.revenue.insurerShare'),
                    align: 'right' as const,
                    wide: true,
                    cell: (r: RevenueAnalysis['byPayer'][number]) => money(r.insurerShare),
                  },
                ]
              : []),
            {
              key: 'paid',
              label: t('analytics.revenue.paid'),
              align: 'right',
              cell: (r) => money(r.paid),
              sort: (r) => r.paid,
            },
            {
              key: 'owed',
              label: t('analytics.revenue.owed'),
              align: 'right',
              cell: (r) => money(r.owed),
              sort: (r) => r.owed,
            },
          ]}
          empty={empty}
          caption={t('analytics.revenue.by.payer')}
        />
      </>
    )

  if (by === 'cashier')
    return (
      <DataTable
        rows={d.byCashier}
        rowKey={(r) => r.id}
        cols={[
          {
            key: 'name',
            label: t('report.cols.cashier'),
            cell: (r) => r.name,
            sort: (r) => r.name,
          },
          {
            key: 'payments',
            label: t('analytics.revenue.payments'),
            align: 'right',
            wide: true,
            cell: (r) => num(r.payments),
            sort: (r) => r.payments,
          },
          {
            key: 'amount',
            label: t('analytics.amountRwf'),
            align: 'right',
            cell: (r) => money(r.amount),
            sort: (r) => r.amount,
            total: money(d.byCashier.reduce((s, x) => s + x.amount, 0)),
          },
          {
            key: 'refunds',
            label: t('analytics.revenue.refunds'),
            align: 'right',
            wide: true,
            cell: (r) => money(r.refunds),
            sort: (r) => r.refunds,
          },
          {
            key: 'voided',
            label: t('analytics.revenue.voidedCount'),
            align: 'right',
            wide: true,
            cell: (r) => num(r.voided),
            sort: (r) => r.voided,
          },
          {
            key: 'variance',
            label: t('analytics.revenue.variance'),
            align: 'right',
            cell: (r) => (
              <span
                className={cn(r.variance != null && r.variance < 0 && 'text-red font-semibold')}
              >
                {r.variance == null ? '—' : money(r.variance)}
              </span>
            ),
            sort: (r) => r.variance,
          },
        ]}
        initialSort={{ key: 'amount', desc: true }}
        totalsLabel={t('report.total')}
        empty={empty}
        caption={t('analytics.revenue.by.cashier')}
      />
    )

  if (by === 'discounts')
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <Stat label={t('analytics.revenue.discountLines')} value={num(d.discounts.lines)} />
          <Stat
            label={t('analytics.revenue.discountAmount')}
            value={formatRwf(d.discounts.amount)}
          />
        </div>
        <DataTable
          rows={d.discounts.byReason}
          rowKey={(r) => r.reason ?? '—'}
          cols={[
            {
              key: 'reason',
              label: t('report.cols.reason'),
              cell: (r) => r.reason ?? t('analytics.noReason'),
            },
            {
              key: 'lines',
              label: t('analytics.revenue.lines'),
              align: 'right',
              cell: (r) => num(r.lines),
              sort: (r) => r.lines,
            },
            {
              key: 'amount',
              label: t('analytics.amountRwf'),
              align: 'right',
              cell: (r) => money(r.amount),
              sort: (r) => r.amount,
            },
          ]}
          initialSort={{ key: 'amount', desc: true }}
          empty={<Quiet>{t('analytics.revenue.noDiscounts')}</Quiet>}
          caption={t('analytics.revenue.by.discounts')}
        />
      </>
    )

  if (by === 'refunds') {
    const listCols = <
      R extends {
        at: string
        patient: string | null
        amount: number
        reason: string | null
        by: string | null
      },
    >(): Col<R>[] => [
      { key: 'at', label: t('report.cols.when'), cell: (r) => when(r.at), sort: (r) => r.at },
      { key: 'patient', label: t('analytics.patient'), cell: (r) => r.patient ?? '—' },
      {
        key: 'amount',
        label: t('analytics.amountRwf'),
        align: 'right',
        cell: (r) => money(r.amount),
        sort: (r) => r.amount,
      },
      { key: 'reason', label: t('report.cols.reason'), wide: true, cell: (r) => r.reason ?? '—' },
      { key: 'by', label: t('report.cols.by'), wide: true, cell: (r) => r.by ?? '—' },
    ]
    return (
      <div className="flex flex-col gap-4">
        <SubList title={t('analytics.revenue.refundsList')} count={d.refunds.length}>
          <DataTable
            rows={d.refunds}
            rowKey={(r) => r.id}
            cols={listCols<RevenueAnalysis['refunds'][number]>()}
            pageSize={10}
            empty={<Quiet>{t('analytics.revenue.noRefunds')}</Quiet>}
            caption={t('analytics.revenue.refundsList')}
          />
        </SubList>
        <SubList title={t('analytics.revenue.creditNotes')} count={d.creditNotes.length}>
          <DataTable
            rows={d.creditNotes}
            rowKey={(r) => r.id}
            cols={listCols<RevenueAnalysis['creditNotes'][number]>()}
            pageSize={10}
            empty={<Quiet>{t('analytics.revenue.noCreditNotes')}</Quiet>}
            caption={t('analytics.revenue.creditNotes')}
          />
        </SubList>
        <SubList title={t('analytics.revenue.voidedList')} count={d.voided.length}>
          <DataTable
            rows={d.voided}
            rowKey={(r) => r.id}
            cols={listCols<RevenueAnalysis['voided'][number]>()}
            pageSize={10}
            empty={<Quiet>{t('analytics.revenue.noVoided')}</Quiet>}
            caption={t('analytics.revenue.voidedList')}
          />
        </SubList>
        {T.creditNotes > 0 && (
          <Hint>{t('analytics.revenue.creditTotal', { amount: formatRwf(T.creditNotes) })}</Hint>
        )}
      </div>
    )
  }

  // debts: what is owed now (not a period figure)
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={t('analytics.revenue.owedOpen')}
          value={formatRwf(d.debts.openDue)}
          note={t('analytics.revenue.billsN', { count: d.debts.openCount })}
        />
        <Stat
          label={t('analytics.revenue.owedClosed')}
          value={formatRwf(d.debts.closedDue)}
          note={t('analytics.revenue.billsN', { count: d.debts.closedCount })}
          tone={d.debts.closedDue > 0 ? 'red' : undefined}
        />
      </div>
      <DataTable
        rows={d.debts.top}
        rowKey={(r) => r.invoiceId}
        cols={[
          {
            key: 'patient',
            label: t('analytics.patient'),
            cell: (r) =>
              r.encounterId ? (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: r.encounterId }}
                  className="text-primary font-semibold"
                >
                  {r.patient ?? '—'}
                </StaffLink>
              ) : (
                (r.patient ?? '—')
              ),
          },
          {
            key: 'file',
            label: t('report.cols.file'),
            wide: true,
            cell: (r) => r.fileNumber ?? '—',
          },
          {
            key: 'state',
            label: t('report.cols.status'),
            wide: true,
            cell: (r) =>
              r.open ? t('analytics.revenue.visitOpen') : t('analytics.revenue.visitClosed'),
          },
          {
            key: 'due',
            label: t('analytics.revenue.owed'),
            align: 'right',
            cell: (r) => money(r.due),
            sort: (r) => r.due,
          },
        ]}
        initialSort={{ key: 'due', desc: true }}
        empty={<Quiet>{t('analytics.revenue.noDebts')}</Quiet>}
        caption={t('analytics.revenue.by.debts')}
      />
      <StaffLink to="/app/bills" className={cn(buttonVariants({ size: 'sm' }), 'self-start')}>
        {t('analytics.revenue.openBills')} →
      </StaffLink>
    </>
  )
}

function SubList({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-ink m-0 text-[14px] font-semibold">
        {title} <span className="text-ink-2 font-normal">· {count}</span>
      </h4>
      {children}
    </section>
  )
}

/* ---------------------------------------------------------------- export */

function revenueReport(
  d: RevenueAnalysis,
  by: RevenueBy,
  t: TFn,
  lang: string,
  clinic: ViewProps['clinic'],
) {
  const T = d.totals
  const r0 = (v: number) => Math.round(v)
  const tables: ReportTable[] = [
    {
      title: t('analytics.revenue.by.days'),
      columns: [
        { label: t('report.cols.day'), kind: 'date' },
        { label: t('analytics.revenue.payments'), kind: 'number' },
        { label: payMethod('cash', t), kind: 'money' },
        { label: payMethod('momo', t), kind: 'money' },
        { label: payMethod('airtel', t), kind: 'money' },
        { label: t('analytics.revenue.otherMethod'), kind: 'money' },
        { label: t('analytics.revenue.refunds'), kind: 'money' },
        { label: t('analytics.revenue.voided'), kind: 'money' },
        { label: t('analytics.revenue.net'), kind: 'money' },
        { label: t('analytics.revenue.visitsPaid'), kind: 'number' },
      ],
      rows: d.days.map((x) => [
        x.day,
        x.payments,
        x.cash,
        x.momo,
        x.airtel,
        x.other,
        x.refunds,
        x.voided,
        x.net,
        x.visits,
      ]),
      totals: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
    {
      title: t('analytics.revenue.by.method'),
      columns: [
        { label: t('report.cols.method') },
        { label: t('analytics.revenue.payments'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: d.byMethod.map((x) => [payMethod(x.method, t), x.count, x.amount]),
      totals: [1, 2],
    },
  ]
  const name = (c: {
    name: string | null
    nameKin: string | null
    nameFr: string | null
    group: string
  }) =>
    c.name
      ? categoryName({ nameEn: c.name, nameKin: c.nameKin, nameFr: c.nameFr }, lang)
      : t(`prices.groups.${c.group}`, { defaultValue: c.group })
  const money3 = [
    { label: t('analytics.revenue.lines'), kind: 'number' as const },
    { label: t('analytics.revenue.charged'), kind: 'money' as const },
    { label: t('analytics.revenue.collectedEst'), kind: 'money' as const },
  ]
  const extra: Partial<Record<RevenueBy, ReportTable>> = {
    service: {
      title: t('analytics.revenue.by.service'),
      note: t('analytics.revenue.estimateNote'),
      columns: [{ label: t('report.cols.name') }, ...money3],
      rows: d.byCategory.map((c) => [name(c), c.lines, r0(c.charged), r0(c.collectedEst)]),
      totals: [1, 2, 3],
    },
    department: {
      title: t('analytics.revenue.by.department'),
      note: t('analytics.revenue.estimateNote'),
      columns: [{ label: t('report.cols.name') }, ...money3],
      rows: d.byDepartment.map((c) => [
        c.key === 'pharmacy'
          ? t('analytics.revenue.pharmacy')
          : (c.name ?? t('analytics.revenue.noDepartment')),
        c.lines,
        r0(c.charged),
        r0(c.collectedEst),
      ]),
      totals: [1, 2, 3],
    },
    payer: {
      title: t('analytics.revenue.by.payer'),
      columns: [
        { label: t('analytics.revenue.payer') },
        { label: t('analytics.revenue.billsCount'), kind: 'number' },
        { label: t('analytics.revenue.patientShare'), kind: 'money' },
        { label: t('analytics.revenue.insurerShare'), kind: 'money' },
        { label: t('analytics.revenue.paid'), kind: 'money' },
        { label: t('analytics.revenue.owed'), kind: 'money' },
      ],
      rows: d.byPayer.map((x) => [
        x.name ?? t('analytics.revenue.cashPatients'),
        x.bills,
        x.patientShare,
        x.insurerShare,
        x.paid,
        x.owed,
      ]),
      totals: [1, 2, 3, 4, 5],
    },
    cashier: {
      title: t('analytics.revenue.by.cashier'),
      columns: [
        { label: t('report.cols.cashier') },
        { label: t('analytics.revenue.payments'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
        { label: t('analytics.revenue.refunds'), kind: 'money' },
        { label: t('analytics.revenue.voidedCount'), kind: 'number' },
        { label: t('analytics.revenue.variance'), kind: 'money', boldNegative: true },
      ],
      rows: d.byCashier.map((x) => [x.name, x.payments, x.amount, x.refunds, x.voided, x.variance]),
      totals: [1, 2, 3, 4],
    },
    discounts: {
      title: t('analytics.revenue.by.discounts'),
      columns: [
        { label: t('report.cols.reason') },
        { label: t('analytics.revenue.lines'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: d.discounts.byReason.map((x) => [
        x.reason ?? t('analytics.noReason'),
        x.lines,
        x.amount,
      ]),
      totals: [1, 2],
    },
    refunds: {
      title: t('analytics.revenue.refundsList'),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: t('analytics.patient') },
        { label: t('report.cols.file'), under: true },
        { label: t('report.cols.amount'), kind: 'money' },
        { label: t('report.cols.reason') },
        { label: t('report.cols.by') },
      ],
      rows: d.refunds.map((x) => [x.at, x.patient, x.fileNumber, x.amount, x.reason, x.by]),
      totals: [3],
    },
    debts: {
      title: t('analytics.revenue.by.debts'),
      columns: [
        { label: t('analytics.patient') },
        { label: t('report.cols.file'), under: true },
        { label: t('report.cols.status') },
        { label: t('analytics.revenue.owed'), kind: 'money' },
      ],
      rows: d.debts.top.map((x) => [
        x.patient,
        x.fileNumber,
        x.open ? t('analytics.revenue.visitOpen') : t('analytics.revenue.visitClosed'),
        x.due,
      ]),
      totals: [3],
    },
  }
  const open = extra[by]
  if (open) tables.push(open)
  if (by === 'refunds') {
    tables.push({
      title: t('analytics.revenue.voidedList'),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: t('analytics.patient') },
        { label: t('report.cols.amount'), kind: 'money' },
        { label: t('report.cols.reason') },
        { label: t('report.cols.by') },
      ],
      rows: d.voided.map((x) => [x.at, x.patient, x.amount, x.reason, x.by]),
      totals: [2],
    })
  }
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.revenue.reportTitle'),
    code: 'REV',
    name: 'revenue',
    from: d.from,
    to: d.to,
    figures: [
      { label: t('analytics.revenue.collected'), value: T.collected, unit: 'RWF' },
      { label: t('analytics.revenue.refunded'), value: T.refunded, unit: 'RWF' },
      { label: t('analytics.revenue.net'), value: T.net, unit: 'RWF' },
      { label: t('analytics.revenue.payments'), value: T.payments },
      ...(T.avgPerVisit != null
        ? [
            {
              label: t('analytics.revenue.avgPerVisit'),
              value: Math.round(T.avgPerVisit),
              unit: 'RWF',
            },
          ]
        : []),
      { label: t('analytics.revenue.prevCollected'), value: d.prev.collected, unit: 'RWF' },
    ],
    summary: [
      t('analytics.revenue.summary', {
        collected: formatRwf(T.collected),
        refunded: formatRwf(T.refunded),
        net: formatRwf(T.net),
      }),
      T.voidedCount > 0
        ? t('analytics.revenue.voidedNote', { count: T.voidedCount, amount: formatRwf(T.voided) })
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    sections: [{ name: t('analytics.revenue.reportTitle'), tables }],
  })
}
