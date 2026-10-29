import { Link } from '@tanstack/react-router'
import { CalendarDays, Undo2, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { StaffLink } from '@/components/staff/staff-link'
import { buttonVariants } from '@/components/ui/button'
import { useCashierSummary, type CashPayment } from '@/lib/api/finance'
import { cn } from '@/lib/utils'
import { dayLong, num, payMethod, timeOf } from '../format'
import { Block, DataTable, Drawer, LoadError, Quiet, Stat, statGrid } from '../kit'

const sumOf = (r: Record<string, number> | undefined) =>
  Object.values(r ?? {}).reduce((s, v) => s + Number(v || 0), 0)

/**
 * One day of revenue (the side panel of the Revenue view, `day=`): the cashier's day summary of
 * that day (cashier_summary), which the manager may read. Mounted only with a day: without one
 * the hook would load today.
 */
export function RevenueDayDrawer({ day, onClose }: { day: string; onClose: () => void }) {
  const { t } = useTranslation()
  const q = useCashierSummary(day)
  const s = q.data
  // the payments route reads it loosely (no validateSearch): typed as a plain object
  const toDay: { range: 'custom'; from: string; to: string } = {
    range: 'custom',
    from: day,
    to: day,
  }
  return (
    <Drawer
      icon={CalendarDays}
      hue="mint"
      title={t('analytics.revenue.dayTitle', { day: dayLong(day) })}
      subtitle={
        s
          ? t('analytics.revenue.daySubtitle', { count: s.count, amount: formatRwf(s.total) })
          : null
      }
      onClose={onClose}
      actions={
        // the Payments page opens on this day (Custom, from = to = the day), not on today
        <Link
          to="/app/payments"
          search={toDay}
          className={cn(buttonVariants({ variant: 'tint-teal', size: 'sm' }))}
        >
          <Wallet size={16} aria-hidden="true" />
          {t('analytics.revenue.openPayments')}
        </Link>
      }
    >
      {q.error ? (
        <LoadError error={q.error} />
      ) : !s ? (
        <div className="skeleton h-[240px] rounded-md" aria-busy="true" />
      ) : (
        <>
          {s.todayOnly && <Quiet>{t('analytics.revenue.todayOnly')}</Quiet>}
          <div className={statGrid}>
            {s.byMethod.map((m) => (
              <Stat
                key={m.method}
                icon={Wallet}
                tint="mint"
                label={payMethod(m.method, t)}
                value={num(m.amount)}
                note={t('analytics.revenue.paymentsN', { count: m.count })}
              />
            ))}
            {(s.refunded ?? 0) > 0 && (
              <Stat
                icon={Undo2}
                label={t('analytics.revenue.refunded')}
                value={num(s.refunded ?? 0)}
                tone="red"
              />
            )}
          </div>

          <Block title={t('analytics.revenue.paymentsList')} right={num(s.payments.length)}>
            <DataTable<CashPayment>
              rows={s.payments}
              rowKey={(r) => r.id}
              pageSize={20}
              cols={[
                {
                  key: 'at',
                  label: t('report.cols.time'),
                  cell: (r) => timeOf(r.at),
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
                          className="text-primary font-semibold"
                        >
                          {r.patient}
                        </StaffLink>
                      ) : (
                        r.patient
                      )}
                      <span className="text-ink-3 block text-[12px]">
                        {r.counterSale
                          ? t('analytics.revenue.counterSale', { n: r.counterSale })
                          : (r.invoice ?? r.fileNumber ?? '')}
                        {' · '}
                        {payMethod(r.method, t)}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'cashier',
                  label: t('report.cols.cashier'),
                  wide: true,
                  cell: (r) => r.cashier ?? '—',
                },
                {
                  key: 'amount',
                  label: t('analytics.amountRwf'),
                  align: 'right',
                  cell: (r) => num(r.amount),
                  sort: (r) => r.amount,
                },
              ]}
              initialSort={{ key: 'at', desc: true }}
              empty={<Quiet>{t('analytics.revenue.noPayments')}</Quiet>}
              caption={t('analytics.revenue.paymentsList')}
            />
          </Block>

          {(s.voided?.length ?? 0) > 0 && (
            <Block title={t('analytics.revenue.voidedList')} right={num(s.voided!.length)}>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[14px]">
                {s.voided!.map((v) => (
                  <li key={v.id} className="border-grid border-b pb-1.5 last:border-b-0">
                    <span className="flex justify-between gap-2">
                      <span className="min-w-0 font-semibold">{v.patient}</span>
                      <span className="tabular-nums line-through">{num(v.amount)}</span>
                    </span>
                    <span className="text-ink-3 block text-[12px]">
                      {timeOf(v.at)} · {payMethod(v.method, t)} ·{' '}
                      {v.reason ?? t('analytics.noReason')}
                      {v.by ? ` · ${v.by}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {(s.refunds?.length ?? 0) > 0 && (
            <Block title={t('analytics.revenue.refundsList')} right={num(s.refunds!.length)}>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[14px]">
                {s.refunds!.map((r) => (
                  <li key={r.id} className="border-grid border-b pb-1.5 last:border-b-0">
                    <span className="flex justify-between gap-2">
                      <span className="min-w-0 font-semibold">{r.patient}</span>
                      <span className="text-red tabular-nums">−{num(r.amount)}</span>
                    </span>
                    <span className="text-ink-3 block text-[12px]">
                      {timeOf(r.at)} · {payMethod(r.method, t)} · {r.reason}
                      {r.cashier ? ` · ${r.cashier}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {s.byCashier.length > 0 && (
            <Block title={t('analytics.revenue.by.cashier')}>
              <ul className="m-0 flex list-none flex-col p-0 text-[14px]">
                {s.byCashier.map((c) => (
                  <li
                    key={c.name}
                    className="border-grid flex justify-between gap-2 border-b py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0">
                      {c.name}{' '}
                      <span className="text-ink-3 text-[12px]">
                        · {t('analytics.revenue.paymentsN', { count: c.count })}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">{num(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          <Block title={t('report.cash.title')}>
            {(s.closes?.length ?? 0) === 0 ? (
              <Quiet>{t('analytics.revenue.noClose')}</Quiet>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0 text-[14px]">
                {s.closes!.map((c, i) => (
                  <li
                    key={`${c.cashier}-${i}`}
                    className="border-grid flex flex-wrap justify-between gap-x-3 gap-y-0.5 border-b py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 font-semibold">{c.cashier ?? '—'}</span>
                    <span className="text-ink-2 tabular-nums">
                      {t('report.cash.expected')} {num(sumOf(c.expected))} ·{' '}
                      {t('report.cash.counted')} {num(sumOf(c.counted))} ·{' '}
                      <b
                        className={cn(
                          c.variance < 0 ? 'text-red' : c.variance > 0 ? 'text-green' : '',
                        )}
                      >
                        {c.variance > 0 ? '+' : ''}
                        {num(c.variance)}
                      </b>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </>
      )}
    </Drawer>
  )
}
