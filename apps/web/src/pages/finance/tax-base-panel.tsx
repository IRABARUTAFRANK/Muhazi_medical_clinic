import { useState } from 'react'
import { Calculator } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableRow } from '@/components/dash/kit-style'
import { Field } from '@/components/ui/field'
import { TAX_KINDS, type TaxOverview } from '@/lib/api/accounts'
import { cn } from '@/lib/utils'

/**
 * The tax base of the year (0187): what the system knows — the money in, the expenses, the
 * result before tax — then the taxes paid by kind, what was withheld at source, and an estimate
 * of the income tax at the rate typed (28% in Rwanda). Information for the accountant, who
 * types the declared amount on the tax itself; nothing here is booked.
 */
export function TaxBasePanel({ i, o }: { i: number; o: TaxOverview }) {
  const { t } = useTranslation()
  const [rate, setRate] = useState('28')
  const b = o.base
  const r = Number(rate) || 0
  const estimate = Math.max(0, Math.round((b.resultBeforeTax * r) / 100))
  const withheld = b.paidByKind.withheld ?? 0
  const paidOnProfit = b.paidByKind.profit ?? 0
  const line = (label: string, value: number, strong = false, tone?: string) => (
    <tr className={tableRow}>
      <td className={cn(tableFirstCell, strong && 'font-semibold')}>{label}</td>
      <td className={cn(tableCell, 'text-right tabular-nums', strong && 'font-semibold', tone)}>
        {formatRwf(Math.round(value))}
      </td>
    </tr>
  )
  return (
    <Panel
      i={i}
      icon={Calculator}
      tint="violet"
      title={t('accounts.taxBase.title', { year: o.year })}
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.lead')}</p>
        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          <table className="w-full border-collapse text-[14px]">
            <tbody>
              {line(t('accounts.money.revenue'), b.netRevenue)}
              {line(t('accounts.money.otherIncome'), b.otherIncome)}
              {line(t('accounts.taxBase.moneyIn'), b.moneyIn, true)}
              {line(t('accounts.money.staffCost'), b.salaries + b.statutory + b.remittances)}
              {line(t('accounts.money.other'), b.otherExpenses)}
              {line(t('accounts.money.stock'), b.stockBought)}
              {line(t('accounts.taxBase.expenses'), b.expenses, true)}
              {line(
                t('accounts.money.net'),
                b.resultBeforeTax,
                true,
                b.resultBeforeTax >= 0 ? 'text-green' : 'text-red',
              )}
            </tbody>
          </table>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field
                wrapperClassName="w-28"
                label={t('accounts.taxBase.rate')}
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
              />
              <p className="text-ink-3 m-0 pb-2 text-[13px]">{t('accounts.taxBase.rateHint')}</p>
            </div>
            <table className="w-full border-collapse text-[14px]">
              <tbody>
                {line(t('accounts.taxBase.estimate', { rate: r }), estimate, true)}
                {line(t('accounts.taxBase.withheld'), withheld)}
                {line(t('accounts.taxBase.paidOnProfit'), paidOnProfit)}
                {line(
                  t('accounts.taxBase.stillToPay'),
                  Math.max(0, estimate - withheld - paidOnProfit),
                  true,
                  'text-amber',
                )}
                {TAX_KINDS.filter((k) => k !== 'withheld' && k !== 'profit').map((k) =>
                  b.paidByKind[k]
                    ? line(
                        t('accounts.taxBase.paidKind', { kind: t(`accounts.taxes.kinds.${k}`) }),
                        b.paidByKind[k] ?? 0,
                      )
                    : null,
                )}
                {line(t('accounts.taxBase.taxesPaid'), b.taxesPaid, true)}
                {line(
                  t('accounts.money.afterTax'),
                  b.resultBeforeTax - b.taxesPaid,
                  true,
                  b.resultBeforeTax - b.taxesPaid >= 0 ? 'text-green' : 'text-red',
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.hint')}</p>
      </div>
    </Panel>
  )
}
