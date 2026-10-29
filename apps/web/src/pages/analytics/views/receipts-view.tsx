import { useId, useState } from 'react'
import { Banknote, Coins, Printer, ReceiptText, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatRwf } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { controlClass } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import { useReceiptsInPeriod, type ReceiptRow } from '@/lib/api/analytics-receipts'
import { useLetterhead } from '@/lib/report-parts'
import { receiptsReport } from '@/lib/reports/build'
import { openReceiptsBatch } from '@/lib/reports/receipts-print'
import { cn } from '@/lib/utils'
import { num, payMethod, when } from '../format'
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
import { pickBy, type ViewProps } from '../view-props'
import { tx } from '../words'

/** The payment methods the filter offers (`by=`); "all" is every method. */
const METHODS = ['all', 'cash', 'momo', 'airtel', 'card', 'bank'] as const
type MethodChoice = (typeof METHODS)[number]

/**
 * The receipts given in the period (0102): how many and for how much, by method and by cashier,
 * the list sorted by time, "Print all receipts" (one document, one receipt per page) and the
 * Excel / PDF export of the list. The cashier filter is in the address (`person=`), the method
 * in `by=`.
 */
export function ReceiptsView({ user, period, search, update, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const method = pickBy<MethodChoice>(search.by, METHODS, 'all')
  const cashier = search.person ?? null
  const q = useReceiptsInPeriod(p, {
    cashier,
    method: method === 'all' ? null : method,
  })
  const letterhead = useLetterhead()
  const [error, setError] = useState<string | null>(null)
  const cashierId = useId()
  const d = q.data

  useExport(() =>
    d && !d.needsUpdate
      ? receiptsReport(
          d,
          {
            cashier: d.cashiers.find((c) => c.id === cashier)?.name ?? null,
            method: method === 'all' ? null : method,
          },
          clinic ?? CLINIC_PROFILE,
          user,
          t,
        )
      : null,
  )

  if (q.error) return <LoadError error={q.error} />
  if (!d) return <ViewSkeleton />
  if (d.needsUpdate) return <NeedsUpdate />

  const printAll = () => {
    setError(null)
    const ok = openReceiptsBatch({
      rows: d.receipts,
      from: d.from || p.from,
      to: d.to || p.to,
      clinic: letterhead,
      printedBy: user.name,
      cashier: d.cashiers.find((c) => c.id === cashier)?.name ?? null,
      method: method === 'all' ? null : method,
    })
    if (!ok) setError(d.receipts.length ? t('report.popupBlocked') : t('analytics.noData'))
  }
  const methodOptions = METHODS.map((m) => ({
    value: m,
    label: m === 'all' ? tx(t, 'receipts.allMethods', 'All methods') : payMethod(m, t),
  }))
  const top = d.byMethod.slice(0, 3)

  const cols: Col<ReceiptRow>[] = [
    {
      key: 'no',
      label: t('report.cols.receiptNo'),
      cell: (r) =>
        r.encounterId ? (
          <StaffLink
            to="/app/visit"
            search={{ encounter: r.encounterId }}
            className="text-primary font-semibold whitespace-nowrap"
          >
            {r.receiptNo ?? '—'}
          </StaffLink>
        ) : (
          <b className="whitespace-nowrap">{r.receiptNo ?? '—'}</b>
        ),
      sort: (r) => r.receiptNo,
    },
    {
      key: 'at',
      label: t('report.cols.dateTime'),
      cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
      sort: (r) => r.at,
    },
    {
      key: 'patient',
      label: t('finance.cols.patient'),
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold [overflow-wrap:anywhere]">{r.patient.name}</span>
          {r.patient.fileNumber && (
            <span className="text-ink-3 block text-[12px]">{r.patient.fileNumber}</span>
          )}
        </span>
      ),
      sort: (r) => r.patient.name,
    },
    {
      key: 'bill',
      label: tx(t, 'receipts.cols.bill', 'Bill no.'),
      wide: true,
      cell: (r) => <span className="whitespace-nowrap">{r.invoiceNo ?? '—'}</span>,
      sort: (r) => r.invoiceNo,
    },
    {
      key: 'method',
      label: t('report.cols.method'),
      cell: (r) => (
        <span className="whitespace-nowrap">
          {payMethod(r.method, t)}
          {r.reference && <span className="text-ink-3 block text-[12px]">{r.reference}</span>}
        </span>
      ),
      sort: (r) => r.method,
    },
    {
      key: 'cashier',
      label: t('report.cols.cashier'),
      wide: true,
      cell: (r) => r.cashier ?? '—',
      sort: (r) => r.cashier,
    },
    {
      key: 'amount',
      label: t('report.cols.amount'),
      align: 'right',
      cell: (r) => <b>{num(r.amount)}</b>,
      sort: (r) => r.amount,
      total: num(d.total),
    },
    {
      key: 'balance',
      label: tx(t, 'receipts.cols.balance', 'Still due'),
      align: 'right',
      wide: true,
      cell: (r) => (r.balance > 0 ? <span className="text-red">{num(r.balance)}</span> : '0'),
      sort: (r) => r.balance,
    },
  ]

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={ReceiptText}
          tint="teal"
          label={tx(t, 'receipts.count', 'Receipts')}
          value={d.count}
          unit={period.label}
        />
        <Kpi
          i={1}
          icon={Coins}
          tint="violet"
          label={t('report.fig.collected')}
          value={d.total}
          unit="RWF"
        />
        {top.map((m, i) => (
          <Kpi
            key={m.method}
            i={2 + i}
            icon={Banknote}
            tint={(['mint', 'amber', 'coral'] as const)[i] ?? 'navy'}
            label={payMethod(m.method, t)}
            value={m.amount}
            unit={tx(t, 'receipts.nReceipts', '{{count}} receipts', { count: m.count })}
          />
        ))}
      </Figures>
      {d.scope === 'mine' && <Hint>{tx(t, 'receipts.mineNote', 'The receipts you gave.')}</Hint>}

      <Panel
        i={1}
        icon={ReceiptText}
        tint="teal"
        title={tx(t, 'receipts.title', 'Receipts')}
        right={`${num(d.count)} · ${formatRwf(d.total)}`}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Choice
            label={t('report.cols.method')}
            value={method}
            options={methodOptions}
            onChange={(v) => update({ by: v === 'all' ? undefined : v }, { replace: true })}
          />
          {d.cashiers.length > 1 && (
            <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1 sm:max-w-[280px]">
              <label htmlFor={cashierId} className="text-ink-2 text-[13px] font-medium">
                {t('report.cols.cashier')}
              </label>
              <select
                id={cashierId}
                value={cashier ?? ''}
                onChange={(e) => update({ person: e.target.value || undefined }, { replace: true })}
                className={cn(controlClass, 'w-full max-w-full')}
              >
                <option value="">{tx(t, 'receipts.allCashiers', 'All cashiers')}</option>
                {d.cashiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button variant="primary" onClick={printAll} disabled={d.receipts.length === 0}>
            <Printer size={16} aria-hidden="true" />
            {tx(t, 'receipts.printAll', 'Print all receipts')}
          </Button>
          {error && <span className="text-red text-[13px] font-semibold">{error}</span>}
        </div>
        <DataTable<ReceiptRow>
          rows={d.receipts}
          rowKey={(r) => r.id}
          cols={cols}
          initialSort={{ key: 'at', desc: false }}
          totalsLabel={t('report.total')}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={tx(t, 'receipts.title', 'Receipts')}
        />
      </Panel>

      {d.byCashier.length > 0 && (
        <Panel i={2} icon={Users} tint="navy" title={t('finance.byCashier')}>
          <DataTable
            rows={d.byCashier}
            rowKey={(r) => r.id ?? r.name}
            cols={[
              { key: 'name', label: t('report.cols.cashier'), cell: (r) => <b>{r.name}</b> },
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
              },
            ]}
            empty={<Quiet>{t('analytics.noData')}</Quiet>}
            caption={t('finance.byCashier')}
          />
        </Panel>
      )}
    </>
  )
}
