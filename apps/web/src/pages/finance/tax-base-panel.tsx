import { useState } from 'react'
import { Calculator } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableRow } from '@/components/dash/kit-style'
import { Field } from '@/components/ui/field'
import { TAX_KINDS, type Tax, type TaxKind, type TaxOverview } from '@/lib/api/accounts'
import { cn } from '@/lib/utils'

/**
 * The tax base of the year (0187): what the system knows — the money in, the expenses, the
 * result before tax — and, on the right, the taxes in their groups so every figure can be
 * traced: the income tax (estimated at the rate typed, less the credits withheld at source and
 * what was paid on the taxes of kind "on the profit"), then the other taxes paid by kind with
 * their totals, then the grand total and the result after taxes paid. Information for the
 * accountant, who types the declared amount on the tax itself; nothing here is booked.
 */
export function TaxBasePanel({ i, o }: { i: number; o: TaxOverview }) {
  const { t } = useTranslation()
  const [rate, setRate] = useState('28')
  const b = o.base
  const r = Number(rate) || 0
  const estimate = Math.max(0, Math.round((b.resultBeforeTax * r) / 100))
  const byKind = (k: TaxKind): Tax[] => o.taxes.filter((x) => x.kind === k && x.paidThisYear > 0)
  const paidOf = (list: Tax[]) => list.reduce((s, x) => s + x.paidThisYear, 0)
  const withheldTaxes = byKind('withheld')
  const profitTaxes = byKind('profit')
  const withheld = paidOf(withheldTaxes)
  const paidOnProfit = paidOf(profitTaxes)
  const stillToPay = Math.max(0, estimate - withheld - paidOnProfit)
  // the other kinds, with their taxes; the one-off taxes recorded on the expenses tab are the
  // rest of the taxes paid (every expense of the kind Taxes) once the periods are taken out
  const otherKinds = TAX_KINDS.filter((k) => k !== 'profit' && k !== 'withheld')
  const periodsPaid = o.taxes
    .filter((x) => x.kind !== 'withheld')
    .reduce((s, x) => s + x.paidThisYear, 0)
  const oneOff = Math.max(0, b.taxesPaid - periodsPaid)
  const otherTotal = otherKinds.reduce((s, k) => s + paidOf(byKind(k)), 0) + oneOff
  const kindWord = (k: TaxKind) => t(`accounts.taxes.kinds.${k}`)

  const line = (
    label: string,
    value: number,
    opts: { strong?: boolean; tone?: string; sub?: boolean; key?: string } = {},
  ) => (
    <tr key={opts.key ?? label} className={tableRow}>
      <td
        className={cn(
          tableFirstCell,
          opts.strong && 'font-semibold',
          opts.sub && 'text-ink-2 pl-6',
        )}
      >
        {label}
      </td>
      <td
        className={cn(
          tableCell,
          'text-right tabular-nums',
          opts.strong && 'font-semibold',
          opts.sub && 'text-ink-2',
          opts.tone,
        )}
      >
        {formatRwf(Math.round(value))}
      </td>
    </tr>
  )
  const heading = (label: string) => (
    <tr key={`h-${label}`}>
      <td
        colSpan={2}
        className="text-violet pt-3 pb-1 text-[11px] font-semibold tracking-wide uppercase"
      >
        {label}
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
          <table className="w-full border-collapse self-start text-[14px]">
            <tbody>
              {line(t('accounts.money.revenue'), b.netRevenue)}
              {line(t('accounts.money.otherIncome'), b.otherIncome)}
              {line(t('accounts.taxBase.moneyIn'), b.moneyIn, { strong: true })}
              {line(t('accounts.money.staffCost'), b.salaries + b.statutory + b.remittances)}
              {line(t('accounts.money.other'), b.otherExpenses)}
              {line(t('accounts.money.stock'), b.stockBought)}
              {line(t('accounts.taxBase.expenses'), b.expenses, { strong: true })}
              {line(t('accounts.money.net'), b.resultBeforeTax, {
                strong: true,
                tone: b.resultBeforeTax >= 0 ? 'text-green' : 'text-red',
              })}
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
                {heading(t('accounts.taxBase.incomeTax'))}
                {line(t('accounts.taxBase.estimate', { rate: r }), estimate, { strong: true })}
                {line(t('accounts.taxBase.withheld'), withheld)}
                {withheldTaxes.map((x) =>
                  line(x.name, x.paidThisYear, { sub: true, key: `w-${x.id}` }),
                )}
                {line(t('accounts.taxBase.paidOnProfit'), paidOnProfit)}
                {profitTaxes.map((x) =>
                  line(x.name, x.paidThisYear, { sub: true, key: `p-${x.id}` }),
                )}
                {profitTaxes.length === 0 && (
                  <tr key="p-none">
                    <td colSpan={2} className="text-ink-3 pb-2 pl-6 text-[12px]">
                      {t('accounts.taxBase.noneOnProfit')}
                    </td>
                  </tr>
                )}
                {line(t('accounts.taxBase.stillToPay'), stillToPay, {
                  strong: true,
                  tone: 'text-amber',
                })}

                {heading(t('accounts.taxBase.otherTaxes'))}
                {otherKinds.flatMap((k) => {
                  const list = byKind(k)
                  if (list.length === 0) return []
                  return [
                    line(kindWord(k), paidOf(list), { key: `k-${k}` }),
                    ...list.map((x) =>
                      line(x.name, x.paidThisYear, { sub: true, key: `t-${x.id}` }),
                    ),
                  ]
                })}
                {oneOff > 0 && line(t('accounts.taxBase.oneOff'), oneOff, { key: 'one-off' })}
                {otherTotal === 0 && (
                  <tr key="o-none">
                    <td colSpan={2} className="text-ink-3 pb-2 pl-6 text-[12px]">
                      {t('accounts.taxBase.noneOther')}
                    </td>
                  </tr>
                )}
                {line(t('accounts.taxBase.otherTotal'), otherTotal, { strong: true })}

                {heading(t('accounts.taxBase.allTaxes'))}
                {line(t('accounts.taxBase.incomeTaxPaid'), paidOnProfit, { sub: true })}
                {line(t('accounts.taxBase.otherTotal'), otherTotal, { sub: true })}
                {line(t('accounts.taxBase.taxesPaid'), b.taxesPaid, { strong: true })}
                {line(t('accounts.money.afterTax'), b.resultBeforeTax - b.taxesPaid, {
                  strong: true,
                  tone: b.resultBeforeTax - b.taxesPaid >= 0 ? 'text-green' : 'text-red',
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.hint')}</p>
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.kindRule')}</p>
      </div>
    </Panel>
  )
}
